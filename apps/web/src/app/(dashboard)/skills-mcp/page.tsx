import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar } from '@/components/FilterBar';
import { KpiTile } from '@/components/KpiTile';
import { PageHeader } from '@/components/PageHeader';
import { exportUrl } from '@/components/export-url';
import { formatInt, formatPercent } from '@/components/format';
import { TokensAreaChart } from '@/components/charts/TokensAreaChart';
import { requireUser } from '@/lib/auth/session';
import { parseFilters } from '@/lib/filters';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { withDashboardContext } from '@/lib/queries/page';
import { addDays } from '@/lib/queries/range';
import { canSeeUsers, isLead } from '@/lib/queries/scope';
import { getSkillsMcp } from '@/lib/queries/skills-mcp';
import { anyHashed, daySeries, displayName, skillTableRows, totals } from './skills-mcp-view';

export const metadata = { title: 'Skills & MCP' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const SKILL_COLUMNS: Column[] = [
  { key: 'name', header: 'Skill', kind: 'text', align: 'left' },
  { key: 'calls', header: 'Uses', kind: 'int', align: 'right' },
  { key: 'modelCalls', header: 'By the model', kind: 'int', align: 'right', hint: 'The agent picked the skill up itself (Skill tool; in Codex, reading its SKILL.md).' },
  { key: 'userCalls', header: 'Typed by user', kind: 'int', align: 'right', hint: 'The user typed /skill-name (Claude Code).' },
  { key: 'userShare', header: 'Typed share', kind: 'percent', align: 'right', hint: 'Uses the user had to ask for / all uses.' },
  { key: 'turns', header: 'Turns', kind: 'int', align: 'right', hint: 'Turns that used the skill (main agent or a sub-agent).' },
];
const USERS_COLUMN: Column = { key: 'users', header: 'Users', kind: 'int', align: 'right', hint: 'Distinct users (unverified team-token turns have none).' };

const th = 'px-2 py-1.5 font-medium';
/** `1 call`, `3 calls` */
const count = (n: number, word: string) => `${formatInt(n)} ${word}${n === 1 ? '' : 's'}`;
const td = 'px-2 py-1.5 tabular-nums';

export default async function SkillsMcpPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const filters = parseFilters(await searchParams, { allowUser: canSeeUsers(user) });
  const { options, data } = await withDashboardContext(user, async (ctx) => ({
    options: await loadFilterOptions(ctx),
    data: await getSkillsMcp(ctx, filters),
  }));
  // A user count only means something to someone who sees more than their own turns.
  const showUsers = user.companyRole === 'admin' || isLead(user);
  const t = totals(data);
  const skillSeries = daySeries(data, 'skill');
  const mcpSeries = daySeries(data, 'mcp');
  const source = data.range.source === 'raw' ? 'raw turns' : 'daily rollups';
  const empty = data.skills.length === 0 && data.servers.length === 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Skills & MCP"
        description={`Skill uses and MCP calls, ${data.range.fromDay} to ${addDays(data.range.toDay, -1)} (UTC). Read from ${source}; main agent and sub-agents together.`}
      />
      <FilterBar filters={filters} options={options} />
      {data.ignoredFilters.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="note">
          Not applied to skill and MCP figures: {data.ignoredFilters.join(', ')}.
        </p>
      )}
      {anyHashed(data) && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400" role="note">
          Your company hashes project names, so skill, MCP server and tool names are hashed on the developer&apos;s machine too.
        </p>
      )}
      {empty ? (
        <Card>
          <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No skill uses or MCP calls for this selection. Turns recorded by collectors older than this feature carry none.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile label="Skill uses" value={formatInt(t.skillUses)} sub={count(data.skills.length, 'skill')} />
            <KpiTile
              label="Typed by users"
              value={t.typedShare === null ? 'n/a' : formatPercent(t.typedShare)}
              sub="of skill uses were /typed"
              title="Share of skill uses the user started by typing /skill-name rather than the agent picking the skill up."
            />
            <KpiTile label="MCP calls" value={formatInt(t.mcpCalls)} sub={`${count(data.servers.length, 'server')}, ${count(t.mcpTools, 'tool')}`} />
          </div>

          <Card title="Skills" description="Most used first.">
            {data.skills.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No skill uses in this selection.</p>
            ) : (
              <DataTable
                columns={showUsers ? [...SKILL_COLUMNS, USERS_COLUMN] : SKILL_COLUMNS}
                rows={skillTableRows(data)}
                exportHref={exportUrl('skills-mcp', filters)}
              />
            )}
          </Card>
          {skillSeries.series.length > 0 && (
            <Card title="Skill uses per day" description="The most used skills; the rest as other.">
              <TokensAreaChart data={skillSeries.data} series={skillSeries.series} valueFormat="int" ariaLabel="Stacked area chart of skill uses per day by skill" />
            </Card>
          )}

          <Card title="MCP servers" description="Most called first. Open a server to see its tools.">
            {data.servers.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No MCP calls in this selection.</p>
            ) : (
              <div className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {data.servers.map((s) => (
                  <details key={s.name} className="group py-1">
                    <summary className="flex cursor-pointer list-none items-center gap-3 rounded px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                      <span className="w-3 text-zinc-400 transition-transform group-open:rotate-90" aria-hidden>
                        ▸
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium text-zinc-900 dark:text-zinc-100" title={s.name}>
                        {displayName(s.name)}
                      </span>
                      <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{count(s.calls, 'call')}</span>
                      <span className="hidden w-20 text-right tabular-nums text-zinc-500 sm:inline dark:text-zinc-400">{count(s.tools.length, 'tool')}</span>
                      <span className="hidden w-24 text-right tabular-nums text-zinc-500 sm:inline dark:text-zinc-400">{count(s.turns, 'turn')}</span>
                      {showUsers && (
                        <span className="hidden w-20 text-right tabular-nums text-zinc-500 sm:inline dark:text-zinc-400">{count(s.users, 'user')}</span>
                      )}
                    </summary>
                    <div className="overflow-x-auto pl-7">
                      <table className="w-full text-xs">
                        <thead className="text-left text-zinc-500 dark:text-zinc-400">
                          <tr>
                            <th className={th}>Tool</th>
                            <th className={`${th} text-right`}>Calls</th>
                            <th className={`${th} text-right`}>Turns</th>
                            {showUsers && <th className={`${th} text-right`}>Users</th>}
                          </tr>
                        </thead>
                        <tbody className="text-zinc-700 dark:text-zinc-300">
                          {s.tools.map((tool) => (
                            <tr key={tool.tool}>
                              <td className="px-2 py-1.5" title={tool.tool}>
                                {displayName(tool.tool)}
                              </td>
                              <td className={`${td} text-right`}>{formatInt(tool.calls)}</td>
                              <td className={`${td} text-right`}>{formatInt(tool.turns)}</td>
                              {showUsers && <td className={`${td} text-right`}>{formatInt(tool.users)}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </Card>
          {mcpSeries.series.length > 0 && (
            <Card title="MCP calls per day" description="The most called servers; the rest as other.">
              <TokensAreaChart data={mcpSeries.data} series={mcpSeries.series} valueFormat="int" ariaLabel="Stacked area chart of MCP calls per day by server" />
            </Card>
          )}
        </div>
      )}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        A turn counts once per skill or server however often it was used. Skills typed by the user are recorded for Claude Code; Codex
        records only skills the agent opens itself.
      </p>
    </div>
  );
}
