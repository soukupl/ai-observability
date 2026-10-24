import { sql } from 'drizzle-orm';
import { auditLog, type Tx } from '@ai-obs/db';
import { RateLimiter } from './rate-limit';

/**
 * The `/device` approval page of device login (ADR-0029 T4, brief Appendix B). The CLI shows an 8-letter code
 * (`XXXX-XXXX`, letters of USER_CODE_ALPHABET); the signed-in person types it here, sees the client name, requester IP
 * and age, and approves or denies. Approval only marks the code (device_approve); the polling CLI then mints its
 * 90-day token through device_exchange, which writes the `token.create` audit row.
 */
export const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const USER_CODE_RE = new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`);

/** Pure: the 8 letters of a typed code (`abcd-efgh`, `ABCDEFGH`, spaces allowed), or null when it cannot be one. */
export function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return USER_CODE_RE.test(code) ? code : null;
}

/** Pure: `ABCDEFGH` → `ABCD-EFGH`. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Pure: "just now", "3 minutes ago", "1 hour ago" for the requester's age. */
export function ageText(createdMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - createdMs) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

export interface PendingDeviceLogin {
  id: string;
  code: string;
  clientName: string;
  clientVersion: string | null;
  requesterIp: string | null;
  createdMs: number;
  expiresMs: number;
}

type RawLookup = {
  id: string;
  client_name: string;
  client_version: string | null;
  requester_ip: string | null;
  created_at: Date | string;
  expires_at: Date | string;
};

const g = globalThis as typeof globalThis & { __aiObsDeviceMisses?: RateLimiter };
/**
 * Wrong codes per signed-in user: 20 per 15 minutes (codes are 24^8 and live 10 minutes). Every code-keyed step (look
 * up, approve, deny) runs through withMissBudget, so once the budget is spent even a correct code is refused.
 */
export const deviceMissLimiter = (g.__aiObsDeviceMisses ??= new RateLimiter(20, 15 * 60_000));

export type DeviceAttempt<T> = { status: 'ok'; value: T } | { status: 'miss' } | { status: 'limited' };

/**
 * Runs one code-keyed attempt under the user's miss budget: refused ('limited') before it runs when the budget is
 * spent, and a miss is counted when it finds nothing (null or false).
 */
export async function withMissBudget<T>(
  limiter: RateLimiter,
  userId: string,
  attempt: () => Promise<T | null | false>,
): Promise<DeviceAttempt<T>> {
  if (limiter.exhausted(userId)) return { status: 'limited' };
  const value = await attempt();
  if (value !== null && value !== false) return { status: 'ok', value };
  return limiter.hit(userId) ? { status: 'miss' } : { status: 'limited' };
}

/** What the `/device` form shows: the code entry (with an outcome message), or the login request to confirm. */
export type DeviceState =
  | { step: 'enter'; tone?: 'ok' | 'error'; message?: string; typed?: string }
  | {
      step: 'confirm';
      code: string;
      clientName: string;
      clientVersion: string | null;
      requesterIp: string | null;
      age: string;
    };

export const DEVICE_MESSAGES = {
  badFormat: 'A code is 8 letters, shown by `ai-obs login` as XXXX-XXXX.',
  notFound: 'No open login request has that code. Check the code in your terminal; codes expire after 10 minutes.',
  limited: 'Too many wrong codes. Wait a few minutes and try again.',
  approved: 'Approved. Go back to your terminal: the collector picks up its token within a few seconds.',
  denied: 'Denied. The collector that asked will stop waiting.',
  gone: 'That code is no longer open: it expired (codes live 10 minutes), was used or was denied. Run `ai-obs login` again.',
} as const;

/** The open (pending, unexpired) login request for a code, under the user's RLS context; null when there is none. */
export async function lookupDeviceLogin(tx: Tx, code: string): Promise<PendingDeviceLogin | null> {
  const rows = (await tx.execute(sql`select * from device_lookup(${code})`)) as unknown as RawLookup[];
  const r = rows[0];
  return r
    ? {
        id: r.id,
        code,
        clientName: r.client_name,
        clientVersion: r.client_version,
        requesterIp: r.requester_ip,
        createdMs: new Date(r.created_at).getTime(),
        expiresMs: new Date(r.expires_at).getTime(),
      }
    : null;
}

/** Approves the code for the signed-in person (device_approve); audited as `device.approve`. False when it is no longer open. */
export async function approveDeviceLogin(tx: Tx, userId: string, code: string): Promise<boolean> {
  const rows = (await tx.execute(sql`select * from device_approve(${code})`)) as unknown as Array<{ id: string; client_name: string; requester_ip: string | null }>;
  const r = rows[0];
  if (!r) return false;
  await tx.insert(auditLog).values({
    actorUserId: userId,
    action: 'device.approve',
    target: `device_code:${r.id}`,
    meta: { client_name: r.client_name, requester_ip: r.requester_ip },
  });
  return true;
}

/** Denies the code (device_deny); audited as `device.deny`. False when it is no longer open. */
export async function denyDeviceLogin(tx: Tx, userId: string, code: string): Promise<boolean> {
  const rows = (await tx.execute(sql`select device_deny(${code}) as ok`)) as unknown as Array<{ ok: boolean }>;
  if (rows[0]?.ok !== true) return false;
  await tx.insert(auditLog).values({ actorUserId: userId, action: 'device.deny', target: null, meta: {} });
  return true;
}
