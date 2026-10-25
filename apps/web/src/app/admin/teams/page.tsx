import { Badge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import {
  addMemberAction,
  createTeamAction,
  deleteTeamAction,
  removeMemberAction,
  renameTeamAction,
  setMemberRoleAction,
  setPrimaryTeamAction,
  setTeamSlugAction,
} from '@/lib/admin/actions/teams';
import { requireAdminPage } from '@/lib/admin/guard';
import { listMembers } from '@/lib/admin/members';
import { listTeamsWithMembers } from '@/lib/admin/teams';
import { withUserDb } from '@/lib/auth/rls';
import { ActionForm } from '../_components/ActionForm';
import { Confirm } from '../_components/Confirm';
import { inputCls, labelCls, noteCls, selectCls, tableCls, tableWrapCls, tdCls, thCls, trCls } from '../_components/ui';

export const metadata = { title: 'Teams' };

const Hidden = ({ n, v }: { n: string; v: string }) => <input type="hidden" name={n} value={v} />;

export default async function TeamsPage() {
  const user = await requireAdminPage();
  const { teams, members } = await withUserDb(user, async (tx) => ({
    teams: await listTeamsWithMembers(tx),
    members: await listMembers(tx),
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Teams"
        description="A session's team is the project's mapped team (Projects page), else the user's primary team; otherwise no team."
      />
      <Card title="New team" description="The slug identifies the team to collectors (`ai-obs login` lists it). Leave it empty to derive it from the name.">
        <ActionForm action={createTeamAction} submitLabel="Create team">
          <label className={`${labelCls} grow sm:max-w-xs`}>
            Name
            <input name="name" required maxLength={80} className={inputCls} />
          </label>
          <label className={`${labelCls} sm:max-w-48`}>
            Slug (optional)
            <input name="slug" maxLength={63} pattern="[a-z0-9-]{1,63}" placeholder="e.g. platform" className={`${inputCls} font-mono`} />
          </label>
        </ActionForm>
      </Card>

      {teams.map((t) => {
        const outside = members.filter((m) => !t.members.some((x) => x.userId === m.id));
        return (
          <Card
            key={t.id}
            title={t.name}
            description={`slug ${t.slug} · ${t.members.length} members`}
            actions={
              <Confirm
                label="Delete…"
                warning={t.members.length ? 'Only an empty team (no members, no recorded turns) can be deleted.' : `Delete team "${t.name}"? Its budgets go with it.`}
                action={deleteTeamAction}
                confirmLabel="Delete team"
              >
                <Hidden n="teamId" v={t.id} />
              </Confirm>
            }
          >
            <div className="mb-3 flex flex-wrap gap-4">
              <ActionForm action={renameTeamAction} submitLabel="Rename" tone="subtle">
                <Hidden n="teamId" v={t.id} />
                <label className={`${labelCls} grow sm:max-w-xs`}>
                  Team name
                  <input name="name" required maxLength={80} defaultValue={t.name} className={inputCls} />
                </label>
              </ActionForm>
              <ActionForm action={setTeamSlugAction} submitLabel="Change slug" tone="subtle">
                <Hidden n="teamId" v={t.id} />
                <label className={`${labelCls} sm:max-w-48`}>
                  Slug
                  <input name="slug" required maxLength={63} pattern="[a-z0-9-]{1,63}" defaultValue={t.slug} className={`${inputCls} font-mono`} />
                </label>
              </ActionForm>
            </div>
            <p className={`mb-3 ${noteCls}`}>
              The slug can be changed only until the first turn is recorded for this team; after that it is fixed.
            </p>
            {t.members.length === 0 ? (
              <p className={noteCls}>No members yet.</p>
            ) : (
              <div className={tableWrapCls}>
                <table className={tableCls}>
                  <thead>
                    <tr className="border-b border-zinc-200 dark:border-zinc-800">
                      <th className={thCls}>Member</th>
                      <th className={thCls}>Team role</th>
                      <th className={thCls}>Primary team</th>
                      <th className={thCls}>
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.members.map((m) => (
                      <tr key={m.userId} className={trCls}>
                        <td className={tdCls}>
                          <div className="font-medium">
                            {m.name} {m.kind === 'service' && <Badge>service</Badge>}
                          </div>
                          {m.email && <div className={noteCls}>{m.email}</div>}
                        </td>
                        <td className={tdCls}>
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={m.role === 'lead' ? 'info' : 'neutral'}>{m.role}</Badge>
                            <ActionForm action={setMemberRoleAction} submitLabel={m.role === 'lead' ? 'Make member' : 'Make lead'} tone="subtle">
                              <Hidden n="teamId" v={t.id} />
                              <Hidden n="userId" v={m.userId} />
                              <Hidden n="role" v={m.role === 'lead' ? 'member' : 'lead'} />
                            </ActionForm>
                          </div>
                        </td>
                        <td className={tdCls}>
                          {m.isPrimary ? (
                            <Badge tone="good">primary</Badge>
                          ) : (
                            <ActionForm action={setPrimaryTeamAction} submitLabel="Set primary" tone="subtle">
                              <Hidden n="teamId" v={t.id} />
                              <Hidden n="userId" v={m.userId} />
                            </ActionForm>
                          )}
                        </td>
                        <td className={tdCls}>
                          <Confirm label="Remove…" warning={`Remove ${m.name} from ${t.name}? Their account, data and tokens stay; their primary team moves to another of their teams.`} action={removeMemberAction} confirmLabel="Remove from team">
                            <Hidden n="teamId" v={t.id} />
                            <Hidden n="userId" v={m.userId} />
                          </Confirm>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {outside.length > 0 && (
              <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <ActionForm action={addMemberAction} submitLabel="Add member" tone="subtle">
                  <Hidden n="teamId" v={t.id} />
                  <label className={`${labelCls} grow sm:max-w-xs`}>
                    User
                    <select name="userId" required className={selectCls}>
                      {outside.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={labelCls}>
                    Role
                    <select name="role" className={selectCls} defaultValue="member">
                      <option value="member">member</option>
                      <option value="lead">lead</option>
                    </select>
                  </label>
                </ActionForm>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
