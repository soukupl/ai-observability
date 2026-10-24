import { redirect } from 'next/navigation';
import { enabledOAuthProviders } from '@/lib/auth/config';
import { deploymentName } from '@/lib/auth/deployment';
import { getCurrentUser } from '@/lib/auth/session';
import { safeNext } from '@/lib/auth/tokens';
import { AuthCard, inputClass, Notice, primaryButton, secondaryButton } from '../ui';

export const metadata = { title: 'Sign in' };

const ERRORS: Record<string, string> = {
  invalid_email: 'Enter a valid e-mail address.',
  rate_limited: 'Too many sign-in links requested. Try again in a few minutes.',
  send_failed: 'We could not send the e-mail. Try again later.',
  link_invalid: 'That sign-in link is invalid, already used or expired. Request a new one.',
  email_unverified: 'Your provider account has no verified e-mail address.',
  oauth_failed: 'Sign-in with the provider failed. Try again.',
  provider_disabled: 'That sign-in provider is not configured.',
  failed: 'Sign-in failed. Try again.',
  config: 'Sign-in is unavailable: the server is not configured correctly. If you run this server, check its logs.',
};

const LABELS = { google: 'Continue with Google', github: 'Continue with GitHub' } as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next: rawNext, error } = await searchParams;
  const next = safeNext(rawNext);
  const user = await getCurrentUser();
  if (user) redirect(next ?? '/overview');
  const brand = await deploymentName();
  const providers = enabledOAuthProviders();
  const query = next ? `?${new URLSearchParams({ next })}` : '';

  return (
    <AuthCard title="Sign in" brand={brand}>
      {error && <Notice tone="error">{ERRORS[error] ?? ERRORS.failed}</Notice>}
      <form method="post" action="/api/auth/magic" className="flex flex-col gap-3">
        <label htmlFor="email" className="text-sm font-medium">
          Work e-mail
        </label>
        <input id="email" name="email" type="email" required autoComplete="email" autoFocus className={inputClass} />
        {next && <input type="hidden" name="next" value={next} />}
        <button type="submit" className={primaryButton}>
          E-mail me a sign-in link
        </button>
      </form>
      {providers.length > 0 && (
        <>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            or
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>
          <div className="flex flex-col gap-2">
            {providers.map((p) => (
              <a key={p} href={`/api/auth/${p}/start${query}`} className={secondaryButton}>
                {LABELS[p]}
              </a>
            ))}
          </div>
        </>
      )}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Invited? Use the e-mail address the invitation was sent to. Without an invitation, ask an admin of {brand} for one.
      </p>
    </AuthCard>
  );
}
