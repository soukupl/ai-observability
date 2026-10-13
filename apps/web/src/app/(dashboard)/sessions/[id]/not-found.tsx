import Link from 'next/link';
import { PageHeader } from '@/components/PageHeader';

export default function SessionNotFound() {
  return (
    <>
      <PageHeader
        title="Session not found"
        description="It does not exist, is outside your visibility (in aggregates-only mode only your own sessions are shown), or has been removed by retention."
      />
      <Link href="/sessions" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-400">
        Back to all sessions
      </Link>
    </>
  );
}
