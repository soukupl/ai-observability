import { sql } from 'drizzle-orm';
import { auditLog, type Tx } from '@ai-obs/db';
import type { Actor } from './types';

/** Appends one audit_log row in the actor's name (RLS: anyone may append their own entries). */
export async function audit(tx: Tx, actor: Pick<Actor, 'id'>, action: string, target: string | null, meta: Record<string, unknown> = {}): Promise<void> {
  await tx.insert(auditLog).values({ actorUserId: actor.id, action, target, meta });
}

export interface AuditRow {
  id: string;
  atMs: number;
  actor: string;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
}

/** Newest first. RLS: only admins can read the log. */
export async function listAuditLog(tx: Tx, opts: { page: number; pageSize: number; limit?: number }): Promise<{ rows: AuditRow[]; total: number }> {
  const size = opts.limit ?? opts.pageSize;
  const offset = opts.limit ? 0 : Math.max(0, opts.page - 1) * opts.pageSize;
  const list = (await tx.execute(sql`
    select a.id, a.at, a.action, a.target, a.meta, u.name as actor_name, u.email as actor_email
    from audit_log a left join users u on u.id = a.actor_user_id
    order by a.at desc, a.id desc limit ${size} offset ${offset}`)) as unknown as {
    id: string; at: Date | string; action: string; target: string | null; meta: Record<string, unknown> | null; actor_name: string | null; actor_email: string | null;
  }[];
  const [count] = (await tx.execute(sql`select count(*)::int as n from audit_log`)) as unknown as { n: number }[];
  return {
    total: Number(count?.n ?? 0),
    rows: Array.from(list).map((r) => ({
      id: r.id,
      atMs: new Date(r.at).getTime(),
      actor: r.actor_name || r.actor_email || 'system / removed user',
      action: r.action,
      target: r.target,
      meta: r.meta ?? {},
    })),
  };
}

/** "key=value, key=value" (nested values as JSON), cut to `max` characters. */
export function metaSummary(meta: Record<string, unknown>, max = 120): string {
  const s = Object.entries(meta)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const AUDIT_EXPORT_LIMIT = 10_000;

export function auditCsv(rows: AuditRow[]): { headers: string[]; rows: (string | null)[][] } {
  return {
    headers: ['at', 'actor', 'action', 'target', 'meta'],
    rows: rows.map((r) => [new Date(r.atMs).toISOString(), r.actor, r.action, r.target, JSON.stringify(r.meta)]),
  };
}
