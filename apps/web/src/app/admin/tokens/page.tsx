import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { createTokenAction } from '@/lib/admin/actions/tokens';
import { requireAdminOrLead } from '@/lib/admin/guard';
import { isAdmin } from '@/lib/admin/permissions';
import { listTokens } from '@/lib/admin/tokens';
import { withUserDb } from '@/lib/auth/rls';
import { CompanyScopeProvider } from '../_components/CompanyScope';
import { TokenCreateForm } from '../_components/TokenCreateForm';
import { TokenFields } from '../_components/TokenFields';
import { TokenTable } from '../_components/TokenTable';
import { noteCls } from '../_components/ui';

export const metadata = { title: 'Tokens' };

/** Admins: every token of the active company. Leads: its company tokens (RLS decides the list). */
export default async function AdminTokensPage() {
  const user = await requireAdminOrLead();
  const tokens = await withUserDb(user, (tx) => listTokens(tx, user.companyId));
  const name = user.company.name;

  return (
    <CompanyScopeProvider companyId={user.companyId}>
      <div className="space-y-4">
        <PageHeader
          title="Company tokens"
          description={
            isAdmin(user)
              ? `All ingest tokens of ${name}. Company tokens are for CI, bots and rollouts; user tokens tie turns to one person.`
              : `Company tokens of ${name}.`
          }
        />
        <Card
          title="New company token"
          description={`For CI, bots and MDM or dotfiles rollout in ${name}. Events are matched to people by git e-mail among the company's members; others are unverified.`}
        >
          <TokenCreateForm action={createTokenAction} submitLabel="Create company token">
            <TokenFields kind="company" />
          </TokenCreateForm>
          <p className={`mt-2 ${noteCls}`}>
            Personal tokens are created on <a href="/tokens" className="text-blue-700 hover:underline dark:text-blue-400">My tokens</a>.
          </p>
        </Card>
        <Card title="Tokens">
          <TokenTable tokens={tokens} viewer={user} />
        </Card>
      </div>
    </CompanyScopeProvider>
  );
}
