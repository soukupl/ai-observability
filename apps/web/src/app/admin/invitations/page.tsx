import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { formatDateTime } from '@/components/format';
import { inviteAction, revokeInvitationAction } from '@/lib/admin/actions/members';
import { requireAdminPage } from '@/lib/admin/guard';
import { INVITATION_TTL_DAYS, listPendingInvitations } from '@/lib/admin/invitations';
import { listTeamsWithMembers } from '@/lib/admin/teams';
import { withUserDb } from '@/lib/auth/rls';
import { ActionForm } from '../_components/ActionForm';
import { Confirm } from '../_components/Confirm';
import { inputCls, labelCls, noteCls, selectCls, tableCls, tableWrapCls, tdCls, thCls, trCls } from '../_components/ui';

export const metadata = { title: 'Invitations' };

/** Invite an address into a team with a team role and a membership role; it is auto-accepted at sign-in (ADR-0028 E7). */
export default async function InvitationsPage() {
  const user = await requireAdminPage();
  const { invitations, teams } = await withUserDb(user, async (tx) => ({
    invitations: await listPendingInvitations(tx),
    teams: await listTeamsWithMembers(tx),
  }));
  const name = user.deployment.name;

  return (
    <div className="space-y-4">
      <PageHeader title="Invitations" description={`Invite people to ${name}. Invitations expire after ${INVITATION_TTL_DAYS} days.`} />
      <Card title="Invite">
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
            Role
            <select name="role" className={selectCls} defaultValue="member">
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </label>
        </ActionForm>
        <p className={`mt-2 ${noteCls}`}>
          The person signs in with the invited address (magic link, Google or GitHub) and joins at once, with a one-time notice
          that names {name} and its visibility mode. The team becomes their primary team.
        </p>
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
                      {i.role} · team {i.teamRole}
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>{formatDateTime(i.expiresMs)}</td>
                    <td className={tdCls}>{i.invitedBy ?? 'a former member'}</td>
                    <td className={tdCls}>
                      <Confirm label="Revoke…" warning={`Revoke the invitation for ${i.email}?`} action={revokeInvitationAction} confirmLabel="Revoke">
                        <input type="hidden" name="invitationId" value={i.id} />
                      </Confirm>
                    </td>
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
