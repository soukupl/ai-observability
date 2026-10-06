import { sql } from 'drizzle-orm';
import { CostSum } from '../cost';
import { listTeams } from './lookups';
import { usageDaily, type Dims } from './providers';
import { dayString } from './range';
import { canSeeUsers, type QueryCtx } from './scope';
import { costTokens, rows } from './sqlutil';

export interface BudgetProgress {
  id: string;
  scope: 'team' | 'user';
  teamId: string | null;
  teamName: string | null;
  /** Only set when the viewer may see individuals, or for the viewer's own budget. */
  userName?: string | null;
  isMine: boolean;
  kind: 'tokens' | 'cost';
  /** Tokens, or USD for kind = 'cost'. */
  limit: number;
  /** Month to date; null when a cost budget has no priced model yet. */
  used: number | null;
  /** used / limit (can exceed 1). */
  fraction: number | null;
  level: 'ok' | 'warn' | 'over' | 'unknown';
  /** Some usage had no price and is not in `used`. */
  partialCost: boolean;
}

export interface BudgetsResult {
  /** First day of the month the progress is for (UTC), YYYY-MM-DD. */
  month: string;
  rows: BudgetProgress[];
  /** User budgets of other people left out because the company is in aggregates-only mode. */
  hiddenUserBudgets: number;
}

export const WARN_AT = 0.8;

/** Month-to-date progress of the budgets the viewer may see (RLS decides which). */
export async function getBudgetProgress(ctx: QueryCtx): Promise<BudgetsResult> {
  const today = dayString(ctx.now.getTime());
  const month = `${today.slice(0, 7)}-01`;
  const nextMonth = dayString(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
  const list = await rows<{ id: string; team_id: string | null; user_id: string | null; kind: 'tokens' | 'cost'; limit_value: unknown; user_name: string | null }>(
    ctx.tx,
    sql`select b.id, b.team_id, b.user_id, b.kind, b.limit_value::float8 as limit_value, u.name as user_name
        from budgets b left join users u on u.id = b.user_id and u.company_id = b.company_id
        where b.company_id = ${ctx.viewer.companyId}::uuid order by b.kind, b.created_at`,
  );
  const teams = new Map((await listTeams(ctx)).map((t) => [t.id, t.name]));
  const showUsers = canSeeUsers(ctx.viewer);
  const out: BudgetProgress[] = [];
  let hidden = 0;
  for (const b of list) {
    const mine = b.user_id === ctx.viewer.id;
    if (b.user_id && !mine && !showUsers) {
      hidden += 1;
      continue;
    }
    const d: Dims = {
      fromDay: month,
      toDay: nextMonth,
      fromIso: `${month}T00:00:00Z`,
      toIso: `${nextMonth}T00:00:00Z`,
      teamId: b.team_id,
      projectId: null,
      userId: b.user_id,
      harness: null,
      model: null,
      effort: null,
    };
    // A user budget is read from the tables (own rows, or full mode); a team budget through the
    // aggregate functions when the viewer is in aggregates-only mode.
    const usage = await usageDaily(b.user_id ? { ...ctx, agg: false } : ctx, d);
    let used: number | null;
    let partial = false;
    if (b.kind === 'tokens') {
      used = usage.reduce((s, u) => s + u.tokens.total, 0);
    } else {
      const cs = new CostSum(ctx.prices);
      for (const u of usage) cs.add(u.model, u.day, costTokens(u.tokens));
      const v = cs.value();
      used = usage.length === 0 ? 0 : v.usd;
      partial = v.partial;
    }
    const limit = Number(b.limit_value);
    const fraction = used === null || limit <= 0 ? null : used / limit;
    out.push({
      id: b.id,
      scope: b.user_id ? 'user' : 'team',
      teamId: b.team_id,
      teamName: b.team_id ? (teams.get(b.team_id) ?? null) : null,
      ...(b.user_id && (mine || showUsers) ? { userName: b.user_name } : {}),
      isMine: mine,
      kind: b.kind,
      limit,
      used,
      fraction,
      level: fraction === null ? 'unknown' : fraction >= 1 ? 'over' : fraction >= WARN_AT ? 'warn' : 'ok',
      partialCost: partial,
    });
  }
  return { month, rows: out, hiddenUserBudgets: hidden };
}
