import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { createTokenAction } from '@/lib/admin/actions/tokens';
import { requireAdminOrLead } from '@/lib/admin/guard';
import { isAdmin, tokenTeams } from '@/lib/admin/permissions';
import { listTeamsWithMembers } from '@/lib/admin/teams';
import { listTokens } from '@/lib/admin/tokens';
import { withUserDb } from '@/lib/auth/rls';
import { TokenCreateForm } from '../_components/TokenCreateForm';
import { TokenFields } from '../_components/TokenFields';
import { TokenTable } from '../_components/TokenTable';
import { noteCls } from '../_components/ui';

export const metadata = { title: 'Tokens' };

/** Admins: every token. Leads: team tokens of their teams + their own (RLS decides the list). */
export default async function AdminTokensPage() {
  const user = await requireAdminOrLead();
  const { tokens, teams } = await withUserDb(user, async (tx) => ({
    tokens: await listTokens(tx, user.companyId),
    teams: await listTeamsWithMembers(tx, user.companyId),
  }));
  const allowed = new Set(tokenTeams(user, 'team', teams.map((t) => t.id)));
  const teamChoices = teams.filter((t) => allowed.has(t.id)).map((t) => ({ id: t.id, name: t.name }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Collector tokens"
        description={
          isAdmin(user)
            ? 'All ingest tokens of the company. User tokens tie turns to one person; team tokens are for shared rollouts and match people by git e-mail.'
            : 'Team tokens of the teams you lead, and your own user tokens.'
        }
      />
      <Card
        title="New team token"
        description="For MDM or dotfiles rollout to a whole team. Turns are matched to people by git e-mail; unmatched turns stay unverified."
      >
        {teamChoices.length === 0 ? (
          <p className={noteCls}>You lead no team.</p>
        ) : (
          <TokenCreateForm action={createTokenAction} submitLabel="Create team token">
            <TokenFields kind="team" teams={teamChoices} />
          </TokenCreateForm>
        )}
        <p className={`mt-2 ${noteCls}`}>
          Personal tokens are created on <a href="/tokens" className="text-blue-700 hover:underline dark:text-blue-400">My tokens</a>.
        </p>
      </Card>
      <Card title="Tokens">
        <TokenTable tokens={tokens} viewer={user} />
      </Card>
    </div>
  );
}
