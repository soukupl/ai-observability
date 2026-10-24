import { PageHeader } from '@/components/PageHeader';
import { appUrl } from '@/lib/auth/config';
import { requireUser } from '@/lib/auth/session';
import { DeviceApproval } from './DeviceApproval';

export const metadata = { title: 'Approve a collector login' };

/**
 * Device login approval (ADR-0029 T4, brief Appendix B). `ai-obs login` prints a code and opens this page; the
 * signed-in person types the code (XXXX-XXXX or XXXXXXXX), checks the client name, requester IP and age, then
 * approves or denies. The token is minted for the approving person when the CLI polls next (90 days, source device).
 * Unauthenticated visitors are sent to /login?next=/device by the proxy. The code is posted, never taken from the URL
 * (a link cannot skip typing it), and every step spends the per-user wrong-code budget (lib/auth/device-actions.ts).
 */
export default async function DevicePage() {
  const user = await requireUser();
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader
        title="Approve a collector login"
        description={`Logs a collector in to ${user.deployment.name} as you (${user.email}). The token it receives expires after 90 days.`}
      />
      <DeviceApproval origin={appUrl().origin} />
    </div>
  );
}
