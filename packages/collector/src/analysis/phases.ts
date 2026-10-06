import { PHASES, type Phase, type PhasesMs } from '../protocol-types.js';

/**
 * Phase classification (BRIEF §5.4), no LLM. Bump PHASE_RULES_VERSION whenever a rule changes the
 * result for some input; it is stored per turn so dashboards can tell rule generations apart.
 */
export const PHASE_RULES_VERSION = 1;

/** `delegating` = waiting for sub-agents; excluded from the parent's totals (counted in the child run). */
export type PhaseOrDelegating = Phase | 'delegating';

export interface ToolCallInfo {
  /** shell command line, for shell / bash / exec tools */
  command?: string | readonly string[];
  /** files the tool reads or writes; used locally only, never sent */
  filePaths?: readonly string[];
}

const DOC_FILE_RE = /(^|\/)(docs?|documentation)\/|(^|\/)(readme|changelog|changes|history|contributing|authors|license|notice)$|\.(md|mdx|markdown|rst|txt|adoc|asciidoc)$/i;

export function isDocumentationPath(path: string): boolean {
  return DOC_FILE_RE.test(path.replace(/\\/g, '/'));
}

const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const DELEGATE_TOOLS = new Set(['task', 'agent', 'spawnagent', 'subagent', 'delegate', 'runagent']);
const EXPLORE_TOOLS = new Set([
  'read', 'grep', 'glob', 'ls', 'list', 'listdir', 'listfiles', 'readfile', 'viewfile', 'view', 'search',
  'websearch', 'webfetch', 'fetch', 'findfiles', 'filesearch', 'codesearch', 'readmanyfiles', 'notebookread', 'viewimage',
]);
const EDIT_TOOLS = new Set([
  'edit', 'multiedit', 'write', 'writefile', 'notebookedit', 'applypatch', 'patch', 'createfile', 'strreplace',
  'strreplacebasededittool', 'replace', 'editfile', 'insert',
]);
const SHELL_TOOLS = new Set(['bash', 'shell', 'localshell', 'execcommand', 'exec', 'runcommand', 'terminal', 'unifiedexec', 'powershell']);

// ---------------------------------------------------------------- shell commands

const TEST_RE = [
  /^(npm|pnpm|yarn|bun)( run)? test(:|\b)/,
  /^(npm|pnpm|yarn|bun) (-[^\s]+ |--filter[= ][^\s]+ |-C [^\s]+ )*(run )?test(:|\b)/,
  /^(npx |pnpm |pnpm exec |yarn |bunx |bun x )?(vitest|jest|mocha|ava|tap|karma|playwright test|cypress run|jasmine)\b(?! (--version|init))/,
  /^bun test\b/,
  /^(python3?|py)( -m)? (pytest|unittest|nose2?)\b/,
  /^(pytest|py\.test|tox|nox|rspec|phpunit|pest|ctest|behave)\b/,
  /^(poetry|uv|pipenv|hatch|pdm) run (pytest|tox|nox|python -m pytest)\b/,
  /^go test\b/,
  /^cargo (test|nextest)\b/,
  /^(xcodebuild\b.*\btest\b|swift test\b)/,
  /^(mvn|\.\/mvnw)\b.*\b(test|verify)\b/,
  /^(gradle|\.\/gradlew)\b.*\b(test|check)\b/,
  /^dotnet test\b/,
  /^deno test\b/,
  /^(bundle exec )?(rake test|rails test|rspec)\b/,
  /^mix test\b/,
  /^make (test|check)\b/,
  /^flutter test\b/,
];

const VALIDATE_RE = [
  /^(npx |pnpm |pnpm exec |yarn |bunx )?(eslint|tsc|tsgo|prettier --check|biome (check|lint|ci)|oxlint|stylelint|vue-tsc|svelte-check|next lint|astro check)\b/,
  /^(npm|pnpm|yarn|bun) (-[^\s]+ |--filter[= ][^\s]+ |-C [^\s]+ )*(run )?(build|lint|typecheck|type-check|check-types|tsc|check|format:check|lint:\S+|typecheck:\S+)(\s|$)/,
  /^(npx |pnpm |yarn )?(next|vite|webpack|rollup|esbuild|tsup|turbo run build|turbo build|nx build)( build)?\b/,
  /^(ruff|mypy|pyright|flake8|pylint|black --check|isort --check|bandit)\b/,
  /^(python3?|py) -m (mypy|pyright|flake8|pylint|ruff|compileall|py_compile)\b/,
  /^cargo (check|clippy|build|fmt -- --check|fmt --check)\b/,
  /^(swift build|swiftlint|xcodebuild\b)/,
  /^go (build|vet)\b|^(golangci-lint|staticcheck|gofmt -l)\b/,
  /^(mvn|\.\/mvnw)\b.*\b(compile|package|install)\b/,
  /^(gradle|\.\/gradlew)\b.*\b(build|assemble|compile\w*|lint)\b/,
  /^dotnet (build|format --verify)\b/,
  /^(shellcheck|hadolint|terraform validate|tflint|actionlint|yamllint|markdownlint|rubocop|phpstan|psalm|ktlint|detekt)\b/,
  /^make( (build|lint|all|check-types))?$/,
  /^make (build|lint)\b/,
  /^deno (check|lint)\b/,
];

const EXPLORE_RE = [
  /^(cat|head|tail|less|more|bat|rg|ag|ack|grep|egrep|fgrep|find|fd|ls|tree|exa|eza|wc|file|stat|du|realpath|readlink|jq|yq|nl|od|xxd|hexdump|strings|diff|cmp|column|sort|uniq|cut|tr|awk|which|whereis|type)\b/,
  /^sed -n\b/,
  /^(curl|wget|http|xh)\b/,
];

const CODING_RE = [/^sed -i\b/, /^(perl -p?i|perl -i)\b/, /^(patch|tee|touch|mkdir|cp|mv|rm|ln)\b/];

const PRIORITY: readonly PhaseOrDelegating[] = ['testing', 'validating', 'coding', 'documenting', 'exploring', 'other'];

/** Splits a command line into simple commands (&&, ||, ;, |, newlines) and strips env/cd/time/sudo prefixes. */
export function splitShellCommand(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((part) =>
      part
        .trim()
        .replace(/^[({\s]+|[)}\s]+$/g, '')
        .replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, '')
        .replace(/^(sudo|time|nice|exec|command|env|npx --yes|npx -y|timeout \d+[smh]?)\s+/, '')
        .replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, '')
        .toLowerCase(),
    )
    .filter((p) => p && !/^cd\b/.test(p));
}

function unwrapShell(command: string | readonly string[]): string {
  if (typeof command === 'string') return command;
  // Codex style argv: ["bash", "-lc", "npm test"]
  const [first, flag, script] = command;
  if (first && /(^|\/)(ba|z|da|fi)?sh$|powershell|pwsh/.test(first) && flag && /^-\w*c$/i.test(flag) && script) return script;
  return command.join(' ');
}

function classifySimpleCommand(cmd: string): PhaseOrDelegating {
  if (TEST_RE.some((r) => r.test(cmd))) return 'testing';
  if (VALIDATE_RE.some((r) => r.test(cmd))) return 'validating';
  if (CODING_RE.some((r) => r.test(cmd))) return 'coding';
  if (EXPLORE_RE.some((r) => r.test(cmd))) return 'exploring';
  return 'other';
}

/** Phase of a shell command; compound commands take the highest-priority part (testing > validating > coding > exploring > other). */
export function classifyCommand(command: string | readonly string[]): Phase {
  const parts = splitShellCommand(unwrapShell(command));
  let best: PhaseOrDelegating = 'other';
  for (const part of parts) {
    const p = classifySimpleCommand(part);
    if (PRIORITY.indexOf(p) < PRIORITY.indexOf(best)) best = p;
  }
  return best === 'delegating' ? 'other' : best;
}

/** Whether a shell command is a test or validate run (its exit code feeds the outcome, BRIEF §5.5). */
export function checkKind(command: string | readonly string[]): 'testing' | 'validating' | null {
  const p = classifyCommand(command);
  return p === 'testing' || p === 'validating' ? p : null;
}

/**
 * Classifies one tool call. Tool names are matched case- and punctuation-insensitively, so Claude
 * Code (`Read`, `MultiEdit`, `Task`) and Codex (`shell`, `apply_patch`, `web_search`) share rules.
 * MCP tools (`mcp__…`) and unknown tools are `other`.
 */
export function classify(toolName: string, info: ToolCallInfo = {}): PhaseOrDelegating {
  if (/^mcp__/i.test(toolName)) return 'other';
  const name = norm(toolName);
  if (DELEGATE_TOOLS.has(name)) return 'delegating';
  if (EXPLORE_TOOLS.has(name)) return 'exploring';
  if (EDIT_TOOLS.has(name)) {
    const paths = info.filePaths ?? [];
    return paths.length && paths.every(isDocumentationPath) ? 'documenting' : 'coding';
  }
  if (SHELL_TOOLS.has(name)) return info.command ? classifyCommand(info.command) : 'other';
  return 'other';
}

// ---------------------------------------------------------------- time attribution

/**
 * One timestamped transcript moment, in order. `at` is epoch ms.
 * - `prompt`: user input; the model starts generating
 * - `output`: the model emitted text / thinking (no tool call)
 * - `tool_call`: the model emitted a tool call (its generation time counts toward the tool's phase)
 * - `tool_result`: the tool finished; the model resumes generating
 */
export type TimelineEntry =
  | { at: number; type: 'prompt' }
  | { at: number; type: 'output' }
  | { at: number; type: 'tool_call'; id: string; phase: PhaseOrDelegating }
  | { at: number; type: 'tool_result'; id: string };

export type PhaseTotals = Record<PhaseOrDelegating, number>;

export const emptyPhaseTotals = (): PhaseTotals => ({
  thinking: 0, exploring: 0, coding: 0, documenting: 0, testing: 0, validating: 0, other: 0, delegating: 0,
});

/**
 * Assigns the time between consecutive entries to a phase (BRIEF §5.4):
 * - while tool calls are pending → the pending tool's phase (`delegating` wins if any sub-agent is running);
 * - otherwise the model is generating → the phase of the tool call that ends the interval, or
 *   `thinking` when the interval ends with plain output (incl. thinking blocks, final answer).
 * `endAt` (e.g. the Stop time) extends the last interval. Negative gaps are ignored.
 */
export function attributeTime(entries: readonly TimelineEntry[], endAt?: number): PhaseTotals {
  const totals = emptyPhaseTotals();
  const pending = new Map<string, PhaseOrDelegating>();
  const timeline = [...entries];
  if (endAt !== undefined && timeline.length && endAt > (timeline.at(-1)?.at ?? endAt)) {
    timeline.push({ at: endAt, type: 'output' });
  }
  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1]!;
    const cur = timeline[i]!;
    // apply the effect of `prev` on the pending set
    if (prev.type === 'tool_call') {
      pending.delete(prev.id);
      pending.set(prev.id, prev.phase);
    } else if (prev.type === 'tool_result') pending.delete(prev.id);
    else if (prev.type === 'prompt') pending.clear();

    const gap = cur.at - prev.at;
    if (!(gap > 0)) continue;
    let phase: PhaseOrDelegating;
    if (pending.size) {
      // Calls emitted back-to-back: the gap before the next call is that call's generation time.
      if (cur.type === 'tool_call' && prev.type === 'tool_call') phase = cur.phase;
      else {
        const running = [...pending.values()];
        phase = running.includes('delegating') ? 'delegating' : (running.at(-1) ?? 'other');
      }
    } else {
      phase = cur.type === 'tool_call' ? cur.phase : 'thinking';
    }
    totals[phase] += gap;
  }
  return totals;
}

/** Wire format: drops `delegating` (counted in the child run) and zero phases; rounds to whole ms. */
export function toPhasesMs(totals: Partial<PhaseTotals>): PhasesMs {
  const out: PhasesMs = {};
  for (const p of PHASES) {
    const v = Math.round(totals[p] ?? 0);
    if (v > 0) out[p] = v;
  }
  return out;
}

/** Adds phase totals (e.g. across runs). */
export function addPhaseTotals(a: PhaseTotals, b: Partial<PhaseTotals>): PhaseTotals {
  const out = { ...a };
  for (const k of Object.keys(out) as PhaseOrDelegating[]) out[k] += b[k] ?? 0;
  return out;
}
