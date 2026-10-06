import Link from 'next/link';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { createTokenAction } from '@/lib/admin/actions/tokens';
import { canEnterAdmin } from '@/lib/admin/permissions';
import { listTokens } from '@/lib/admin/tokens';
import { withUserDb } from '@/lib/auth/rls';
import { requireUser } from '@/lib/auth/session';
import { TokenCreateForm } from '../../admin/_components/TokenCreateForm';
import { TokenFields } from '../../admin/_components/TokenFields';
import { TokenTable } from '../../admin/_components/TokenTable';
import { noteCls } from '../../admin/_components/ui';

export const metadata = { title: 'My tokens' };

/** Self-service: every user creates and revokes their own collector tokens (BRIEF §4). */
export default async function MyTokensPage() {
  const user = await requireUser();
  const tokens = await withUserDb(user, (tx) => listTokens(tx, user.companyId, { onlyUserId: user.id }));
  const teams = user.teams.map((t) => ({ id: t.id, name: t.name }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="My tokens"
        description="A user token ties everything the collector sends to you. Use one per machine so you can revoke a single laptop."
        actions={
          canEnterAdmin(user) ? (
            <Link href="/admin/tokens" className="text-sm text-blue-700 hover:underline dark:text-blue-400">
              Team tokens →
            </Link>
          ) : undefined
        }
      />
      <Card title="New user token" description="Turns are attributed to the selected team unless an admin mapped the project to a team.">
        {teams.length === 0 ? (
          <p className={noteCls}>You are not in any team yet. Ask an admin to add you to one.</p>
        ) : (
          <TokenCreateForm action={createTokenAction} submitLabel="Create token">
            <TokenFields kind="user" teams={teams} defaultTeamId={user.primaryTeamId} />
          </TokenCreateForm>
        )}
      </Card>
      <Card title="Your tokens">
        <TokenTable tokens={tokens} viewer={user} showOwner={false} />
      </Card>
    </div>
  );
}
