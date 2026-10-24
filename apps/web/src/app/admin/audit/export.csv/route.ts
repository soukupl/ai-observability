import { audit, auditCsv, AUDIT_EXPORT_LIMIT, listAuditLog } from '@/lib/admin/audit';
import { withUserDb } from '@/lib/auth/rls';
import { getCurrentUser } from '@/lib/auth/session';
import { csvStream } from '@/lib/csv';

export const dynamic = 'force-dynamic';

/**
 * GET /admin/audit/export.csv — the newest 10,000 audit entries as CSV (admins only). The shell's
 * /api/export has no 'audit' view, so this route records its own `export` audit row.
 */
export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response('unauthorized', { status: 401 });
  if (user.role !== 'admin') return new Response('forbidden', { status: 403 });
  const table = await withUserDb(user, async (tx) => {
    const { rows } = await listAuditLog(tx, { page: 1, pageSize: AUDIT_EXPORT_LIMIT, limit: AUDIT_EXPORT_LIMIT });
    const t = auditCsv(rows);
    await audit(tx, user, 'export', 'audit', { rows: t.rows.length });
    return t;
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(csvStream(table.headers, table.rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ai-obs-audit-${day}.csv"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
