import { PLAN_LIMITS, type Plan } from '@ai-obs/db';
import { sql, type SQL } from 'drizzle-orm';
import type { WorkerContext } from '../context.js';
import { buildBudgetEmail } from '../budgets/mail.js';
import { decideBudget, measureUsage, type BudgetKind, type DayModelUsage, type Threshold } from '../budgets/evaluate.js';
import { indexPrices, type PriceIndex, type PriceRow } from '../lib/cost.js';
import { addDays, dayStart, monthStart, nextMonthStart, utcDay } from '../lib/dates.js';
import type { Job } from '../scheduler.js';

interface BudgetRow {
  id: string;
  companyId: string;
  teamId: string | null;
  userId: string | null;
  kind: BudgetKind;
  limit: number;
  notifiedPeriod: string | null;
  notified80: boolean;
  notified100: boolean;
  companyName: string;
  plan: Plan;
  teamName: string | null;
  userLabel: string | null;
  /** companies.settings.individualVisibility; anything but 'full' means aggregates-only (ADR-0008). */
  visibility: string | null;
}

export interface BudgetsSummary {
  budgets: number;
  sent: number;
  failed: number;
}

const rows = <T>(r: unknown): T[] => r as T[];

/** Raw turns starting more than this far in the future (client clock skew) are not counted yet. */
const FUTURE_SKEW_MS = 24 * 60 * 60_000;

async function loadBudgets(ctx: WorkerContext): Promise<BudgetRow[]> {
  return rows<BudgetRow>(
    await ctx.db.execute(sql`
      select b.id, b.company_id as "companyId", b.team_id as "teamId", b.user_id as "userId", b.kind,
        b.limit_value::float8 as "limit", b.notified_period::text as "notifiedPeriod",
        (b.notified_80_at is not null) as notified80, (b.notified_100_at is not null) as notified100,
        c.name as "companyName", c.plan, t.name as "teamName", coalesce(u.name, u.email) as "userLabel",
        c.settings->>'individualVisibility' as visibility
      from budgets b
      join companies c on c.id = b.company_id
      left join teams t on t.id = b.team_id
      left join users u on u.id = b.user_id
      where c.status = 'active'
      order by b.created_at`),
  );
}

async function loadPrices(ctx: WorkerContext): Promise<PriceIndex> {
  const r = rows<PriceRow>(
    await ctx.db.execute(sql`
      select model, effective_from::text as "effectiveFrom", input_per_mtok::text as "inputPerMtok",
        output_per_mtok::text as "outputPerMtok", cache_read_per_mtok::text as "cacheReadPerMtok",
        cache_write_per_mtok::text as "cacheWritePerMtok"
      from model_prices`),
  );
  return indexPrices(r);
}

/**
 * Month-to-date usage of a budget: daily rollups for the days before `rawFrom`, raw usage rows from
 * `rawFrom` on (yesterday and today, which the rollups job is still recomputing). Raw rows are bounded
 * above by the end of the month and by now + 1 day, so turns with a skewed-forward or bogus future
 * `started_at` never count as this month's usage.
 */
export async function monthToDate(ctx: WorkerContext, b: Pick<BudgetRow, 'companyId' | 'teamId' | 'userId'>, period: string, rawFrom: string): Promise<DayModelUsage[]> {
  const rollupScope: SQL[] = [];
  const rawScope: SQL[] = [];
  if (b.teamId) {
    rollupScope.push(sql`and d.team_id = ${b.teamId}`);
    rawScope.push(sql`and t.team_id = ${b.teamId}`);
  }
  if (b.userId) {
    rollupScope.push(sql`and d.user_id = ${b.userId}`);
    rawScope.push(sql`and t.user_id = ${b.userId}`);
  }
  const monthEnd = dayStart(nextMonthStart(period));
  const skewLimit = new Date(ctx.now().getTime() + FUTURE_SKEW_MS);
  const rawTo = (monthEnd < skewLimit ? monthEnd : skewLimit).toISOString();
  const fromRollups =
    rawFrom > period
      ? rows<DayModelUsage>(
          await ctx.db.execute(sql`
            select d.day::text as day, d.model, sum(d.input_tokens)::float8 as input, sum(d.output_tokens)::float8 as output,
              sum(d.cache_read_tokens)::float8 as "cacheRead", sum(d.cache_write_tokens)::float8 as "cacheWrite"
            from daily_rollups d
            where d.company_id = ${b.companyId} and d.day >= ${period}::date and d.day < ${rawFrom}::date
              ${sql.join(rollupScope, sql` `)}
            group by 1, 2`),
        )
      : [];
  const fromRaw = rows<DayModelUsage>(
    await ctx.db.execute(sql`
      select (t.started_at at time zone 'UTC')::date::text as day, u.model, sum(u.input_tokens)::float8 as input,
        sum(u.output_tokens)::float8 as output, sum(u.cache_read_tokens)::float8 as "cacheRead",
        sum(u.cache_write_tokens)::float8 as "cacheWrite"
      from usage u join turns t on t.id = u.turn_id and t.company_id = u.company_id
      where t.company_id = ${b.companyId} and t.started_at >= ${`${rawFrom}T00:00:00Z`}::timestamptz
        and t.started_at < ${rawTo}::timestamptz
        ${sql.join(rawScope, sql` `)}
      group by 1, 2`),
  );
  return [...fromRollups, ...fromRaw];
}

/**
 * Who gets a budget mail, de-duplicated by e-mail:
 * - team budget: company admins + leads of the team;
 * - user budget, company in `full` visibility: company admins + leads of the budget's team (if any) + the user;
 * - user budget, company in aggregates-only mode (the default, ADR-0008): **only the user**. Admins and
 *   leads see no per-person usage in that mode, and the mail names the person and their exact usage.
 */
export async function recipients(ctx: WorkerContext, b: Pick<BudgetRow, 'companyId' | 'teamId' | 'userId' | 'visibility'>): Promise<string[]> {
  const onlyTheUser = b.userId !== null && b.visibility !== 'full';
  const found = rows<{ email: string }>(
    await ctx.db.execute(
      onlyTheUser
        ? sql`select u.email from users u where u.id = ${b.userId}::uuid and u.company_id = ${b.companyId}`
        : sql`
      select u.email from users u where u.company_id = ${b.companyId} and u.company_role = 'admin'
      union
      select u.email from team_memberships m join users u on u.id = m.user_id
        where m.company_id = ${b.companyId} and m.role = 'lead' and ${b.teamId}::uuid is not null and m.team_id = ${b.teamId}::uuid
      union
      select u.email from users u where ${b.userId}::uuid is not null and u.id = ${b.userId}::uuid and u.company_id = ${b.companyId}`,
    ),
  );
  return [...new Set(found.map((r) => r.email.toLowerCase()))].sort();
}

/**
 * Claims the "sent" mark before mailing, so two workers (or a retry after a crash) never send twice.
 * Returns false when another worker already claimed it. Crossing 100 % also marks 80 %.
 */
async function claim(ctx: WorkerContext, id: string, period: string, threshold: Threshold): Promise<boolean> {
  const claimed =
    threshold === 100
      ? sql`update budgets set notified_80_at = coalesce(notified_80_at, now()), notified_100_at = now()
            where id = ${id} and notified_period = ${period}::date and notified_100_at is null returning id`
      : sql`update budgets set notified_80_at = now()
            where id = ${id} and notified_period = ${period}::date and notified_80_at is null returning id`;
  return rows(await ctx.db.execute(claimed)).length > 0;
}

/** Undo a claim after every delivery failed, keeping 80 % as it was before. */
async function release(ctx: WorkerContext, b: BudgetRow, threshold: Threshold): Promise<void> {
  await ctx.db.execute(
    threshold === 100
      ? sql`update budgets set notified_100_at = null, notified_80_at = ${b.notified80 ? sql`notified_80_at` : sql`null`} where id = ${b.id}`
      : sql`update budgets set notified_80_at = null where id = ${b.id}`,
  );
}

/** One budgets pass. Exported for tests and RUN_ONCE. */
export async function runBudgets(ctx: WorkerContext, signal?: AbortSignal): Promise<BudgetsSummary> {
  const today = utcDay(ctx.now());
  const period = monthStart(today);
  const rawFrom = [addDays(today, -1), period].sort().at(-1)!;
  const prices = await loadPrices(ctx);
  const all = await loadBudgets(ctx);
  const summary: BudgetsSummary = { budgets: 0, sent: 0, failed: 0 };

  for (const b of all) {
    if (signal?.aborted) break;
    if (!PLAN_LIMITS[b.plan]?.budgets) continue;
    summary.budgets += 1;
    try {
      const { value, unpriced } = measureUsage(await monthToDate(ctx, b, period, rawFrom), b.kind, prices);
      if (unpriced.length) ctx.log.info(`budgets: no price for ${unpriced.join(', ')}; counted as 0 in budget ${b.id}`);
      const decision = decideBudget({
        period,
        limit: b.limit,
        used: value,
        marks: { notifiedPeriod: b.notifiedPeriod, notified80: b.notified80, notified100: b.notified100 },
      });
      if (decision.reset) {
        await ctx.db.execute(
          sql`update budgets set notified_period = ${period}::date, notified_80_at = null, notified_100_at = null where id = ${b.id}`,
        );
        b.notified80 = false;
        b.notified100 = false;
      }
      if (!decision.send) continue;
      if (!(await claim(ctx, b.id, period, decision.send))) continue;

      const to = await recipients(ctx, b);
      if (to.length === 0) {
        ctx.log.info(`budgets: ${b.id} crossed ${decision.send} % but has no recipients`);
        continue;
      }
      const scope = [b.teamName && `team ${b.teamName}`, b.userLabel].filter(Boolean).join(' / ');
      const mail = buildBudgetEmail({
        threshold: decision.send, kind: b.kind, used: value, limit: b.limit, period,
        companyName: b.companyName, scope, appUrl: ctx.config.appUrl,
      });
      const results = await Promise.allSettled(to.map((address) => ctx.mailer.send({ to: address, ...mail })));
      if (results.some((r) => r.status === 'fulfilled')) {
        summary.sent += 1;
        results.forEach((r) => r.status === 'rejected' && ctx.log.error(`budgets: mail for budget ${b.id} failed`, r.reason));
      } else {
        summary.failed += 1;
        await release(ctx, b, decision.send); // retried on the next pass
        ctx.log.error(`budgets: all mails for budget ${b.id} failed`, (results[0] as PromiseRejectedResult).reason);
      }
    } catch (err) {
      summary.failed += 1;
      ctx.log.error(`budgets: budget ${b.id} failed`, err);
    }
  }
  return summary;
}

export const createBudgetsJob = (ctx: WorkerContext): Job => ({
  name: 'budgets',
  intervalMs: 60 * 60_000,
  async run(signal) {
    const s = await runBudgets(ctx, signal);
    return `budgets=${s.budgets} sent=${s.sent} failed=${s.failed}`;
  },
});
