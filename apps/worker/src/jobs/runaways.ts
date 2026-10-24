import { RUNAWAY_DEFAULTS } from '@ai-obs/db';
import { sql } from 'drizzle-orm';
import type { WorkerContext } from '../context.js';
import { loadDeployment } from '../lib/deployment.js';
import { runawayReasons, type RunawayReason } from '../runaways/decide.js';
import { buildRunawayEmail, type RunawayMailItem } from '../runaways/mail.js';
import type { Job } from '../scheduler.js';

/*
 * Runaway detection after a turn ended (docs/briefs/runaway-alerts.md, ADR-0018). Every pass looks at turns
 * written since the last pass (watermark, like rollups), started within the last week, without an alert yet;
 * flags them by the rules in runaways/decide.ts (thresholds from deployment.settings); and mails at most one digest
 * per hour. Alerts only notify; nothing is blocked.
 */

const WATERMARK_KEY = 'runaways.watermark';
const OVERLAP_MS = 10 * 60_000;
/** Cold start (no watermark): only turns written in the last day, so a deploy does not flag old history. */
const COLD_LOOKBACK_MS = 24 * 3_600_000;
const MAX_TURN_AGE_MS = 7 * 24 * 3_600_000;
export const DIGEST_INTERVAL_MS = 60 * 60_000;

const rows = <T>(r: unknown): T[] => r as T[];

interface Candidate {
  id: string;
  teamId: string | null;
  userId: string | null;
  projectId: string | null;
  harness: string;
  model: string | null;
  startedAt: Date;
  durationMs: number;
  /** all tokens, cache reads included: what the alert shows */
  tokens: number;
  /** input + output + cache writes: what the rules compare (cache reads excluded) */
  ruleTokens: number;
  costUsd: number | null;
  history: number;
  p95: number | null;
  p99: number | null;
}

export async function detectRunaways(ctx: WorkerContext): Promise<number> {
  const startedAt = ctx.now();
  const watermark = ctx.state.get(WATERMARK_KEY);
  const since = watermark ? new Date(Date.parse(watermark) - OVERLAP_MS) : new Date(startedAt.getTime() - COLD_LOOKBACK_MS);
  const oldest = new Date(startedAt.getTime() - MAX_TURN_AGE_MS);
  const { settings } = await loadDeployment(ctx.db);
  const thresholds = {
    costUsd: settings.runawayCostUsd ?? RUNAWAY_DEFAULTS.costUsd,
    hours: settings.runawayHours ?? RUNAWAY_DEFAULTS.hours,
  };
  const candidates = rows<Candidate>(
    await ctx.db.execute(sql`
      select t.id, t.team_id as "teamId", t.user_id as "userId", t.project_id as "projectId",
        t.harness, t.model, t.started_at as "startedAt", t.duration_ms::float8 as "durationMs",
        (t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens)::float8 as tokens,
        (t.input_tokens + t.output_tokens + t.cache_write_tokens)::float8 as "ruleTokens",
        cost.usd::float8 as "costUsd", coalesce(h.n, 0)::int as history, h.p95::float8 as p95, h.p99::float8 as p99
      from turns t
      left join lateral (
        select case when bool_or(e.usd is null and u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens > 0)
                    then null else coalesce(sum(e.usd), 0) end as usd
        from usage u
        cross join lateral (select estimate_cost_usd(u.model, (t.started_at at time zone 'UTC')::date, u.input_tokens,
          u.output_tokens, u.cache_read_tokens, u.cache_write_tokens) as usd) e
        where u.turn_id = t.id
      ) cost on true
      left join lateral (
        select count(*) as n,
          percentile_cont(0.95) within group (order by x.tok) as p95,
          percentile_cont(0.99) within group (order by x.tok) as p99
        from (select p.input_tokens + p.output_tokens + p.cache_write_tokens as tok
              from turns p
              where p.user_id = t.user_id
                and p.started_at >= t.started_at - interval '30 days' and p.started_at < t.started_at) x
      ) h on t.user_id is not null
      where t.updated_at >= ${since.toISOString()}::timestamptz
        and t.started_at >= ${oldest.toISOString()}::timestamptz
        and not exists (select 1 from runaway_alerts a where a.turn_id = t.id)`),
  );
  let created = 0;
  for (const c of candidates) {
    const reasons = runawayReasons(
      { tokens: c.ruleTokens, durationMs: c.durationMs, costUsd: c.costUsd, history: c.history, p95: c.p95, p99: c.p99 },
      thresholds,
    );
    if (!reasons.length) continue;
    const inserted = rows<{ id: string }>(
      await ctx.db.execute(sql`
        insert into runaway_alerts (turn_id, team_id, user_id, project_id, harness, model, started_at, reasons,
          tokens, cost_usd, duration_ms)
        values (${c.id}::uuid, ${c.teamId}::uuid, ${c.userId}::uuid, ${c.projectId}::uuid, ${c.harness},
          ${c.model}, ${new Date(c.startedAt).toISOString()}::timestamptz, ${JSON.stringify(reasons)}::jsonb, ${Math.round(c.tokens)},
          ${c.costUsd === null ? null : c.costUsd.toFixed(4)}::numeric, ${Math.round(c.durationMs)})
        on conflict (turn_id) do nothing returning id`),
    );
    created += inserted.length;
  }
  ctx.state.set(WATERMARK_KEY, startedAt.toISOString());
  return created;
}

interface AlertRow {
  id: string;
  turnId: string;
  teamId: string | null;
  userId: string | null;
  startedAt: Date;
  tokens: number;
  costUsd: number | null;
  durationMs: number;
  reasons: RunawayReason[];
  teamName: string | null;
  projectName: string | null;
  person: string | null;
  userEmail: string | null;
}

/**
 * Mails pending alerts, at most one digest per hour (the newest `notified_at` of any alert).
 * Recipients: the user of each turn while they are still a member; in `full` visibility also the leads of the turn's team
 * (with the person's name); in aggregates-only mode the admins (memberships.role = 'admin') get an anonymous digest
 * instead (ADR-0008, SEC-2). Service users have no e-mail and are never mailed. Alerts are claimed (notified_at) before
 * sending and released when every mail failed. Mails name the deployment (ADR-0028).
 */
export async function sendRunawayDigests(ctx: WorkerContext): Promise<{ sent: number; failed: number }> {
  const now = ctx.now();
  const [due] = rows<{ due: boolean }>(
    await ctx.db.execute(sql`
      select exists (select 1 from runaway_alerts where notified_at is null)
        and coalesce((select max(notified_at) from runaway_alerts), '-infinity'::timestamptz)
            <= ${new Date(now.getTime() - DIGEST_INTERVAL_MS).toISOString()}::timestamptz as due`),
  );
  if (!due?.due) return { sent: 0, failed: 0 };
  const dep = await loadDeployment(ctx.db);

  const claimed = rows<AlertRow>(
    await ctx.db.execute(sql`
      with c as (
        update runaway_alerts set notified_at = ${now.toISOString()}::timestamptz
        where notified_at is null
        returning id, turn_id, team_id, user_id, project_id, started_at, tokens, cost_usd, duration_ms, reasons
      )
      select c.id, c.turn_id as "turnId", c.team_id as "teamId", c.user_id as "userId", c.started_at as "startedAt",
        c.tokens::float8 as tokens, c.cost_usd::float8 as "costUsd", c.duration_ms::float8 as "durationMs", c.reasons,
        tm.name as "teamName",
        coalesce(p.display_name, case when p.key like 'sha256:%' then left(p.key, 15) || '…' else p.key end) as "projectName",
        -- A removed member (D1: the turn keeps their user_id) is neither mailed nor named.
        case when m.user_id is not null then coalesce(u.name, u.email)
             when c.user_id is not null then 'former member' end as person,
        case when m.user_id is not null then u.email end as "userEmail"
      from c
      left join teams tm on tm.id = c.team_id
      left join projects p on p.id = c.project_id
      left join users u on u.id = c.user_id
      left join memberships m on m.user_id = c.user_id
      order by c.started_at`),
  );
  if (!claimed.length) return { sent: 0, failed: 0 };
  const full = dep.settings.individualVisibility === 'full';
  const managers = rows<{ email: string; teamId: string | null }>(
    await ctx.db.execute(
      full
        ? sql`select u.email, tm.team_id as "teamId" from team_memberships tm join users u on u.id = tm.user_id
              where tm.role = 'lead' and u.email is not null`
        : sql`select u.email, null::uuid as "teamId" from memberships m join users u on u.id = m.user_id
              where m.role = 'admin' and u.email is not null`,
    ),
  );
  // email → items, kept apart for personal (own turns), named (leads) and anonymous (admins) digests
  const digests = new Map<string, { anonymous: boolean; items: RunawayMailItem[] }>();
  const add = (email: string, anonymous: boolean, a: AlertRow) => {
    const key = `${email.toLowerCase()}|${anonymous}`;
    const d = digests.get(key) ?? { anonymous, items: [] };
    const startedAt = new Date(a.startedAt);
    d.items.push({
      turnId: a.turnId, startedAt, startedMs: startedAt.getTime(), teamName: a.teamName, projectName: a.projectName,
      person: anonymous ? null : a.person, tokens: a.tokens, costUsd: a.costUsd, durationMs: a.durationMs, reasons: a.reasons,
    });
    digests.set(key, d);
  };
  for (const a of claimed) {
    const own = a.userEmail?.toLowerCase() ?? null;
    if (own) add(own, false, a);
    for (const m of managers) {
      if (m.email.toLowerCase() === own) continue;
      if (full && m.teamId !== a.teamId) continue;
      add(m.email, !full, a);
    }
  }
  const results = await Promise.allSettled(
    [...digests].map(([key, d]) =>
      ctx.mailer.send({ to: key.slice(0, key.lastIndexOf('|')), ...buildRunawayEmail({ deploymentName: dep.name, appUrl: ctx.config.appUrl, ...d }) }),
    ),
  );
  if (results.length && results.every((r) => r.status === 'rejected')) {
    const ids = `{${claimed.map((a) => a.id).join(',')}}`; // uuids only: a safe array literal
    await ctx.db.execute(sql`update runaway_alerts set notified_at = null where id = any(${ids}::uuid[])`);
    ctx.log.error('runaways: all digest mails failed', (results[0] as PromiseRejectedResult).reason);
    return { sent: 0, failed: 1 };
  }
  results.forEach((r) => r.status === 'rejected' && ctx.log.error('runaways: a digest mail failed', r.reason));
  return { sent: results.filter((r) => r.status === 'fulfilled').length, failed: 0 };
}

export const createRunawaysJob = (ctx: WorkerContext): Job => ({
  name: 'runaways',
  intervalMs: 5 * 60_000,
  async run() {
    const created = await detectRunaways(ctx);
    const { sent, failed } = await sendRunawayDigests(ctx);
    return `alerts=${created} mails=${sent} failed=${failed}`;
  },
});
