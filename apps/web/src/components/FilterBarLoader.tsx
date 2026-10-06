import type { CompanyUser } from '@/lib/auth/session';
import type { Filters } from '@/lib/filters';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { withDashboardContext } from '@/lib/queries/page';
import { FilterBar } from './FilterBar';

/** Convenience for pages that do not already hold a query context: loads the option lists and renders the bar. */
export async function FilterBarLoader({ user, filters }: { user: CompanyUser; filters: Filters }) {
  const options = await withDashboardContext(user, loadFilterOptions);
  return <FilterBar filters={filters} options={options} />;
}
