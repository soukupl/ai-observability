import { Card } from '@/components/Card';

const RULES: [string, string][] = [
  ['thinking', 'Model generation time not followed by a tool call of another phase (thinking blocks, final answer).'],
  ['exploring', 'Read / Grep / Glob / LS, cat / rg / find-type shell commands, web search and fetch.'],
  ['coding', 'Edit / Write / patch tools on non-documentation files.'],
  ['documenting', 'The same tools on *.md, *.rst, *.txt, docs/**, README*, CHANGELOG*.'],
  ['testing', 'Shell commands matching test runners (npm test, vitest, jest, pytest, go test, cargo test, ...).'],
  ['validating', 'Lint, type-check and build commands (eslint, tsc, cargo check, npm run build, ...).'],
  ['other', 'Everything else: git, package installs, MCP tools, ...'],
];

export function PhaseRules({ version }: { version: number[] }) {
  return (
    <Card
      title="How phases are classified"
      description={`Rule-based, no LLM. phase_rules_version: ${version.length ? version.join(', ') : 'n/a (no turns in range)'}${version.length > 1 ? ' (mixed versions in this range)' : ''}`}
    >
      <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">
        Time between transcript entries goes to the phase of the activity occupying it. Waiting for sub-agents (delegating) is not counted
        in the parent run; it is counted in the child run, so nothing is double counted.
      </p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
        {RULES.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-medium capitalize text-zinc-900 dark:text-zinc-100">{k}</dt>
            <dd className="mb-1 text-zinc-600 dark:text-zinc-400 sm:mb-0">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
