import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { acceptInvitationForCurrentUser } from '@/lib/auth/actions';
import { defaultAuthDeps, listPendingInvitations } from '@/lib/auth/login';
import { requireUser } from '@/lib/auth/session';

export const metadata = { title: 'Invitations' };

function inviterLabel(name: string | null, email: string | null): string {
  if (name && email) return `${name} (${email})`;
  return name ?? email ?? 'a former member';
}

/**
 * Invitations from other companies to the signed-in user's e-mail (ADR-0022, D9). Joining is an explicit
 * click per invitation (SEC-1): it adds a membership to this account, switches to that company and
 * lands on its overview. Companies the user already belongs to are not listed (auth_pending_invitations).
 */
export default async function InvitationsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const user = await requireUser();
  const invitations = await listPendingInvitations(defaultAuthDeps(), user.email);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Invitations"
        description={`Invitations to ${user.email} from other companies. Joining adds the company to your account; switch between companies in the header.`}
      />
      {error === 'gone' && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          That invitation is no longer available (expired, withdrawn or the company is full).
        </p>
      )}
      <Card title="Pending invitations" description="Join only a company you recognise: its admins will see the usage you report there.">
        {invitations.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No pending invitations.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {invitations.map((inv) => (
              <li key={inv.invitationId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <p className="min-w-0 text-sm">
                  <span className="font-medium">{inv.companyName}</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    Invited by {inviterLabel(inv.invitedByName, inv.invitedByEmail)}
                    {inv.teamName ? ` · team ${inv.teamName}${inv.teamRole === 'lead' ? ' (lead)' : ''}` : ''}
                    {inv.companyRole === 'admin' ? ' · company admin' : ''}
                  </span>
                </p>
                <form action={acceptInvitationForCurrentUser}>
                  <input type="hidden" name="invitationId" value={inv.invitationId} />
                  <button
                    type="submit"
                    className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    Join {inv.companyName}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
