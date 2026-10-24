import Link from 'next/link';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { requireAdminPage } from '@/lib/admin/guard';
import { listTokens } from '@/lib/admin/tokens';
import { withUserDb } from '@/lib/auth/rls';
import { TokenTable } from '../_components/TokenTable';
import { noteCls } from '../_components/ui';

export const metadata = { title: 'Tokens' };

/**
 * Every ingest token of every user, people and service users (ADR-0029 T8, ADR-0022 D6), with source, label, expiry
 * and revoke. People create their own tokens (My tokens or `ai-obs login`); service-user tokens are created on the
 * Service users page.
 */
export default async function AdminTokensPage() {
  const user = await requireAdminPage();
  const tokens = await withUserDb(user, (tx) => listTokens(tx));
  const live = tokens.filter((t) => !t.revokedMs && (t.expiresMs === null || t.expiresMs > Date.now())).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Tokens"
        description={`Every collector token in ${user.deployment.name}: ${live} live of ${tokens.length}. Device logins expire after 90 days; manual tokens after the lifetime chosen at creation.`}
      />
      <Card title="All tokens">
        <TokenTable tokens={tokens} viewer={user} />
        <p className={`mt-2 ${noteCls}`}>
          Create tokens for CI and bots on{' '}
          <Link href="/admin/service-users" className="text-blue-700 hover:underline dark:text-blue-400">
            Service users
          </Link>
          . Your own tokens are on{' '}
          <Link href="/tokens" className="text-blue-700 hover:underline dark:text-blue-400">
            My tokens
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
