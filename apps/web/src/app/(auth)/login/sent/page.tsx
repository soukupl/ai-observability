import Link from 'next/link';
import { AuthCard } from '../../ui';

export const metadata = { title: 'Check your e-mail' };

export default function LinkSentPage() {
  return (
    <AuthCard title="Check your e-mail">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        If the address is valid, a sign-in link is on its way. It works once and expires in 15 minutes.
      </p>
      <Link href="/login" className="text-sm underline underline-offset-4">
        Use a different e-mail
      </Link>
    </AuthCard>
  );
}
