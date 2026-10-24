import Link from 'next/link';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { createOwnTokenAction } from '@/lib/admin/actions/tokens';
import { isAdmin } from '@/lib/admin/permissions';
import { listTokens } from '@/lib/admin/tokens';
import { appUrl } from '@/lib/auth/config';
import { withUserDb } from '@/lib/auth/rls';
import { requireUser } from '@/lib/auth/session';
import { TokenCreateForm } from '../../admin/_components/TokenCreateForm';
import { TokenFields } from '../../admin/_components/TokenFields';
import { TokenTable } from '../../admin/_components/TokenTable';
import { noteCls } from '../../admin/_components/ui';

export const metadata = { title: 'My tokens' };

/**
 * Self-service tokens (ADR-0029 T5): the device logins made with `ai-obs login` (named by the computer, 90 days) and
 * manual tokens with a lifetime of 30 / 90 / 365 days or none. Everyone revokes their own.
 */
export default async function MyTokensPage() {
  const user = await requireUser();
  const tokens = await withUserDb(user, (tx) => listTokens(tx, { onlyUserId: user.id }));
  const devices = tokens.filter((t) => t.source === 'device');
  const manual = tokens.filter((t) => t.source === 'manual');
  const server = appUrl().origin;
  const now = Date.now();

  return (
    <div className="space-y-4">
      <PageHeader
        title="My tokens"
        description={`Everything a collector sends with these tokens is attributed to you in ${user.deployment.name}. Use one per computer so you can revoke a single machine.`}
        actions={
          isAdmin(user) ? (
            <Link href="/admin/tokens" className="text-sm text-blue-700 hover:underline dark:text-blue-400">
              All tokens →
            </Link>
          ) : undefined
        }
      />
      <Card title="Log in a computer" description="The usual way: no token to copy.">
        <pre className="overflow-x-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-900">
          <code>npx @soukupl/ai-obs login --server {server}</code>
        </pre>
        <p className={`mt-2 ${noteCls}`}>
          It shows a code and opens <Link href="/device" className="text-blue-700 hover:underline dark:text-blue-400">/device</Link>, where you
          approve it. The token expires after 90 days; the collector reminds you 14 days before.
        </p>
      </Card>
      <Card title={`Device logins (${devices.length})`}>
        <TokenTable tokens={devices} viewer={user} showOwner={false} nowMs={now} />
      </Card>
      <Card title="New manual token" description="For a machine where the browser approval does not work. Paste it with `ai-obs login --token`.">
        <TokenCreateForm action={createOwnTokenAction} submitLabel="Create token">
          <TokenFields />
        </TokenCreateForm>
      </Card>
      <Card title={`Manual tokens (${manual.length})`}>
        <TokenTable tokens={manual} viewer={user} showOwner={false} nowMs={now} />
      </Card>
    </div>
  );
}
