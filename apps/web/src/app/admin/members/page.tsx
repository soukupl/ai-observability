import Link from 'next/link';
import { Badge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { formatDateTime } from '@/components/format';
import { changeRoleAction, removeMemberAction } from '@/lib/admin/actions/members';
import { requireAdminPage } from '@/lib/admin/guard';
import { listMembers } from '@/lib/admin/members';
import { withUserDb } from '@/lib/auth/rls';
import { ActionForm } from '../_components/ActionForm';
import { Confirm } from '../_components/Confirm';
import { noteCls, selectCls, tableCls, tableWrapCls, tdCls, thCls, trCls } from '../_components/ui';

export const metadata = { title: 'Members' };

const Hidden = ({ n, v }: { n: string; v: string }) => <input type="hidden" name={n} value={v} />;

export default async function MembersPage() {
  const user = await requireAdminPage();
  const members = await withUserDb(user, (tx) => listMembers(tx));
  const name = user.deployment.name;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Members"
        description="Roles and removal. Team memberships are managed on the Teams page; new people join through Invitations, ADMIN_EMAILS or ALLOWED_EMAIL_DOMAINS."
        actions={
          <Link href="/admin/invitations" className="text-sm text-blue-700 hover:underline dark:text-blue-400">
            Invite someone →
          </Link>
        }
      />
      <Card title={`Members (${members.length})`}>
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                {['Name', 'Role', 'Teams', 'Joined', ''].map((h) => (
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
                        <select name="role" defaultValue={m.role} aria-label={`Role of ${m.email}`} className={`${selectCls} w-28`}>
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
                    <td className={`${tdCls} whitespace-nowrap`}>{formatDateTime(m.joinedMs)}</td>
                    <td className={tdCls}>
                      {!self && (
                        <Confirm
                          label="Remove…"
                          warning={`${m.email} loses access to ${name}: their team memberships and per-user budgets are deleted and their tokens are revoked. Their recorded activity is kept. Only a new invitation lets them back in.`}
                          action={removeMemberAction}
                          confirmLabel="Remove member"
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
