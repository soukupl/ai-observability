import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthConfigError, reportAuthConfigError, sessionSecret, SIGNUP_COOKIE } from '@/lib/auth/config';
import { defaultAuthDeps, listPendingInvitations, type PendingSignup } from '@/lib/auth/login';
import { verifyPayload } from '@/lib/auth/tokens';
import { AuthCard, inputClass, Notice, primaryButton, secondaryButton } from '../ui';

export const metadata = { title: 'Create your workspace' };

const ERRORS: Record<string, string> = {
  invalid: 'Enter your name and a company name (up to 100 characters).',
  invitation: 'That invitation is no longer available (expired or withdrawn). Pick another option.',
};

function readPending(value: string | undefined): PendingSignup | null | 'config' {
  try {
    return verifyPayload<PendingSignup>(value, sessionSecret());
  } catch (err) {
    if (!(err instanceof AuthConfigError)) throw err;
    reportAuthConfigError(err);
    return 'config';
  }
}

/**
 * The sign-up step for a verified e-mail with no account: join one of its pending invitations (each
 * shows the company and who invited you; nothing is joined without this click, SEC-1) or create a
 * solo workspace.
 */
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const pending = readPending((await cookies()).get(SIGNUP_COOKIE)?.value);
  if (pending === 'config') redirect('/login?error=config');
  if (!pending) redirect('/login?error=signup_expired');
  const invitations = await listPendingInvitations(defaultAuthDeps(), pending.email);
  const invited = invitations.length > 0;

  return (
    <AuthCard title={invited ? 'Join your team' : 'Create your workspace'}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Signed in as <span className="font-medium text-zinc-900 dark:text-zinc-100">{pending.email}</span>.
      </p>
      {error && <Notice tone="error">{ERRORS[error] ?? ERRORS.invalid}</Notice>}
      {invited && (
        <section className="flex flex-col gap-3" aria-labelledby="invitations-heading">
          <h2 id="invitations-heading" className="text-sm font-medium">
            {invitations.length === 1 ? 'You have an invitation' : `You have ${invitations.length} invitations`}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Join only a company you recognise: its admins will see the usage you report there.
          </p>
          <ul className="flex flex-col gap-3">
            {invitations.map((inv) => (
              <li key={inv.invitationId} className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                <p className="text-sm">
                  <span className="font-medium">{inv.companyName}</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    Invited by {inviterLabel(inv.invitedByName, inv.invitedByEmail)}
                    {inv.teamName ? ` · team ${inv.teamName}${inv.teamRole === 'lead' ? ' (lead)' : ''}` : ''}
                    {inv.companyRole === 'admin' ? ' · company admin' : ''}
                  </span>
                </p>
                <form method="post" action="/api/auth/signup">
                  <input type="hidden" name="invitation" value={inv.invitationId} />
                  <button type="submit" className={primaryButton}>
                    Join {inv.companyName}
                  </button>
                </form>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            or create your own workspace
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>
        </section>
      )}
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        A new workspace starts on the Free plan with one team; you can invite colleagues later.
      </p>
      <form method="post" action="/api/auth/signup" className="flex flex-col gap-3">
        <label htmlFor="name" className="text-sm font-medium">
          Your name
        </label>
        <input id="name" name="name" required maxLength={100} defaultValue={pending.name ?? ''} autoComplete="name" className={inputClass} />
        <label htmlFor="company" className="text-sm font-medium">
          Company or workspace name
        </label>
        <input id="company" name="company" required maxLength={100} autoComplete="organization" className={inputClass} />
        <button type="submit" className={invited ? secondaryButton : primaryButton}>
          Create workspace
        </button>
      </form>
    </AuthCard>
  );
}

function inviterLabel(name: string | null, email: string | null): string {
  if (name && email) return `${name} (${email})`;
  return name ?? email ?? 'an administrator';
}
