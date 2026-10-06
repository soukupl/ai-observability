import { dbFor } from '@ai-obs/db';
import { csvStream } from '@/lib/csv';
import { getCurrentUser } from '@/lib/auth/session';
import { listCompanies } from '@/lib/platform/companies';

export const dynamic = 'force-dynamic';

/** GET /super/export — companies as CSV (super admins only; anyone else gets 404). Contains no telemetry. */
export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  if (!user?.isSuperAdmin) return new Response('Not found', { status: 404 });
  const rows = await listCompanies(dbFor('platform'), { limit: 5000 });
  const body = csvStream(
    ['name', 'slug', 'plan', 'status', 'created_at', 'users', 'teams', 'admin_emails'],
    rows.map((r) => [r.name, r.slug, r.plan, r.status, new Date(r.createdAt).toISOString(), r.users, r.teams, r.adminEmails.join('; ')]),
  );
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="companies.csv"',
      'cache-control': 'no-store',
    },
  });
}
