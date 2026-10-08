import Link from 'next/link';
import { PageHeader } from '@/components/PageHeader';

export default function FlowNotFound() {
  return (
    <>
      <PageHeader
        title="Agent flow not found"
        description="It does not exist, has fewer than two steps, is outside your visibility, or has been removed by retention."
      />
      <Link href="/flows" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-400">
        Back to all agent flows
      </Link>
    </>
  );
}
