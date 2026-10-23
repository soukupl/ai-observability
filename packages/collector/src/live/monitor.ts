import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import type { StoredTurn, SessionState } from '../adapters/claude-code/state.js';
import type { CodexSessionState } from '../adapters/codex/session.js';
import { mergeUsage, totalTokens } from '../analysis/tokens.js';
import { harnessStateDir, type AiObsPaths } from '../paths.js';
import { estimateUsageCost } from '../prices.js';
import type { HarnessName, UsageEntry } from '../protocol-types.js';
import { SessionStateStore } from '../state.js';
import { ClaudeSessionTail, SCAN_TAIL_BYTES, soleTool, transcriptCwd, type LiveFacts } from './claude-code.js';
import { CodexSessionTail } from './codex.js';

/**
 * `ai-obs live` (ADR-0027): the sessions running on this machine, read from the hook state files (to find them and
 * to know where to start) and the transcripts / rollouts themselves (for the live part). Read-only: nothing under
 * ~/.ai-obs or the harness directories is ever written, and the hook state offsets are never moved.
 */

/** Same thresholds as the dashboard's apps/web/src/lib/live/status.ts IDLE_MAX_MS (a test pins both literals). */
export const LIVE_IDLE_STALE_MS = 1_800_000;
/** = apps/web/src/lib/live/status.ts WORKING_MAX_MS */
export const LIVE_WORKING_STALE_MS = 7_200_000;

/** New sessions are looked for this often; known ones are polled on every refresh. */
const DISCOVERY_MS = 5000;

export type LiveStatus = 'working' | 'idle' | 'stale';

/** working: stale when now - since > 2 h; idle: stale when now - lastSignalAt >= 30 min. */
export function liveStatus(f: { working: boolean; since: number; lastSignalAt: number }, now: number): LiveStatus {
  if (f.working) return now - f.since > LIVE_WORKING_STALE_MS ? 'stale' : 'working';
  return now - f.lastSignalAt >= LIVE_IDLE_STALE_MS ? 'stale' : 'idle';
}

export interface LiveSession {
  harness: HarnessName;
  sessionId: string;
  title: string | null;
  /** last path segment of the working directory ('' when unknown) */
  project: string;
  cwd: string | null;
  status: LiveStatus;
  /** working: start of the turn; idle: end of the last one (epoch ms) */
  since: number;
  usage: UsageEntry[];
  tokens: number;
  cost: { usd: number | null; partial: boolean };
  tools: number;
  subagents: number;
  lastTool: string | null;
}

export interface MonitorDeps {
  paths: AiObsPaths;
  /** ~/.claude or $CLAUDE_CONFIG_DIR */
  claudeDir: string;
  now: () => number;
  /** also follow transcripts that have no hook state file (default true) */
  scanTranscripts?: boolean;
}

/** Whether `cwd` is the directory `root` or inside it. */
export function inScope(cwd: string | null, root: string): boolean {
  if (!cwd) return false;
  return cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
}

type Tracked =
  | {
      harness: 'claude-code';
      sessionId: string;
      tail: ClaudeSessionTail;
      /** hook state (null: a transcript found by the scan) */
      state: SessionState | null;
      stateMtime: number;
      cwd: string | null;
    }
  | {
      harness: 'codex';
      sessionId: string;
      tail: CodexSessionTail;
      state: CodexSessionState;
      stateMtime: number;
      cwd: string | null;
    };

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
/** A transcript without hook state is only followed while it was written this recently. */
const SCAN_MAX_AGE_MS = LIVE_IDLE_STALE_MS;

const safeStat = (path: string) => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};
const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Facts of a session whose current segment is not (or no longer) in memory: its last stored turn. */
function factsOfTurn(t: StoredTurn): LiveFacts {
  return {
    working: false,
    since: t.agg.endedAt,
    lastEntryAt: t.agg.endedAt,
    usage: mergeUsage(t.agg.usage, t.runUsage),
    tools: Object.values(t.agg.tools).reduce((a, b) => a + b, 0),
    subagents: Object.keys(t.agg.agentCalls).length,
    lastTool: soleTool(t.agg.toolNames), // toolNames is first-use order, not the last tool
  };
}

export class LiveMonitor {
  private readonly tracked = new Map<string, Tracked>();
  private discoveredAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: MonitorDeps) {}

  /** Finds new sessions (every 5 s), polls every known one and returns the rows: working, idle, then stale. */
  async refresh(): Promise<LiveSession[]> {
    const now = this.deps.now();
    if (now - this.discoveredAt >= DISCOVERY_MS) {
      this.discover(now);
      this.discoveredAt = now;
    }
    const rows: LiveSession[] = [];
    for (const t of this.tracked.values()) {
      try {
        if (t.harness === 'claude-code') t.tail.poll();
        else await t.tail.poll();
        const row = this.rowOf(t, now);
        if (row) rows.push(row);
      } catch {
        /* a file vanished or was unreadable this round: the next refresh tries again */
      }
    }
    const rank = { working: 0, idle: 1, stale: 2 } as const;
    return rows.sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        (a.status === 'working' ? a.since - b.since : b.since - a.since) ||
        a.sessionId.localeCompare(b.sessionId),
    );
  }

  // ---------------------------------------------------------------- discovery

  private discover(now: number): void {
    const found = new Map<string, Tracked>();
    this.discoverClaude(now, found);
    this.discoverCodex(now, found);
    this.tracked.clear();
    for (const [k, v] of found) this.tracked.set(k, v);
  }

  private discoverClaude(now: number, found: Map<string, Tracked>): void {
    const store = new SessionStateStore(harnessStateDir(this.deps.paths, 'claude-code'));
    for (const { sessionId: file, updatedAt } of store.list()) {
      if (now - updatedAt >= LIVE_WORKING_STALE_MS) continue;
      const known = this.tracked.get(`claude-code:${file}`);
      if (known?.harness === 'claude-code' && known.state && known.stateMtime === updatedAt) {
        found.set(`claude-code:${known.sessionId}`, known);
        continue;
      }
      const st = store.get<SessionState>(file);
      if (!st || st.v !== 1 || st.ended || !st.transcriptPath) continue;
      const key = `claude-code:${st.sessionId}`;
      const prev = this.tracked.get(key);
      if (prev?.harness === 'claude-code' && prev.state && prev.state.transcriptPath === st.transcriptPath) {
        found.set(key, { ...prev, state: st, stateMtime: updatedAt, cwd: st.cwd || prev.cwd });
        continue;
      }
      found.set(key, {
        harness: 'claude-code',
        sessionId: st.sessionId,
        tail: new ClaudeSessionTail({ sessionId: st.sessionId, transcriptPath: st.transcriptPath, offset: st.offset, now: this.deps.now }),
        state: st,
        stateMtime: updatedAt,
        cwd: st.cwd || null,
      });
    }
    if (this.deps.scanTranscripts === false) return;
    const projects = join(this.deps.claudeDir, 'projects');
    for (const dir of safeReaddir(projects)) {
      for (const name of safeReaddir(join(projects, dir))) {
        if (!UUID_JSONL.test(name)) continue;
        const sessionId = name.slice(0, -'.jsonl'.length);
        const key = `claude-code:${sessionId}`;
        if (found.has(key) || existsSync(store.path(sessionId))) continue;
        const path = join(projects, dir, name);
        const stat = safeStat(path);
        if (!stat || now - stat.mtimeMs >= SCAN_MAX_AGE_MS) continue;
        const prev = this.tracked.get(key);
        if (prev?.harness === 'claude-code' && !prev.state) {
          found.set(key, prev);
          continue;
        }
        found.set(key, {
          harness: 'claude-code',
          sessionId,
          tail: new ClaudeSessionTail({ sessionId, transcriptPath: path, offset: Math.max(0, stat.size - SCAN_TAIL_BYTES), now: this.deps.now }),
          state: null,
          stateMtime: 0,
          cwd: transcriptCwd(path),
        });
      }
    }
  }

  private discoverCodex(now: number, found: Map<string, Tracked>): void {
    const store = new SessionStateStore(harnessStateDir(this.deps.paths, 'codex'));
    for (const { sessionId: file, updatedAt } of store.list()) {
      if (now - updatedAt >= LIVE_WORKING_STALE_MS) continue;
      const known = this.tracked.get(`codex:${file}`);
      if (known?.harness === 'codex' && known.stateMtime === updatedAt) {
        found.set(`codex:${file}`, known);
        continue;
      }
      const st = store.get<CodexSessionState>(file);
      if (!st || st.v !== 1 || st.ended || st.subagent || !st.rolloutPath) continue;
      const key = `codex:${file}`;
      // The hook wrote newer state (a turn it closed, sub-agent usage it resolved): replay from it, not the old clone.
      const prev = this.tracked.get(key);
      const tail = new CodexSessionTail(st, prev?.harness === 'codex' && prev.state.rolloutPath === st.rolloutPath ? prev.tail.lastToolSeen() : null);
      found.set(key, { harness: 'codex', sessionId: st.sessionId, tail, state: st, stateMtime: updatedAt, cwd: tail.cwd() });
    }
  }

  // ---------------------------------------------------------------- rows

  private rowOf(t: Tracked, now: number): LiveSession | null {
    let facts: LiveFacts | null;
    let title: string | null = null;
    let seen: number;
    let cwd = t.cwd;
    if (t.harness === 'claude-code') {
      const turn = t.state?.turns.at(-1);
      facts = t.tail.facts();
      // The turn finished before this monitor looked (or its prompt is out of reach): the stored last turn is complete.
      if (turn && (!facts || (!facts.working && !t.tail.hasPrompt()))) facts = factsOfTurn(turn);
      if (!facts && t.state) {
        facts = { working: false, since: t.state.lastSeen, lastEntryAt: t.state.lastSeen, usage: [], tools: 0, subagents: 0, lastTool: null };
      }
      const titles = { ...t.state?.title, ...t.tail.titles() };
      title = titles.custom ?? titles.ai ?? null;
      seen = t.state?.lastSeen ?? 0;
    } else {
      facts = t.tail.facts();
      seen = t.state.lastActivityAt;
      cwd = t.tail.cwd() ?? cwd; // known once the session_meta line was read
    }
    if (!facts) return null;
    const cost = estimateUsageCost(facts.usage);
    return {
      harness: t.harness,
      sessionId: t.sessionId,
      title,
      project: cwd ? basename(cwd) : '',
      cwd,
      status: liveStatus({ working: facts.working, since: facts.since, lastSignalAt: Math.max(facts.lastEntryAt, seen) }, now),
      since: facts.since,
      usage: facts.usage,
      tokens: facts.usage.reduce((n, u) => n + totalTokens(u), 0),
      cost: { usd: cost.usd, partial: cost.partial },
      tools: facts.tools,
      subagents: facts.subagents,
      lastTool: facts.lastTool,
    };
  }
}
