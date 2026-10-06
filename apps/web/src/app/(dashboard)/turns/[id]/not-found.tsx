import Link from 'next/link';
import { PageHeader } from '@/components/PageHeader';

export default function TurnNotFound() {
  return (
    <>
      <PageHeader title="Turn not found" description="It does not exist, is outside your visibility, or has been removed by retention." />
      <Link href="/turns" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-400">
        Back to all turns
      </Link>
    </>
  );
}
