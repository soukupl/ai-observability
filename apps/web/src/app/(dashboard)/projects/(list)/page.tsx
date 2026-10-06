import { Card } from '@/components/Card';
import { DataTable } from '@/components/DataTable';
import { exportUrl } from '@/components/export-url';
import { FilterBar } from '@/components/FilterBar';
import { PageHeader } from '@/components/PageHeader';
import { requireUser } from '@/lib/auth/session';
import { parseFilters } from '@/lib/filters';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { withDashboardContext } from '@/lib/queries/page';
import { getProjects } from '@/lib/queries/projects';
import { canSeeUsers } from '@/lib/queries/scope';
import { PROJECT_COLUMNS, projectTableRows } from '../helpers';

export const metadata = { title: 'Projects' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProjectsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const f = parseFilters(await searchParams, { allowUser: canSeeUsers(user) });
  const { options, result } = await withDashboardContext(user, async (ctx) => ({
    options: await loadFilterOptions(ctx),
    result: await getProjects(ctx, f),
  }));
  const unnamed = options.projects.some((p) => p.name.startsWith('sha256:'));
  const skipped = result.rows.some((r) => r.costSkipped && r.projectId);

  return (
    <>
      <PageHeader title="Projects" description="Tokens, ≈ cost at API list prices and outcomes per project, largest first. Open a project for its detail." />
      <FilterBar filters={f} options={options} />
      <Card>
        {unnamed && (
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">Some projects show a short hash: admins can name them in Admin → Projects.</p>
        )}
        {result.ignoredFilters.length > 0 && (
          <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">Not applied to this table: {result.ignoredFilters.join(', ')}.</p>
        )}
        {skipped && <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">Cost is only computed for the 40 largest projects; others show n/a.</p>}
        <DataTable
          caption="Projects"
          columns={PROJECT_COLUMNS}
          rows={projectTableRows(result.rows, f)}
          rowKey="id"
          defaultSort={{ key: 'tokens', dir: 'desc' }}
          exportHref={exportUrl('projects', f)}
          emptyMessage="No projects have reported turns in this range. Try a longer range, or check that the collector is installed."
        />
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Success = successful / turns with a known outcome; the unknown share is shown beside it. Cost is ≈ at API list prices.
        </p>
      </Card>
    </>
  );
}
