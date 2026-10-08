import { and, eq, sql } from 'drizzle-orm';
import { budgets, companyMemberships, teams, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { loadCompany } from './company';
import { id, optionalId, parse } from './input';
import { canManageBudgets } from './permissions';
import { budgetsAllowed } from './plans';
import { AdminError, ensure, type Actor } from './types';

export interface BudgetConfigRow {
  id: string;
  scope: 'team' | 'user';
  teamId: string | null;
  teamName: string | null;
  userId: string | null;
  userName: string | null;
  kind: 'tokens' | 'cost';
  limit: number;
}

/** Budget definitions the viewer may see (RLS: admins all, leads their teams, users their own). */
export async function listBudgetConfigs(tx: Tx, companyId: string): Promise<BudgetConfigRow[]> {
  const list = await rows<{ id: string; team_id: string | null; team_name: string | null; user_id: string | null; user_name: string | null; kind: 'tokens' | 'cost'; limit_value: number | string }>(
    tx,
    sql`select b.id, b.team_id, t.name as team_name, b.user_id, coalesce(u.name, u.email) as user_name, b.kind, b.limit_value::float8 as limit_value
        from budgets b left join teams t on t.id = b.team_id left join users u on u.id = b.user_id
        where b.company_id = ${companyId}::uuid order by b.created_at`,
  );
  return list.map((b) => ({
    id: b.id,
    scope: b.user_id ? 'user' : 'team',
    teamId: b.team_id,
    teamName: b.team_name,
    userId: b.user_id,
    userName: b.user_name,
    kind: b.kind,
    limit: Number(b.limit_value),
  }));
}

const limitValue = z.coerce.number().positive('must be greater than 0').max(1e15, 'too large');
export const budgetInput = z
  .object({ scope: z.enum(['team', 'user']), teamId: optionalId, userId: optionalId, kind: z.enum(['tokens', 'cost']), limit: limitValue })
  .refine((b) => (b.scope === 'team' ? !!b.teamId : !!b.userId), { message: 'choose a team or a user', path: ['scope'] });

const toNumeric = (kind: 'tokens' | 'cost', v: number) => (kind === 'tokens' ? String(Math.round(v)) : v.toFixed(2));

async function guard(tx: Tx, actor: Actor) {
  ensure(canManageBudgets(actor), 'Only company admins can manage budgets.');
  const company = await loadCompany(tx, actor.companyId);
  if (!budgetsAllowed(company.plan)) throw new AdminError(`Budgets are not part of the ${company.plan} plan.`);
}

/** Monthly budget for a team or a user (BRIEF §9). User budgets count the user's usage in all teams. */
export async function createBudget(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  await guard(tx, actor);
  const b = parse(budgetInput, input);
  const teamId = b.scope === 'team' ? b.teamId : null;
  const userId = b.scope === 'user' ? b.userId : null;
  if (teamId) ensure((await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.companyId, actor.companyId), eq(teams.id, teamId)))).length, 'Team not found.');
  if (userId) ensure((await tx.select({ id: companyMemberships.userId }).from(companyMemberships).where(and(eq(companyMemberships.companyId, actor.companyId), eq(companyMemberships.userId, userId)))).length, 'User not found.');
  const [row] = await tx
    .insert(budgets)
    .values({ companyId: actor.companyId, teamId, userId, kind: b.kind, limitValue: toNumeric(b.kind, b.limit) })
    .returning({ id: budgets.id });
  await audit(tx, actor, 'budget.create', `budget:${row!.id}`, { scope: b.scope, teamId, userId, kind: b.kind, limit: b.limit });
  return 'Budget created.';
}

export async function updateBudget(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  await guard(tx, actor);
  const b = parse(z.object({ budgetId: id, kind: z.enum(['tokens', 'cost']), limit: limitValue }), input);
  const [before] = await tx.select({ kind: budgets.kind, limit: budgets.limitValue }).from(budgets).where(and(eq(budgets.companyId, actor.companyId), eq(budgets.id, b.budgetId)));
  ensure(before, 'Budget not found.');
  await tx
    .update(budgets)
    .set({ kind: b.kind, limitValue: toNumeric(b.kind, b.limit), updatedAt: new Date() })
    .where(and(eq(budgets.companyId, actor.companyId), eq(budgets.id, b.budgetId)));
  await audit(tx, actor, 'budget.update', `budget:${b.budgetId}`, { before: { kind: before.kind, limit: Number(before.limit) }, after: { kind: b.kind, limit: b.limit } });
  return 'Budget saved.';
}

export async function deleteBudget(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(canManageBudgets(actor), 'Only company admins can manage budgets.');
  const { budgetId } = parse(z.object({ budgetId: id }), input);
  const gone = await tx
    .delete(budgets)
    .where(and(eq(budgets.companyId, actor.companyId), eq(budgets.id, budgetId)))
    .returning({ kind: budgets.kind, limit: budgets.limitValue, teamId: budgets.teamId, userId: budgets.userId });
  ensure(gone.length === 1, 'Budget not found.');
  await audit(tx, actor, 'budget.delete', `budget:${budgetId}`, { kind: gone[0]!.kind, limit: Number(gone[0]!.limit), teamId: gone[0]!.teamId, userId: gone[0]!.userId });
  return 'Budget deleted.';
}
