import { mergeUsage } from '../analysis/tokens.js';
import { mtimeMs } from '../adapters/codex/locate.js';
import { parseRolloutLine, type RolloutItem } from '../adapters/codex/records.js';
import { readNewLines } from '../adapters/codex/rollout.js';
import { applyItems, type CodexSessionState, type SessionEnv } from '../adapters/codex/session.js';
import { soleTool, type LiveFacts } from './claude-code.js';

/**
 * Read-only live view of a Codex session (ADR-0027, `ai-obs live`). The hook state is cloned and the rollout is
 * replayed into the clone from the state's offset with the adapter's own reducer, so open / closed turns and token
 * deltas follow the same rules as the collector. Nothing is emitted and nothing is written back. Sub-agent usage
 * comes from the hook state only (NULL_ENV resolves none), so the monitor rebuilds the tail whenever the hook
 * writes newer state.
 */
export const NULL_ENV: SessionEnv = {
  harness: 'codex',
  emit() {},
  project: async () => undefined,
  children: () => ({ runs: [], usage: {}, missing: [] }),
};

const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
const ms = (t: Date | string | number): number => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t));

/** A tool call read from the rollout: its name and time. */
export interface SeenTool {
  name: string;
  at: number;
}

export class CodexSessionTail {
  private readonly state: CodexSessionState;
  private cursor: number;

  /** `lastTool`: the last tool call an earlier tail of this rollout read (kept when the tail is rebuilt). */
  constructor(
    state: CodexSessionState,
    private lastTool: SeenTool | null = null,
  ) {
    this.state = structuredClone(state);
    this.cursor = state.offset;
  }

  /** The last tool call read from the rollout so far. */
  lastToolSeen(): SeenTool | null {
    return this.lastTool;
  }

  /** Reads and applies the rollout lines appended since the last poll; true when anything changed. */
  async poll(): Promise<boolean> {
    const path = this.state.rolloutPath;
    if (!path) return false;
    const r = readNewLines(path, this.cursor);
    this.cursor = r.offset;
    if (r.reset) return true; // rewritten under us: skip to the end, as the collector does
    const items = r.lines.map(parseRolloutLine).filter((i): i is RolloutItem => i !== null);
    if (!items.length) return false;
    for (const i of items) if (i.kind === 'tool_call') this.lastTool = { name: i.name, at: i.at };
    await applyItems(this.state, NULL_ENV, items);
    return true;
  }

  /** The open turn (working), else the last emitted turn (idle). */
  facts(): LiveFacts {
    const s = this.state;
    // toolNames / tools keys are in first-use order: the true last tool is known only from the rollout read here
    const toolIn = (from: number, to: number, names: readonly string[]) =>
      this.lastTool && this.lastTool.at >= from && this.lastTool.at <= to ? this.lastTool.name : soleTool(names);
    const lastEntryAt = Math.max(s.lastActivityAt, mtimeMs(s.rolloutPath));
    const open = s.open;
    if (open) {
      return {
        working: true,
        since: open.startedAt,
        lastEntryAt,
        usage: open.usage,
        tools: sum(open.tools),
        subagents: open.spawned.length,
        lastTool: toolIn(open.startedAt, Number.POSITIVE_INFINITY, open.toolNames),
      };
    }
    const last = s.emitted.at(-1);
    if (last) {
      return {
        working: false,
        since: ms(last.input.endedAt),
        lastEntryAt,
        usage: mergeUsage(last.mainUsage, ...Object.values(last.children)),
        tools: sum(last.input.tools),
        subagents: last.spawned.length,
        lastTool: toolIn(ms(last.input.startedAt), ms(last.input.endedAt), Object.keys(last.input.tools ?? {})),
      };
    }
    return { working: false, since: s.meta?.startedAt ?? s.lastActivityAt, lastEntryAt, usage: s.carry, tools: 0, subagents: 0, lastTool: null };
  }

  /** The session's working directory (session_meta, else the first hook's). */
  cwd(): string | null {
    return this.state.meta?.cwd ?? this.state.pkCwd ?? null;
  }
}
