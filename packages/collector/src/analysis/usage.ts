import { createHash, createHmac } from 'node:crypto';
import {
  MAX_MCP_SERVERS_PER_EVENT,
  MAX_MCP_TOOLS_PER_SERVER,
  MAX_SKILLS_PER_EVENT,
  MAX_USAGE_NAME_LENGTH,
  MCP_LATENCY_BUCKETS_MS,
  type IngestEvent,
  type McpCounts,
  type McpStats,
  type McpToolStats,
  type ProjectNamingMode,
  type SkillCounts,
  type SkillSource,
} from '../protocol-types.js';

/*
 * Skill and MCP usage (docs/briefs/skills-and-mcp-stats.md). Adapters count PLAIN names here; the
 * context's queue applies the company's project-naming mode (`hashUsageNames`) before anything is
 * written to the queue, so in hashed mode plain names never leave the worker process.
 */

/** `mcp__<server>__<tool>` → its parts; null for any other tool. */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/i.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

/** A name as the wire format accepts it: no whitespace / control characters, ≤ 128 chars. Null when empty. */
export function usageName(raw: string): string | null {
  const s = raw.trim().replace(/[\s\u0000-\u001f\u007f]+/g, '-');
  return s ? s.slice(0, MAX_USAGE_NAME_LENGTH) : null;
}

export function addSkill(counts: SkillCounts, raw: string, source: SkillSource, n = 1): void {
  const name = usageName(raw.replace(/^\//, ''));
  if (!name || n <= 0) return;
  const c = (counts[name] ??= { model: 0, user: 0 });
  c[source] += n;
}

export function addMcp(counts: McpCounts, server: string, tool: string, n = 1): void {
  const s = usageName(server);
  const t = usageName(tool);
  if (!s || !t || n <= 0) return;
  const tools = (counts[s] ??= {});
  tools[t] = (tools[t] ?? 0) + n;
}

/** MCP counts from raw tool name → call count (tools that are not MCP tools are ignored). */
export function mcpFromTools(tools: Record<string, number>): McpCounts {
  const out: McpCounts = {};
  for (const [name, n] of Object.entries(tools)) {
    const p = parseMcpTool(name);
    if (p) addMcp(out, p.server, p.tool, n);
  }
  return out;
}

export function mergeSkills(a: SkillCounts | undefined, b: SkillCounts | undefined): SkillCounts {
  const out: SkillCounts = {};
  for (const src of [a, b]) {
    for (const [name, c] of Object.entries(src ?? {})) {
      addSkill(out, name, 'model', c.model);
      addSkill(out, name, 'user', c.user);
    }
  }
  return out;
}

export function mergeMcp(a: McpCounts | undefined, b: McpCounts | undefined): McpCounts {
  const out: McpCounts = {};
  for (const src of [a, b]) {
    for (const [server, tools] of Object.entries(src ?? {})) for (const [tool, n] of Object.entries(tools)) addMcp(out, server, tool, n);
  }
  return out;
}

const int = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
/** Entries with the largest totals first, capped at `max` (ties: by name, so the cut is deterministic). */
const top = <T>(entries: Array<[string, T]>, total: (v: T) => number, max: number) =>
  entries.sort((x, y) => total(y[1]) - total(x[1]) || (x[0] < y[0] ? -1 : 1)).slice(0, max);

/** Wire-ready skill counts (integers, names cleaned, ≤ 100 entries); undefined when empty. */
export function normalizeSkills(skills: SkillCounts | undefined): SkillCounts | undefined {
  const clean = mergeSkills(undefined, skills);
  const entries = Object.entries(clean)
    .map(([k, c]): [string, { model: number; user: number }] => [k, { model: int(c.model), user: int(c.user) }])
    .filter(([, c]) => c.model + c.user > 0);
  if (!entries.length) return undefined;
  return Object.fromEntries(top(entries, (c) => c.model + c.user, MAX_SKILLS_PER_EVENT));
}

/** Wire-ready MCP counts (integers, names cleaned, ≤ 50 servers × 100 tools); undefined when empty. */
export function normalizeMcp(mcp: McpCounts | undefined): McpCounts | undefined {
  const clean = mergeMcp(undefined, mcp);
  const servers: Array<[string, Record<string, number>]> = [];
  for (const [server, tools] of Object.entries(clean)) {
    const kept = top(
      Object.entries(tools).map(([t, n]): [string, number] => [t, int(n)]).filter(([, n]) => n > 0),
      (n) => n,
      MAX_MCP_TOOLS_PER_SERVER,
    );
    if (kept.length) servers.push([server, Object.fromEntries(kept)]);
  }
  if (!servers.length) return undefined;
  const sum = (t: Record<string, number>) => Object.values(t).reduce((a, b) => a + b, 0);
  return Object.fromEntries(top(servers, sum, MAX_MCP_SERVERS_PER_EVENT));
}

/**
 * Hashed-mode name: `sha256:` + HMAC-SHA256(company salt, input), or plain SHA-256 without a salt (the
 * server's fallback for a plain name arriving in hashed mode uses the same plain input). Inputs are
 * namespaced so a skill and a server with the same name get different hashes:
 * `skill:<name>`, `mcp:<server>`, `mcp:<server>/<tool>`.
 */
export function hashUsageName(input: string, salt: string | null | undefined): string {
  const hex = salt ? createHmac('sha256', salt).update(input).digest('hex') : createHash('sha256').update(input).digest('hex');
  return `sha256:${hex}`;
}

const isHashed = (s: string) => /^sha256:[0-9a-f]{64}$/.test(s);

export function hashSkills(skills: SkillCounts, salt: string | null | undefined): SkillCounts {
  const out: SkillCounts = {};
  for (const [name, c] of Object.entries(skills)) {
    const key = isHashed(name) ? name : hashUsageName(`skill:${name}`, salt);
    const cur = (out[key] ??= { model: 0, user: 0 });
    cur.model += c.model;
    cur.user += c.user;
  }
  return out;
}

export function hashMcp(mcp: McpCounts, salt: string | null | undefined): McpCounts {
  const out: McpCounts = {};
  for (const [server, tools] of Object.entries(mcp)) {
    const s = isHashed(server) ? server : hashUsageName(`mcp:${server}`, salt);
    const dst = (out[s] ??= {});
    for (const [tool, n] of Object.entries(tools)) {
      const t = isHashed(tool) ? tool : hashUsageName(`mcp:${server}/${tool}`, salt);
      dst[t] = (dst[t] ?? 0) + n;
    }
  }
  return out;
}

/** Applies the company's naming mode to the skill / MCP names of turn and run events (plain mode: unchanged). */
export function applyUsageNaming(events: readonly IngestEvent[], naming: ProjectNamingMode, salt: string | null | undefined): IngestEvent[] {
  if (naming !== 'hashed') return [...events];
  return events.map((e) => {
    if ((e.type !== 'turn' && e.type !== 'run') || (!e.skills && !e.mcp && !e.mcp_stats)) return e;
    return {
      ...e,
      ...(e.skills ? { skills: hashSkills(e.skills, salt) } : {}),
      ...(e.mcp ? { mcp: hashMcp(e.mcp, salt) } : {}),
      ...(e.mcp_stats ? { mcp_stats: hashMcpStats(e.mcp_stats, salt) } : {}),
    };
  });
}

/**
 * Codex skill use: the model opens a skill by reading its `SKILL.md` with a shell command (Codex has no
 * skill tool). Returns the skill's directory name, or null when the command does not read a SKILL.md.
 */
export function skillReadBy(command: string): string | null {
  if (!/\b(cat|sed|head|tail|less|more|bat|nl|awk|Get-Content|type)\b/.test(command)) return null;
  const m = /([A-Za-z0-9._:-]+)[\\/]SKILL\.md\b/.exec(command);
  return m ? m[1]! : null;
}

// ------------------------------------------------------------------ MCP reliability (errors, denials, latency)

const emptyStats = (): McpToolStats => ({ errors: 0, denied: 0, ms: 0, buckets: [0, 0, 0, 0, 0] });

/** Index of the latency bucket for a call that took `ms`. */
export function latencyBucket(ms: number): number {
  const i = MCP_LATENCY_BUCKETS_MS.findIndex((b) => ms < b);
  return i < 0 ? MCP_LATENCY_BUCKETS_MS.length : i;
}

/**
 * Records the result of one MCP call. A denied call (the user refused it) is counted as denied only, not as an
 * error; its wall time is not latency. Every other result with a known duration adds it to the histogram.
 */
export function addMcpResult(stats: McpStats, server: string, tool: string, r: { error: boolean; denied: boolean; ms: number | null }): void {
  const s = usageName(server);
  const t = usageName(tool);
  if (!s || !t) return;
  const cur = ((stats[s] ??= {})[t] ??= emptyStats());
  if (r.denied) {
    cur.denied += 1;
    return;
  }
  if (r.error) cur.errors += 1;
  if (r.ms === null) return; // no timing known: an error still counts, latency does not
  const ms = Math.max(0, Math.round(r.ms));
  cur.ms += ms;
  cur.buckets[latencyBucket(ms)]! += 1;
}

function addStats(into: McpToolStats, x: McpToolStats): void {
  into.errors += int(x.errors);
  into.denied += int(x.denied);
  into.ms += int(x.ms);
  for (let i = 0; i < into.buckets.length; i++) into.buckets[i]! += int(x.buckets?.[i] ?? 0);
}

export function mergeMcpStats(a: McpStats | undefined, b: McpStats | undefined): McpStats {
  const out: McpStats = {};
  for (const src of [a, b]) {
    for (const [server, tools] of Object.entries(src ?? {})) {
      for (const [tool, st] of Object.entries(tools)) {
        const s = usageName(server);
        const t = usageName(tool);
        if (s && t) addStats(((out[s] ??= {})[t] ??= emptyStats()), st);
      }
    }
  }
  return out;
}

const statTotal = (x: McpToolStats) => x.errors + x.denied + x.buckets.reduce((a, b) => a + b, 0);

/** Wire-ready stats (integers, ≤ 50 servers × 100 tools, most active kept); undefined when empty. */
export function normalizeMcpStats(stats: McpStats | undefined): McpStats | undefined {
  const clean = mergeMcpStats(undefined, stats);
  const servers: Array<[string, Record<string, McpToolStats>]> = [];
  for (const [server, tools] of Object.entries(clean)) {
    const kept = top(Object.entries(tools).filter(([, x]) => statTotal(x) > 0), statTotal, MAX_MCP_TOOLS_PER_SERVER);
    if (kept.length) servers.push([server, Object.fromEntries(kept)]);
  }
  if (!servers.length) return undefined;
  const sum = (t: Record<string, McpToolStats>) => Object.values(t).reduce((a, x) => a + statTotal(x), 0);
  return Object.fromEntries(top(servers, sum, MAX_MCP_SERVERS_PER_EVENT));
}

export function hashMcpStats(stats: McpStats, salt: string | null | undefined): McpStats {
  const out: McpStats = {};
  for (const [server, tools] of Object.entries(stats)) {
    const s = isHashed(server) ? server : hashUsageName(`mcp:${server}`, salt);
    for (const [tool, st] of Object.entries(tools)) {
      const t = isHashed(tool) ? tool : hashUsageName(`mcp:${server}/${tool}`, salt);
      addStats(((out[s] ??= {})[t] ??= emptyStats()), st);
    }
  }
  return out;
}

/**
 * Claude Code's tool-result text when the user (or the permission mode) refused a tool call. From Claude Code's
 * known messages; not yet seen in a recorded fixture.
 */
const DENIED_RE = /^(The user doesn't want to proceed with this tool use|Permission for this tool use was denied|\[Request interrupted by user for tool use\])/;
export const isDeniedResult = (text: string): boolean => DENIED_RE.test(text.trimStart());
