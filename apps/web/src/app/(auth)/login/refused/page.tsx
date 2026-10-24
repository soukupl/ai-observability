import Link from 'next/link';
import { deploymentName } from '@/lib/auth/deployment';
import { AuthCard, Notice } from '../../ui';

export const metadata = { title: 'No access' };

/**
 * The refusal page of login provisioning (ADR-0028 E6): the verified e-mail is not a member, not in ADMIN_EMAILS, has
 * no open invitation and its domain is not in ALLOWED_EMAIL_DOMAINS (`not-invited`), or its membership was removed and
 * nobody re-invited it (`removed`). No account was created.
 */
export default async function RefusedPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  const brand = await deploymentName();
  return (
    <AuthCard title="No access" brand={brand}>
      <Notice tone="error">
        {reason === 'removed'
          ? `Your access to ${brand} was removed.`
          : `Your e-mail address has no access to ${brand}.`}
      </Notice>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Ask an admin of {brand} to invite this address, then sign in again with the same e-mail. No account was created.
      </p>
      <Link href="/login" className="text-sm underline underline-offset-4">
        Back to sign in
      </Link>
    </AuthCard>
  );
}
