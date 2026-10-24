import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { safeNext } from '@/lib/auth/tokens';
import { AuthCard, Notice, primaryButton } from '../ui';

export const metadata = { title: 'Welcome' };

/**
 * The one-time notice after joining (ADR-0028 E7): login provisioning lands here once, when it created the membership
 * (an auto-accepted invitation, ADMIN_EMAILS or ALLOWED_EMAIL_DOMAINS). It names the deployment and what the
 * visibility mode means for the new member's data. Later logins go straight to the dashboard.
 */
export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const next = safeNext((await searchParams).next) ?? '/overview';
  const { name, settings } = user.deployment;
  const full = settings.individualVisibility === 'full';
  return (
    <AuthCard title={`Welcome to ${name}`} brand={name}>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        You joined {name} as {user.role === 'admin' ? 'an admin' : 'a member'}
        {user.teams.length > 0 ? ` of ${user.teams.map((t) => t.name).join(', ')}` : ''}.
      </p>
      <Notice tone="info">
        {full
          ? `Visibility: full. Admins of ${name} and the leads of your teams can see your individual turns, sessions and costs.`
          : `Visibility: aggregates only. Others in ${name} see your usage only inside team and deployment totals; only you see your individual turns.`}
      </Notice>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        To send data, run <code className="font-mono">npx ai-obs-cli login</code> on your computer and approve the code on the page it opens.
      </p>
      <Link href={next} className={`${primaryButton} block text-center`}>
        Continue
      </Link>
    </AuthCard>
  );
}
