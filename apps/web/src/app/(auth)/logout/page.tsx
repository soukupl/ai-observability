import { logout } from '@/lib/auth/actions';
import { AuthCard, primaryButton } from '../ui';

export const metadata = { title: 'Sign out' };

export default function LogoutPage() {
  return (
    <AuthCard title="Sign out">
      <form action={logout}>
        <button type="submit" className={primaryButton}>
          Sign out
        </button>
      </form>
    </AuthCard>
  );
}
