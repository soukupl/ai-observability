import type { PhasesMs } from './schema/columns.js';
import type { Outcome } from './schema/enums.js';

/**
 * Pure, deterministic generator of synthetic telemetry for the demo seed. Ids are left to the DB;
 * rows reference each other by array index. Token totals of a turn = sum of all its usage rows
 * (turn-level row for the main agent + one row per sub-agent run).
 */

export interface SeedActor {
  key: string;
  team: string;
}
export interface SeedProject {
  key: string;
  team: string;
}
interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number;
}
export interface SeedUsage extends Tokens {
  model: string;
  effort: string | null;
}
export interface SeedRun extends Tokens {
  externalId: string;
  parentIndex: number | null;
  agentType: string;
  depth: number;
  model: string;
  effort: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  phasesMs: PhasesMs;
  outcome: Outcome;
}
export interface SeedTurn extends Tokens {
  externalId: string;
  sessionKey: string;
  actor: SeedActor;
  project: SeedProject;
  harness: 'claude-code' | 'codex';
  model: string;
  effort: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  phasesMs: PhasesMs;
  tools: Record<string, number>;
  /** skill name → uses by source (main agent) */
  skills: Record<string, { model: number; user: number }>;
  /** MCP server → tool → calls (main agent) */
  mcp: Record<string, Record<string, number>>;
  filesTouched: number;
  linesAdded: number;
  linesRemoved: number;
  outcome: Outcome;
  signals: string[];
  summary: string;
  usage: SeedUsage[];
  runs: Array<SeedRun & { usage: SeedUsage; mcp: Record<string, Record<string, number>> }>;
}

const SKILLS = ['code-review', 'ship-check', 'bug-fixing', 'keep-documentation', 'tdd'];
const MCP: Record<string, string[]> = {
  github: ['search_code', 'get_file_contents', 'create_pull_request'],
  atlassian: ['searchJiraIssuesUsingJql', 'getJiraIssue'],
  'claude-in-chrome': ['navigate', 'read_page', 'computer'],
};

/** mulberry32: small seeded PRNG so `pnpm db:seed` always produces the same data. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}

const PHASES = ['thinking', 'exploring', 'coding', 'documenting', 'testing', 'validating', 'other'] as const;
const CLAUDE: ReadonlyArray<readonly [string, string]> = [
  ['claude-opus-5-5', 'high'],
  ['claude-opus-5-5', 'xhigh'],
  ['claude-sonnet-5-5', 'medium'],
  ['claude-sonnet-5-5', 'high'],
];
const CODEX: ReadonlyArray<readonly [string, string]> = [
  ['gpt-5.5', 'medium'],
  ['gpt-5.5', 'high'],
  ['gpt-5.4', 'medium'],
];
const SUMMARIES = [
  'Added retry with backoff to invoice webhook handler',
  'Fixed flaky date test in billing period calculation',
  'Refactored auth middleware to share session parsing',
  'Documented ingest token rotation in README',
  'Upgraded build config and fixed type errors',
  'Implemented pagination for the projects table',
  'Investigated slow query on usage report',
  'Renamed settings keys and updated callers',
];
const OUTCOMES: Array<[Outcome, string[]]> = [
  ['success', ['tests_passed']],
  ['success', ['no_failure_signal']],
  ['success', ['validate_passed']],
  ['failed', ['tests_failed']],
  ['failed', ['next_prompt_correction']],
  ['abandoned', ['user_interrupt']],
  ['unknown', []],
];

function splitPhases(r: ReturnType<typeof rng>, totalMs: number): PhasesMs {
  const weights = PHASES.map(() => r.next() ** 2);
  const sum = weights.reduce((a, b) => a + b, 0);
  const out: PhasesMs = {};
  let left = totalMs;
  PHASES.forEach((ph, i) => {
    const ms = i === PHASES.length - 1 ? left : Math.floor((totalMs * weights[i]!) / sum);
    out[ph] = ms;
    left -= ms;
  });
  return out;
}

function tokens(r: ReturnType<typeof rng>, scale: number): Tokens {
  const n = (min: number, max: number) => Math.round(r.int(min, max) * scale);
  const output = n(500, 6000);
  return {
    input: n(2_000, 20_000),
    output,
    cacheRead: n(20_000, 400_000),
    cacheWrite: n(1_000, 30_000),
    reasoning: Math.floor(output * r.next() * 0.6),
    requests: r.int(2, 30),
  };
}

const add = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  reasoning: a.reasoning + b.reasoning,
  requests: a.requests + b.requests,
});

export function generateTurns(opts: {
  actors: SeedActor[];
  projects: SeedProject[];
  count: number;
  days: number;
  now: Date;
  seed?: number;
}): SeedTurn[] {
  const r = rng(opts.seed ?? 42);
  // A separate stream for skills / MCP, so adding them did not change the rest of the demo data.
  const su = rng((opts.seed ?? 42) + 7);
  const mcpCalls = (chance: number): Record<string, Record<string, number>> => {
    const calls: Record<string, Record<string, number>> = {};
    for (const [server, tools] of Object.entries(MCP)) {
      if (su.next() >= chance) continue;
      calls[server] = { [su.pick(tools)]: su.int(1, 4) };
    }
    return calls;
  };
  const skillUses = (harness: string): SeedTurn['skills'] => {
    if (su.next() >= 0.35) return {};
    // Typed `/skill` commands are a Claude Code thing; Codex only records skills the agent opens.
    const typed = harness === 'claude-code' && su.next() < 0.4;
    return { [su.pick(SKILLS)]: { model: typed ? 0 : 1, user: typed ? 1 : 0 } };
  };
  const out: SeedTurn[] = [];
  for (let i = 0; i < opts.count; i++) {
    const actor = r.pick(opts.actors);
    const project = opts.projects.find((p) => p.team === actor.team && r.next() < 0.8) ?? r.pick(opts.projects);
    const harness = r.next() < 0.7 ? 'claude-code' : 'codex';
    const [model, effort] = r.pick(harness === 'claude-code' ? CLAUDE : CODEX);
    const day = r.int(0, opts.days - 1);
    const startedAt = new Date(opts.now.getTime() - day * 86_400_000 - r.int(1, 10 * 3600) * 1000);
    const durationMs = r.int(20, 1_800) * 1000;
    const endedAt = new Date(startedAt.getTime() + durationMs);
    const [outcome, signals] = r.pick(OUTCOMES);
    const main: SeedUsage = { model, effort, ...tokens(r, 1) };
    const runs: SeedTurn['runs'] = [];
    const subagents = r.next() < 0.4 ? r.int(1, 3) : 0;
    for (let k = 0; k < subagents; k++) {
      const parentIndex = k > 0 && r.next() < 0.3 ? 0 : null;
      const runModel = harness === 'claude-code' ? 'claude-haiku-4-5' : 'gpt-5.4-mini';
      const runMs = Math.floor(durationMs * (0.05 + r.next() * 0.25)); // ≤ 3 runs stay under 90 %
      const runStart = new Date(startedAt.getTime() + Math.floor((durationMs - runMs) * r.next()));
      const t = tokens(r, 0.5);
      const u: SeedUsage = { model: runModel, effort: null, ...t };
      runs.push({
        externalId: `run-${i}-${k}`,
        parentIndex,
        agentType: r.pick(['Explore', 'general-purpose', 'Plan', 'code-reviewer']),
        depth: parentIndex === null ? 1 : 2,
        model: runModel,
        effort: 'low',
        startedAt: runStart,
        endedAt: new Date(runStart.getTime() + runMs),
        durationMs: runMs,
        phasesMs: splitPhases(r, runMs),
        outcome: r.next() < 0.85 ? 'success' : 'failed',
        usage: u,
        mcp: mcpCalls(0.15),
        ...t,
      });
    }
    const total = runs.reduce<Tokens>((acc, run) => add(acc, run.usage), main);
    const added = r.int(0, 400);
    out.push({
      externalId: `turn-${i}`,
      sessionKey: `${actor.key}-${harness}-${day}`,
      actor,
      project,
      harness,
      model,
      effort,
      startedAt,
      endedAt,
      durationMs,
      phasesMs: splitPhases(r, durationMs - runs.reduce((a, x) => a + (x.depth === 1 ? x.durationMs : 0), 0)),
      tools: { edit: r.int(0, 20), bash: r.int(0, 15), read: r.int(0, 40) },
      skills: skillUses(harness),
      mcp: mcpCalls(0.3),
      filesTouched: r.int(0, 12),
      linesAdded: added,
      linesRemoved: r.int(0, added),
      outcome,
      signals,
      summary: r.pick(SUMMARIES),
      usage: [main],
      runs,
      ...total,
    });
  }
  return out;
}
