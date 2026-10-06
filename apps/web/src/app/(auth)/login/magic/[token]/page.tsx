import type { Metadata } from 'next';
import Link from 'next/link';
import { isWellFormedToken, safeNext } from '@/lib/auth/tokens';
import { AuthCard, Notice, primaryButton } from '../../../ui';

// same-origin: the token in this URL never leaks in a Referer, while the form POST still carries Origin.
export const metadata: Metadata = { title: 'Sign in', referrer: 'same-origin', robots: { index: false, follow: false } };

/**
 * Confirm step of the e-mailed magic link. Rendering this page does not use the link (mail scanners
 * that prefetch it cannot burn it); the button POSTs to /api/auth/magic/<token>, which consumes it.
 */
export default async function MagicLinkConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { token } = await params;
  const next = safeNext((await searchParams).next);
  if (!isWellFormedToken(token)) {
    return (
      <AuthCard title="Sign in">
        <Notice tone="error">That sign-in link is invalid, already used or expired. Request a new one.</Notice>
        <Link href="/login" className="text-sm underline underline-offset-4">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Sign in">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Continue to sign in with the link from your e-mail. The link works once and expires 15 minutes after it was sent.
      </p>
      <form method="post" action={`/api/auth/magic/${token}`} className="flex flex-col gap-3">
        {next && <input type="hidden" name="next" value={next} />}
        <button type="submit" className={primaryButton}>
          Continue to sign in
        </button>
      </form>
      <Link href="/login" className="text-sm underline underline-offset-4">
        Request a new link
      </Link>
    </AuthCard>
  );
}
