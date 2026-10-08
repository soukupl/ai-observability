import { auditLog } from '@ai-obs/db';
import { getCurrentUser } from '@/lib/auth/session';
import { withUserDb } from '@/lib/auth/rls';
import { csvStream } from '@/lib/csv';
import { filtersForAudit, parseFilters } from '@/lib/filters';
import { buildExportTable, isExportView, isPhaseGroup, type ExportOptions } from '@/lib/queries/exports';
import { rangeFor, addDays } from '@/lib/queries/range';
import { canSeeUsers, createQueryContext } from '@/lib/queries/scope';

export const dynamic = 'force-dynamic';

const OUTCOMES = ['success', 'failed', 'abandoned', 'unknown'] as const;

/**
 * GET /api/export?view=<projects|models|phases|agents|turns|flows|overview|budgets>&<filters>
 * Re-runs the view's query under the caller's RLS context and visibility mode (so a CSV can never show
 * more than the screen), streams it as CSV, and records an `export` row in audit_log (BRIEF §8).
 */
export async function GET(req: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response('unauthorized', { status: 401 });
  if (!user.companyId || !user.company) return new Response('forbidden', { status: 403 });

  const params = new URL(req.url).searchParams;
  const view = params.get('view');
  if (!isExportView(view)) return new Response('unknown view', { status: 400 });

  const viewer = { ...user, companyId: user.companyId, company: user.company };
  const filters = parseFilters(params, { allowUser: canSeeUsers(viewer) });
  const opts: ExportOptions = {};
  const group = params.get('group');
  if (view === 'phases' && isPhaseGroup(group)) opts.group = group;
  const outcome = params.get('outcome');
  if ((view === 'turns' || view === 'flows') && (OUTCOMES as readonly string[]).includes(outcome ?? '')) opts.outcome = outcome as (typeof OUTCOMES)[number];

  const companyId = viewer.companyId;
  const { table, range } = await withUserDb(user, async (tx) => {
    const ctx = await createQueryContext(tx, viewer);
    const table = await buildExportTable(ctx, view, filters, opts);
    await tx.insert(auditLog).values({
      companyId,
      actorUserId: user.id,
      action: 'export',
      target: view,
      meta: {
        filters: filtersForAudit(filters),
        ...(opts.group ? { group: opts.group } : {}),
        ...(opts.outcome ? { outcome: opts.outcome } : {}),
        rows: table.rows.length,
        ...(table.truncated ? { truncated: true } : {}),
      },
    });
    return { table, range: rangeFor(ctx, filters) };
  });

  const filename = `ai-obs-${view}-${range.fromDay}_${addDays(range.toDay, -1)}.csv`;
  return new Response(csvStream(table.headers, table.rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // The turns / flows CSV ends with a TRUNCATED marker row when the export cap was hit (DP-11).
      ...(table.truncated ? { 'X-Truncated': 'true' } : {}),
    },
  });
}
