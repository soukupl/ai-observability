import { Badge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { formatDateTime } from '@/components/format';
import { changeRoleAction, inviteAction, removeUserAction, revokeInvitationAction } from '@/lib/admin/actions/members';
import { companyCounts, loadCompany } from '@/lib/admin/company';
import { requireAdminPage } from '@/lib/admin/guard';
import { listPendingInvitations } from '@/lib/admin/invitations';
import { listMembers } from '@/lib/admin/members';
import { capacityError, formatLimit, planLimits } from '@/lib/admin/plans';
import { listTeamsWithMembers } from '@/lib/admin/teams';
import { withUserDb } from '@/lib/auth/rls';
import { ActionForm } from '../_components/ActionForm';
import { Confirm } from '../_components/Confirm';
import { inputCls, labelCls, noteCls, selectCls, tableCls, tableWrapCls, tdCls, thCls, trCls } from '../_components/ui';

export const metadata = { title: 'Members' };

const Hidden = ({ n, v }: { n: string; v: string }) => <input type="hidden" name={n} value={v} />;

export default async function MembersPage() {
  const user = await requireAdminPage();
  const data = await withUserDb(user, async (tx) => ({
    company: await loadCompany(tx, user.companyId),
    counts: await companyCounts(tx, user.companyId),
    members: await listMembers(tx, user.companyId),
    invitations: await listPendingInvitations(tx, user.companyId),
    teams: await listTeamsWithMembers(tx, user.companyId),
  }));
  const { company, counts, members, invitations, teams } = data;
  const used = counts.users + counts.pendingInvitations;
  const limitMsg = capacityError(company.plan, 'users', used);

  return (
    <div className="space-y-4">
      <PageHeader title="Members" description="Company roles, removal and invitations. Team memberships are managed on the Teams page." />

      <Card title="Invite" description={`${used} of ${formatLimit(planLimits(company.plan).users)} users (members + pending invitations) on the ${company.plan} plan. Invitations expire after 7 days.`}>
        {limitMsg ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">{limitMsg}</p>
        ) : (
          <ActionForm action={inviteAction} submitLabel="Send invitation">
            <label className={`${labelCls} grow sm:max-w-xs`}>
              E-mail
              <input type="email" name="email" required className={inputCls} autoComplete="off" />
            </label>
            <label className={labelCls}>
              Team
              <select name="teamId" className={selectCls} defaultValue={teams[0]?.id ?? ''}>
                <option value="">(no team)</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              Team role
              <select name="teamRole" className={selectCls} defaultValue="member">
                <option value="member">member</option>
                <option value="lead">lead</option>
              </select>
            </label>
            <label className={labelCls}>
              Company role
              <select name="companyRole" className={selectCls} defaultValue="member">
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </label>
          </ActionForm>
        )}
        <p className={`mt-2 ${noteCls}`}>The person signs in with the invited address (magic link, Google or GitHub) to join. An address that already belongs to another ai-obs company cannot join.</p>
      </Card>

      <Card title={`Pending invitations (${invitations.length})`}>
        {invitations.length === 0 ? (
          <p className={noteCls}>None.</p>
        ) : (
          <div className={tableWrapCls}>
            <table className={tableCls}>
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  {['E-mail', 'Team', 'Roles', 'Expires', 'Invited by', ''].map((h) => (
                    <th key={h} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invitations.map((i) => (
                  <tr key={i.id} className={trCls}>
                    <td className={tdCls}>{i.email}</td>
                    <td className={tdCls}>{i.teamName ?? '—'}</td>
                    <td className={tdCls}>
                      {i.companyRole} · team {i.teamRole}
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>{formatDateTime(i.expiresMs)}</td>
                    <td className={tdCls}>{i.invitedBy ?? '—'}</td>
                    <td className={tdCls}>
                      <Confirm label="Revoke…" warning={`Revoke the invitation for ${i.email}?`} action={revokeInvitationAction} confirmLabel="Revoke">
                        <Hidden n="invitationId" v={i.id} />
                      </Confirm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Members (${members.length})`}>
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                {['Name', 'Company role', 'Teams', 'Last login', ''].map((h) => (
                  <th key={h} className={thCls}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const self = m.id === user.id;
                return (
                  <tr key={m.id} className={trCls}>
                    <td className={tdCls}>
                      <div className="font-medium">
                        {m.name || m.email} {self && <Badge>you</Badge>}
                      </div>
                      <div className={noteCls}>{m.email}</div>
                    </td>
                    <td className={tdCls}>
                      <ActionForm action={changeRoleAction} submitLabel="Save" tone="subtle" className="flex flex-nowrap items-end gap-2">
                        <Hidden n="userId" v={m.id} />
                        <select name="role" defaultValue={m.companyRole} aria-label={`Company role of ${m.email}`} className={`${selectCls} w-28`}>
                          <option value="member">member</option>
                          <option value="admin">admin</option>
                        </select>
                      </ActionForm>
                    </td>
                    <td className={tdCls}>
                      {m.teams.length === 0
                        ? '—'
                        : m.teams.map((t) => (
                            <div key={t.id} className="whitespace-nowrap">
                              {t.name}
                              {t.role === 'lead' && ' (lead)'}
                              {t.id === m.primaryTeamId && <span className={noteCls}> · primary</span>}
                            </div>
                          ))}
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>{m.lastLoginMs ? formatDateTime(m.lastLoginMs) : 'never'}</td>
                    <td className={tdCls}>
                      {!self && (
                        <Confirm
                          label="Remove…"
                          warning={`Remove ${m.email}? Their raw telemetry (sessions, turns, runs, usage), machines and tokens are deleted now; daily rollups are kept without their name. This cannot be undone.`}
                          action={removeUserAction}
                          confirmLabel="Remove user"
                        >
                          <Hidden n="userId" v={m.id} />
                        </Confirm>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
