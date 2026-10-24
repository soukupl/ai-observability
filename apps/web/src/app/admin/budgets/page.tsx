import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { formatTokens, formatUsd } from '@/components/format';
import { exportUrl } from '@/components/export-url';
import { createBudgetAction, deleteBudgetAction, updateBudgetAction } from '@/lib/admin/actions/settings';
import { listBudgetConfigs } from '@/lib/admin/budgets';
import { requireAdminOrLead } from '@/lib/admin/guard';
import { listMembers } from '@/lib/admin/members';
import { isAdmin } from '@/lib/admin/permissions';
import { listTeamsWithMembers } from '@/lib/admin/teams';
import { defaultFilters } from '@/lib/filters';
import { getBudgetProgress, type BudgetProgress } from '@/lib/queries/budgets';
import { withDashboardContext } from '@/lib/queries/page';
import { ActionForm } from '../_components/ActionForm';
import { Confirm } from '../_components/Confirm';
import { inputCls, labelCls, noteCls, selectCls, tableCls, tableWrapCls, tdCls, thCls, trCls } from '../_components/ui';

export const metadata = { title: 'Budgets' };

const LEVEL = { ok: 'text-emerald-700 dark:text-emerald-400', warn: 'text-amber-700 dark:text-amber-400', over: 'text-red-700 dark:text-red-400', unknown: 'text-zinc-500' } as const;
const amount = (kind: 'tokens' | 'cost', v: number) => (kind === 'cost' ? `≈ ${formatUsd(v)}` : formatTokens(v));

function Progress({ p, kind }: { p: BudgetProgress | undefined; kind: 'tokens' | 'cost' }) {
  if (!p) return <span className={noteCls}>hidden (aggregates-only mode)</span>;
  return (
    <span className={`whitespace-nowrap ${LEVEL[p.level]}`}>
      {p.used === null ? 'n/a' : amount(kind, p.used)}
      {p.fraction !== null && ` · ${Math.round(p.fraction * 100)} %`}
      {p.partialCost && ' · some models unpriced'}
    </span>
  );
}

/** Admins manage every budget; leads see their teams' budgets read-only (RLS decides the rows). */
export default async function AdminBudgetsPage() {
  const user = await requireAdminOrLead();
  const admin = isAdmin(user);
  const data = await withDashboardContext(user, async (ctx) => ({
    configs: await listBudgetConfigs(ctx.tx),
    progress: await getBudgetProgress(ctx),
    teams: await listTeamsWithMembers(ctx.tx),
    members: admin ? await listMembers(ctx.tx) : [],
  }));
  const { configs, progress, teams, members } = data;
  const byId = new Map(progress.rows.map((r) => [r.id, r]));
  const canEdit = admin;
  const label = (c: (typeof configs)[number]) => (c.scope === 'team' ? `Team ${c.teamName ?? '—'}` : `User ${c.userName ?? '—'}`);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Budgets"
        description={`Monthly token or ≈ cost limits (cost at API list prices). E-mail to admins and the team's leads at 80 % and 100 %. Budgets never block anyone. Month starting ${progress.month} (UTC).`}
      />
      {canEdit && (
        <Card title="New budget" description="A user budget counts that person's usage in all teams. While individual visibility is aggregates-only (the default), alerts for a user budget go only to that user; admins and team leads are not mailed.">
          <ActionForm action={createBudgetAction} submitLabel="Create budget">
            <label className={labelCls}>
              For
              <select name="scope" className={selectCls} defaultValue="team">
                <option value="team">a team</option>
                <option value="user">a user</option>
              </select>
            </label>
            <label className={labelCls}>
              Team (team budget)
              <select name="teamId" className={selectCls} defaultValue={teams[0]?.id ?? ''}>
                <option value="">—</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              User (user budget)
              <select name="userId" className={selectCls} defaultValue="">
                <option value="">—</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name || m.email}</option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              Kind
              <select name="kind" className={selectCls} defaultValue="cost">
                <option value="cost">≈ cost (USD)</option>
                <option value="tokens">tokens</option>
              </select>
            </label>
            <label className={`${labelCls} w-36`}>
              Monthly limit
              <input type="number" name="limit" required min="0.01" step="any" className={inputCls} />
            </label>
          </ActionForm>
        </Card>
      )}
      <Card title="Budgets" actions={null}>
        {configs.length === 0 ? (
          <p className={noteCls}>No budgets{admin ? '' : ' for your teams'}.</p>
        ) : (
          <div className={tableWrapCls}>
            <table className={tableCls}>
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  {['Scope', 'Kind', 'Limit', 'Used this month', ...(canEdit ? ['', ''] : [])].map((h, i) => (
                    <th key={`${h}${i}`} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {configs.map((c) => (
                  <tr key={c.id} className={trCls}>
                    <td className={tdCls}>{label(c)}</td>
                    <td className={tdCls}>{c.kind === 'cost' ? '≈ cost' : 'tokens'}</td>
                    <td className={`${tdCls} whitespace-nowrap tabular-nums`}>{amount(c.kind, c.limit)}</td>
                    <td className={tdCls}>
                      <Progress p={byId.get(c.id)} kind={c.kind} />
                    </td>
                    {canEdit && (
                      <>
                        <td className={tdCls}>
                          <ActionForm action={updateBudgetAction} submitLabel="Save" tone="subtle" className="flex flex-nowrap items-end gap-2">
                            <input type="hidden" name="budgetId" value={c.id} />
                            <select name="kind" defaultValue={c.kind} aria-label="Kind" className={`${selectCls} w-24`}>
                              <option value="cost">cost</option>
                              <option value="tokens">tokens</option>
                            </select>
                            <input type="number" name="limit" required min="0.01" step="any" defaultValue={c.limit} aria-label="Limit" className={`${inputCls} w-32`} />
                          </ActionForm>
                        </td>
                        <td className={tdCls}>
                          <Confirm label="Delete…" warning={`Delete the budget for ${label(c)}?`} action={deleteBudgetAction} confirmLabel="Delete budget">
                            <input type="hidden" name="budgetId" value={c.id} />
                          </Confirm>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {progress.hiddenUserBudgets > 0 && (
          <p className={`mt-2 ${noteCls}`}>Usage of other people's budgets is not shown in aggregates-only mode ({progress.hiddenUserBudgets}).</p>
        )}
        <p className="mt-2">
          <a href={exportUrl('budgets', defaultFilters())} download className="text-xs text-blue-700 hover:underline dark:text-blue-400">
            Export CSV
          </a>
        </p>
      </Card>
    </div>
  );
}
