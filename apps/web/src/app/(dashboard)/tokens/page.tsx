import Link from 'next/link';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { createTokenAction } from '@/lib/admin/actions/tokens';
import { canEnterAdmin } from '@/lib/admin/permissions';
import { listTokens } from '@/lib/admin/tokens';
import { withUserDb } from '@/lib/auth/rls';
import { requireUser } from '@/lib/auth/session';
import { CompanyScopeProvider } from '../../admin/_components/CompanyScope';
import { TokenCreateForm } from '../../admin/_components/TokenCreateForm';
import { TokenFields } from '../../admin/_components/TokenFields';
import { TokenTable } from '../../admin/_components/TokenTable';

export const metadata = { title: 'My tokens' };

/** Self-service: every user creates and revokes their own collector tokens in the active company (BRIEF §4). */
export default async function MyTokensPage() {
  const user = await requireUser();
  const tokens = await withUserDb(user, (tx) => listTokens(tx, user.companyId, { onlyUserId: user.id }));
  const company = user.company;

  return (
    <CompanyScopeProvider companyId={user.companyId}>
      <div className="space-y-4">
        <PageHeader
          title="My tokens"
          description={`Tokens for ${company.name} (${company.slug}). Switch company in the header for another company. A user token ties everything the collector sends to you; use one per machine so you can revoke a single laptop.`}
          actions={
            canEnterAdmin(user) ? (
              <Link href="/admin/tokens" className="text-sm text-blue-700 hover:underline dark:text-blue-400">
                Company tokens →
              </Link>
            ) : undefined
          }
        />
        <Card title="New user token" description="Turns are attributed to you; their team is the project's mapped team, else your primary team in this company.">
          <TokenCreateForm action={createTokenAction} submitLabel="Create token">
            <TokenFields kind="user" />
          </TokenCreateForm>
        </Card>
        <Card title="Your tokens">
          <TokenTable tokens={tokens} viewer={user} showOwner={false} />
        </Card>
      </div>
    </CompanyScopeProvider>
  );
}
