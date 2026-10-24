import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** 256-bit random secret, URL-safe. Used for session ids and magic-link tokens. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored in the DB (auth_sessions.token_hash, magic_links.token_hash). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Tokens we hand out are 43 base64url chars; anything else is rejected before touching the DB. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

const emailSchema = z.email().max(254);

/** Lower-cased, trimmed e-mail, or null when invalid (users.email is stored lower-case). */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return emailSchema.safeParse(email).success ? email : null;
}

function mac(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

/** `base64url(json).base64url(hmac)` with an `exp` (ms epoch) — for short-lived signed cookies. */
export function signPayload(payload: object, secret: string, ttlMs: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs })).toString('base64url');
  return `${body}.${mac(body, secret).toString('base64url')}`;
}

/** The payload when the signature is valid and not expired, else null. */
export function verifyPayload<T extends object>(value: string | undefined, secret: string, now = Date.now()): T | null {
  if (!value) return null;
  const [body, sig, extra] = value.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = mac(body, secret);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: unknown };
    if (typeof data.exp !== 'number' || data.exp <= now) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * A same-site relative path to continue to after login, or null. Rejects absolute and
 * protocol-relative URLs (`//evil`, `/\evil`) and control characters, so `next` is never an open redirect.
 */
export function safeNext(next: unknown): string | null {
  if (typeof next !== 'string' || next.length === 0 || next.length > 512) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return null;
  const base = 'http://ai-obs.invalid';
  try {
    const url = new URL(next, base);
    if (url.origin !== base) return null;
    if (/^\/(api\/auth|login|logout|welcome)(\/|$)/.test(url.pathname)) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
