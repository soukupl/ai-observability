import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { analyzeEntries, workflowKey, type Agg } from '../adapters/claude-code/analyze.js';
import { addLine, type Segment } from '../adapters/claude-code/session.js';
import { agentsOfToolUses, listAgents, type AgentMeta } from '../adapters/claude-code/subagents.js';
import { readTranscript, type SlimEntry, type TranscriptTitles } from '../adapters/claude-code/transcript.js';
import { mergeUsage } from '../analysis/tokens.js';
import type { UsageEntry } from '../protocol-types.js';

/**
 * Read-only live view of a Claude Code session (ADR-0027, `ai-obs live`). Everything here keeps its own in-memory
 * cursors: the hook state files and their offsets are never written, and transcripts are only read.
 */

/** What the monitor shows about one session's current (working) or last (idle) turn. */
export interface LiveFacts {
  working: boolean;
  /** working: start of the turn; idle: when it ended (epoch ms) */
  since: number;
  /** time of the newest transcript entry */
  lastEntryAt: number;
  /** the turn's usage: main agent + sub-agents */
  usage: UsageEntry[];
  tools: number;
  subagents: number;
  lastTool: string | null;
}

/**
 * The last tool of a turn known only by its de-duplicated tool names (first-use order): exact when a single tool
 * was used, else unknown.
 */
export const soleTool = (names: readonly string[]): string | null => (names.length === 1 ? names[0]! : null);

/** Sub-agent directory listing is repeated at most this often (or when the turn launches more agents). */
const SUBAGENT_LIST_MS = 5000;
/** A transcript with no state file is read from its last 8 MB only. */
export const SCAN_TAIL_BYTES = 8 * 1024 * 1024;
const CWD_SCAN_BYTES = 64 * 1024;

/**
 * Analysis is re-run over ALL entries of a segment (token de-duplication works within one call only, tokens.ts),
 * so it is cached by entry count: a poll that read nothing new costs nothing.
 */
const aggCache = new WeakMap<readonly SlimEntry[], { n: number; agg: Agg }>();
function aggOf(entries: readonly SlimEntry[]): Agg {
  const hit = aggCache.get(entries);
  if (hit && hit.n === entries.length) return hit.agg;
  const agg = analyzeEntries(entries);
  aggCache.set(entries, { n: entries.length, agg });
  return agg;
}

/**
 * Working / idle and the totals of one turn's entries (a prompt segment, see session.ts `addLine`).
 * Working = the last activity (prompt, assistant, tool result, interrupt) has no end-of-turn record at or after it
 * and is not a user interrupt, an interrupted tool result or an API-error placeholder.
 */
export function segmentFacts(entries: readonly SlimEntry[], subagentUsage: readonly UsageEntry[] = []): LiveFacts {
  const agg = aggOf(entries);
  let lastAct: SlimEntry | null = null;
  let lastStop: SlimEntry | null = null;
  let lastEntryAt = 0;
  let lastTool: string | null = null;
  for (const e of entries) {
    lastEntryAt = Math.max(lastEntryAt, e.at);
    if (e.k === 'stop') {
      if (!lastStop || e.at >= lastStop.at) lastStop = e;
      continue;
    }
    if (e.k === 'expansion') continue;
    if (!lastAct || e.at >= lastAct.at) lastAct = e;
    if (e.k === 'assistant') for (const b of e.blocks) if (b.t === 'tool_use') lastTool = b.name;
  }
  const working =
    lastAct !== null &&
    !(lastStop && lastStop.at >= lastAct.at) &&
    lastAct.k !== 'interrupt' &&
    !(lastAct.k === 'tool_result' && lastAct.userInterrupt) &&
    !(lastAct.k === 'assistant' && lastAct.synthetic);
  const since = working ? (entries[0]?.at ?? 0) : (lastStop?.at ?? lastAct?.at ?? entries[0]?.at ?? 0);
  return {
    working,
    since,
    lastEntryAt,
    usage: mergeUsage(agg.usage, subagentUsage),
    tools: Object.values(agg.tools).reduce((a, b) => a + b, 0),
    subagents: Object.keys(agg.agentCalls).length,
    lastTool,
  };
}

interface AgentTail {
  cursor: number;
  entries: SlimEntry[];
}

/**
 * Usage of the sub-agents (and Workflow agents) a turn launched, read from their transcripts with one in-memory
 * cursor per agent file. Only the current turn's agents are kept: earlier turns' are forgotten on the next poll.
 */
export class SubagentTails {
  private path = '';
  private metas = new Map<string, AgentMeta>();
  private listedAt = Number.NEGATIVE_INFINITY;
  private listedCalls = -1;
  private readonly agents = new Map<string, AgentTail>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `agentCallKeys`: the turn's `agentCalls` keys (Agent tool_use ids and `wf:<run id>` keys). */
  poll(transcriptPath: string, agentCallKeys: readonly string[]): UsageEntry[] {
    if (!agentCallKeys.length) {
      this.agents.clear();
      return [];
    }
    const t = this.now();
    if (transcriptPath !== this.path || agentCallKeys.length !== this.listedCalls || t - this.listedAt >= SUBAGENT_LIST_MS) {
      this.path = transcriptPath;
      this.metas = listAgents(transcriptPath);
      this.listedAt = t;
      this.listedCalls = agentCallKeys.length;
    }
    const picked = new Map<string, AgentMeta>();
    for (const a of agentsOfToolUses(this.metas, agentCallKeys)) picked.set(a.agentId, a);
    const keys = new Set(agentCallKeys);
    for (const a of this.metas.values()) if (a.workflowId && keys.has(workflowKey(a.workflowId))) picked.set(a.agentId, a);
    for (const id of this.agents.keys()) if (!picked.has(id)) this.agents.delete(id);
    const lists: UsageEntry[][] = [];
    for (const a of picked.values()) {
      const tail = this.agents.get(a.agentId) ?? { cursor: 0, entries: [] };
      const read = readTranscript(a.file, tail.cursor);
      if (read.reset) tail.entries = [];
      for (const l of read.lines) tail.entries.push(l.entry);
      tail.cursor = read.end;
      this.agents.set(a.agentId, tail);
      if (tail.entries.length) lists.push(aggOf(tail.entries).usage);
    }
    return mergeUsage(...lists);
  }
}

export interface ClaudeTailInit {
  sessionId: string;
  transcriptPath: string;
  /** byte offset to start at: the state's `offset` (start of the first unfinished segment) */
  offset: number;
  /** clock for the sub-agent listing throttle (default Date.now) */
  now?: () => number;
}

/**
 * Follows one transcript from its own cursor. Keeps only the latest prompt segment (the current turn when it is
 * working, the last one when idle) and the entries before any prompt (the continuation of an earlier turn).
 */
export class ClaudeSessionTail {
  private cursor: number;
  private pre: SlimEntry[] = [];
  private segments: Segment[] = [];
  private read: TranscriptTitles = {};
  private readonly sub: SubagentTails;
  private subSig = '[]';
  private subUsage: UsageEntry[] = [];

  constructor(private readonly init: ClaudeTailInit) {
    this.cursor = init.offset;
    this.sub = new SubagentTails(init.now);
  }

  /** Reads what was appended since the last poll; true when anything changed. */
  poll(): boolean {
    const res = readTranscript(this.init.transcriptPath, this.cursor, this.init.sessionId);
    let changed = res.lines.length > 0 || res.reset;
    if (res.reset) {
      this.pre = [];
      this.segments = [];
      this.subSig = '[]';
      this.subUsage = [];
    }
    for (const l of res.lines) addLine(l, this.pre, this.segments);
    this.cursor = res.end;
    if (res.titles.custom || res.titles.ai) {
      const next = { ...this.read, ...res.titles };
      if (next.custom !== this.read.custom || next.ai !== this.read.ai) changed = true;
      this.read = next;
    }
    if (this.segments.length > 1) this.segments.splice(0, this.segments.length - 1);
    if (this.segments.length) this.pre = [];
    const calls = this.current() ? Object.keys(aggOf(this.current()!).agentCalls) : [];
    const usage = this.sub.poll(this.init.transcriptPath, calls);
    const sig = JSON.stringify(usage);
    if (sig !== this.subSig) {
      this.subSig = sig;
      this.subUsage = usage;
      changed = true;
    }
    return changed;
  }

  private current(): SlimEntry[] | null {
    const seg = this.segments.at(-1);
    if (seg) return seg.entries;
    return this.pre.length ? this.pre : null;
  }

  /** Whether a prompt segment (a whole turn) is held, not just entries that continue an earlier turn. */
  hasPrompt(): boolean {
    return this.segments.length > 0;
  }

  /** Facts of the latest segment; null while nothing was read. */
  facts(): LiveFacts | null {
    const entries = this.current();
    return entries ? segmentFacts(entries, this.subUsage) : null;
  }

  /** The titles read from the transcript since the cursor started (ADR-0026). */
  titles(): TranscriptTitles {
    return this.read;
  }

  /** The best title read: `/rename` over the generated one. */
  title(): string | null {
    return this.read.custom ?? this.read.ai ?? null;
  }
}

/** The first `cwd` of a transcript (the first 64 KB are looked at); null when there is none. */
export function transcriptCwd(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(Math.min(CWD_SCAN_BYTES, fstatSync(fd).size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, n));
    if (!m?.[1]) return null;
    const cwd: unknown = JSON.parse(m[1]);
    return typeof cwd === 'string' && cwd ? cwd : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
