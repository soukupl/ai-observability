import { Badge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import {
  createServiceUserAction,
  disableServiceUserAction,
  renameServiceUserAction,
  setServicePrimaryTeamAction,
} from '@/lib/admin/actions/service-users';
import { createServiceTokenAction } from '@/lib/admin/actions/tokens';
import { requireAdminPage } from '@/lib/admin/guard';
import { listServiceUsers } from '@/lib/admin/service-users';
import { listTeamsWithMembers } from '@/lib/admin/teams';
import { listTokens } from '@/lib/admin/tokens';
import { withUserDb } from '@/lib/auth/rls';
import { ActionForm } from '../_components/ActionForm';
import { Confirm } from '../_components/Confirm';
import { TokenCreateForm } from '../_components/TokenCreateForm';
import { TokenFields } from '../_components/TokenFields';
import { TokenTable } from '../_components/TokenTable';
import { inputCls, labelCls, noteCls, selectCls } from '../_components/ui';

export const metadata = { title: 'Service users' };

const Hidden = ({ n, v }: { n: string; v: string }) => <input type="hidden" name={n} value={v} />;

/**
 * Service users (brief Q9, ADR-0029 T7): CI runners, bots and shared machines. They never log in; admins create
 * their tokens here. Their turns are attributed to the service user like any person's.
 */
export default async function ServiceUsersPage() {
  const user = await requireAdminPage();
  const { serviceUsers, teams, tokens } = await withUserDb(user, async (tx) => ({
    serviceUsers: await listServiceUsers(tx),
    teams: await listTeamsWithMembers(tx),
    tokens: await listTokens(tx),
  }));
  const now = Date.now();
  const teamOptions = teams.map((t) => (
    <option key={t.id} value={t.id}>
      {t.name}
    </option>
  ));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Service users"
        description="For CI, bots and shared machines: a name and a primary team, no login. Their sessions land in the project's mapped team, else their primary team."
      />
      <Card title="New service user">
        <ActionForm action={createServiceUserAction} submitLabel="Create service user">
          <label className={`${labelCls} grow sm:max-w-xs`}>
            Name
            <input name="name" required maxLength={80} placeholder="e.g. GitHub Actions" className={inputCls} />
          </label>
          <label className={labelCls}>
            Primary team
            <select name="primaryTeamId" className={selectCls} defaultValue={teams[0]?.id ?? ''}>
              <option value="">(no team)</option>
              {teamOptions}
            </select>
          </label>
        </ActionForm>
      </Card>

      {serviceUsers.length === 0 && <p className={noteCls}>No service users yet.</p>}
      {serviceUsers.map((s) => {
        const own = tokens.filter((t) => t.userId === s.id);
        return (
          <Card
            key={s.id}
            title={s.name}
            description={`${s.teams.length ? s.teams.map((t) => t.name).join(', ') : 'no team'} · ${s.liveTokens} live token(s)`}
            actions={
              s.disabled ? (
                <Badge>disabled</Badge>
              ) : (
                <Confirm
                  label="Disable…"
                  warning={`Disable "${s.name}"? Every token is revoked and it leaves all teams. Its recorded turns stay. Set a primary team and create a token to use it again.`}
                  action={disableServiceUserAction}
                  confirmLabel="Disable"
                >
                  <Hidden n="userId" v={s.id} />
                </Confirm>
              )
            }
          >
            <div className="mb-3 flex flex-wrap gap-4">
              <ActionForm action={renameServiceUserAction} submitLabel="Rename" tone="subtle">
                <Hidden n="userId" v={s.id} />
                <label className={`${labelCls} sm:max-w-xs`}>
                  Name
                  <input name="name" required maxLength={80} defaultValue={s.name} className={inputCls} />
                </label>
              </ActionForm>
              <ActionForm action={setServicePrimaryTeamAction} submitLabel="Set" tone="subtle">
                <Hidden n="userId" v={s.id} />
                <label className={labelCls}>
                  Primary team
                  <select name="teamId" className={selectCls} defaultValue={s.primaryTeamId ?? ''}>
                    <option value="">(no team)</option>
                    {teamOptions}
                  </select>
                </label>
              </ActionForm>
            </div>
            <div className="mb-3">
              <TokenCreateForm action={createServiceTokenAction} submitLabel="Create token">
                <TokenFields userId={s.id} placeholder="e.g. CI runners" />
              </TokenCreateForm>
            </div>
            <TokenTable tokens={own} viewer={user} showOwner={false} nowMs={now} />
          </Card>
        );
      })}
    </div>
  );
}
