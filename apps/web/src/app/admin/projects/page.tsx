import { Badge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { formatInt } from '@/components/format';
import { setProjectNameAction, setProjectTeamAction } from '@/lib/admin/actions/company';
import { requireAdminPage } from '@/lib/admin/guard';
import { listAdminProjects } from '@/lib/admin/projects';
import { listTeamsWithMembers } from '@/lib/admin/teams';
import { withUserDb } from '@/lib/auth/rls';
import { ActionForm } from '../_components/ActionForm';
import { inputCls, noteCls, selectCls, tableCls, tableWrapCls, tdCls, thCls, trCls } from '../_components/ui';

export const metadata = { title: 'Projects' };

export default async function AdminProjectsPage() {
  const user = await requireAdminPage();
  const { projects, teams } = await withUserDb(user, async (tx) => ({
    projects: await listAdminProjects(tx, user.companyId),
    teams: await listTeamsWithMembers(tx, user.companyId),
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Projects"
        description="Give projects a readable name (useful for hashed keys) and map them to a team. A mapping wins over the token's team for new turns; recorded turns keep their team."
      />
      <Card>
        {projects.length === 0 ? (
          <p className={noteCls}>No projects yet. They appear when collectors send their first turn.</p>
        ) : (
          <div className={tableWrapCls}>
            <table className={tableCls}>
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className={thCls}>Key</th>
                  <th className={thCls}>Display name</th>
                  <th className={thCls}>Team</th>
                  <th className={`${thCls} text-right`} title="All turns of the project in the last 30 days (company aggregate)">
                    Turns (30 d)
                  </th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className={trCls}>
                    <td className={`${tdCls} max-w-64`}>
                      <div className="truncate font-mono text-xs" title={p.key}>
                        {p.key}
                      </div>
                      {p.hashed && <Badge>hashed</Badge>}
                    </td>
                    <td className={tdCls}>
                      <ActionForm action={setProjectNameAction} submitLabel="Save" tone="subtle" className="flex flex-nowrap items-end gap-2">
                        <input type="hidden" name="projectId" value={p.id} />
                        <input name="displayName" maxLength={120} defaultValue={p.displayName ?? ''} placeholder="(key)" aria-label={`Display name of ${p.key}`} className={`${inputCls} w-44`} />
                      </ActionForm>
                    </td>
                    <td className={tdCls}>
                      <ActionForm action={setProjectTeamAction} submitLabel="Save" tone="subtle" className="flex flex-nowrap items-end gap-2">
                        <input type="hidden" name="projectId" value={p.id} />
                        <select name="teamId" defaultValue={p.teamId ?? ''} aria-label={`Team of ${p.key}`} className={`${selectCls} w-40`}>
                          <option value="">(not mapped)</option>
                          {teams.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </ActionForm>
                    </td>
                    <td className={`${tdCls} text-right tabular-nums`}>{formatInt(p.turns30d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
