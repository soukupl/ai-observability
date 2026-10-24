import { randomBytes, randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '@ai-obs/db';
import { rows } from './context';
import {
  AuthGuard,
  authGuardOptionsFromEnv,
  clientIp,
  TokenBucketLimiter,
  trustedProxyHopsFromEnv,
  type RateLimitOptions,
} from './rate-limit';
import { generateToken, hashToken } from './tokens';

/*
 * Device login (ADR-0029, brief Appendix B), modelled on spoor-memory: the CLI asks for a code
 * (`POST /api/v1/device/code`), the user approves it on the dashboard's `/device` page, and the CLI polls
 * `POST /api/v1/device/token` until the approval mints its token. Both routes are public. Only hashes of the device code
 * and the token reach the database (device_create_code / device_exchange, SECURITY DEFINER); neither the codes nor the
 * token are ever logged.
 */

/** Seconds a device code stays valid. */
export const DEVICE_CODE_TTL_SECONDS = 600;
/** Seconds the CLI waits between polls; polling faster answers `slow_down`. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** Open (pending or approved) codes allowed server-wide; beyond it `POST /device/code` answers 429. */
export const DEVICE_MAX_OPEN_CODES = 100;
/** User-code alphabet: no I or O (they read as 1 and 0). */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** Per-IP limit of `POST /device/code`: burst 10, 5 per minute. */
export const DEVICE_CODE_RATE_LIMIT: RateLimitOptions = { burst: 10, perMinute: 5 };
/** Largest JSON body either device route reads. */
export const DEVICE_MAX_BODY_BYTES = 4096;

const NO_STORE = { 'cache-control': 'no-store' };

/** 43 characters of base64url (256 bit): what the CLI holds and polls with. */
export function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

/** 8 letters of USER_CODE_ALPHABET, shown as `XXXX-XXXX`. */
export function generateUserCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4, 8)}`;

export interface DeviceDeps {
  db: Database;
  /** `POST /device/code`: per client IP (DEVICE_CODE_RATE_LIMIT). */
  codeLimiter?: TokenBucketLimiter;
  /** `POST /device/token`: miss limiter: unknown device codes spend a per-IP budget and are cached as bad. */
  tokenGuard?: AuthGuard;
  env?: NodeJS.ProcessEnv;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

const oauthError = (error: string, status = 400, headers: Record<string, string> = {}) => json(status, { error }, headers);

/** Reads a small JSON object body; null for anything else (too large, not JSON, not an object). */
async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > DEVICE_MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (Buffer.byteLength(text, 'utf8') > DEVICE_MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Printable text without control characters, trimmed, at most `max` characters; null when empty or not a string. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return text || null;
}

function verificationUri(env: NodeJS.ProcessEnv): string {
  const base = new URL(env.APP_URL || 'http://localhost:3000');
  return new URL('/device', base).toString();
}

/**
 * `POST /api/v1/device/code` `{ client_name, client_version }` → `200 { device_code, user_code, verification_uri,
 * expires_in, interval }`. 429 when the client IP is over its limit or DEVICE_MAX_OPEN_CODES codes are open; 400 on a
 * bad body.
 */
export async function handleDeviceCode(request: Request, deps: DeviceDeps): Promise<Response> {
  const env = deps.env ?? process.env;
  const ip = clientIp(request.headers, trustedProxyHopsFromEnv(env));
  const limiter = deps.codeLimiter ?? deviceCodeLimiter();
  const limit = limiter.take(ip);
  if (!limit.ok) return oauthError('rate_limited', 429, { 'retry-after': String(limit.retryAfterSec) });

  const body = await readJsonObject(request);
  const clientName = cleanText(body?.client_name, 100);
  if (!body || !clientName) return oauthError('invalid_request');
  const clientVersion = cleanText(body.client_version, 32);

  const deviceCode = generateDeviceCode();
  // A user code may clash with an open one (23505): draw again, a few times.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await rows<{ id: string; user_code: string; expires_at: Date | string }>(
        deps.db,
        sql`select id, user_code, expires_at from device_create_code(${hashToken(deviceCode)}, ${generateUserCode()},
          ${clientName}, ${clientVersion}, ${ip === 'unknown' ? null : ip.slice(0, 64)},
          ${DEVICE_CODE_TTL_SECONDS}, ${DEVICE_MAX_OPEN_CODES})`,
      );
      if (!row) return oauthError('too_many_open_codes', 429, { 'retry-after': '60' });
      return json(200, {
        device_code: deviceCode,
        user_code: formatUserCode(row.user_code),
        verification_uri: verificationUri(env),
        expires_in: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      });
    } catch (err) {
      if (uniqueViolation(err)) continue;
      throw err;
    }
  }
  return oauthError('temporarily_unavailable', 503);
}

function uniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

type ExchangeStatus = 'ok' | 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'invalid_grant';

/**
 * `POST /api/v1/device/token` `{ grant_type, device_code }` → `200 { token, expires_at, label }` once the code is
 * approved, else `400 { error }` with device_exchange's status (`authorization_pending`, `slow_down`, `access_denied`,
 * `expired_token`, `invalid_grant`). A code is exchanged at most once. Unknown codes spend the client IP's miss budget
 * (429 beyond it) and are answered without a lookup for a short while.
 */
export async function handleDeviceToken(request: Request, deps: DeviceDeps): Promise<Response> {
  const env = deps.env ?? process.env;
  const body = await readJsonObject(request);
  if (!body) return oauthError('invalid_request');
  if (body.grant_type !== DEVICE_GRANT_TYPE) return oauthError('unsupported_grant_type');
  const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(deviceCode)) return oauthError('invalid_grant');

  const codeHash = hashToken(deviceCode);
  const guard = deps.tokenGuard ?? deviceTokenGuard();
  const ip = clientIp(request.headers, trustedProxyHopsFromEnv(env));
  const admitted = guard.admit(ip, codeHash);
  if (admitted.action === 'reject-401') return oauthError('invalid_grant');
  if (admitted.action === 'reject-429') {
    return oauthError('slow_down', 429, { 'retry-after': String(admitted.retryAfterSec) });
  }

  // The token is generated here and only its hash and prefix go to the database; the plaintext is returned once.
  const token = generateToken('user');
  const [row] = await rows<{ status: ExchangeStatus; expires_at: Date | string | null; label: string | null }>(
    deps.db,
    sql`select status, expires_at, label from device_exchange(${codeHash}, ${token.hash}, ${token.prefix},
      ${DEVICE_POLL_INTERVAL_SECONDS})`,
  );
  const status: ExchangeStatus = row?.status ?? 'invalid_grant';
  if (status === 'invalid_grant') guard.failed(ip, codeHash);
  else guard.succeeded(codeHash);
  if (status !== 'ok') return oauthError(status);
  const expiresAt = row!.expires_at instanceof Date ? row!.expires_at : new Date(row!.expires_at!);
  return json(200, { token: token.plaintext, expires_at: expiresAt.toISOString(), label: row!.label });
}

let sharedCodeLimiter: TokenBucketLimiter | undefined;
let sharedTokenGuard: AuthGuard | undefined;

/** Process-wide per-IP limiter of `POST /device/code` (per instance, like the ingest limits). */
export function deviceCodeLimiter(): TokenBucketLimiter {
  sharedCodeLimiter ??= new TokenBucketLimiter(DEVICE_CODE_RATE_LIMIT);
  return sharedCodeLimiter;
}

/** Process-wide miss limiter of `POST /device/token` (INGEST_FAILED_AUTH_* budget per client IP). */
export function deviceTokenGuard(): AuthGuard {
  sharedTokenGuard ??= new AuthGuard(authGuardOptionsFromEnv());
  return sharedTokenGuard;
}
