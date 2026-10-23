import { spawn } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectorContext, HarnessAdapter } from '../adapters/types.js';
import { cleanSummaryText, turnSummaryEvent } from '../events.js';
import { errorMessage, readJsonFile, withTimeout, writeJsonAtomic } from '../fsutil.js';
import type { Logger } from '../log.js';
import { SUMMARIZING_ENV, type TurnSummaryEvent } from '../protocol-types.js';
import type { StreamKey } from '../queue.js';
import { ulid } from '../ulid.js';
import type { TurnDigest } from './digest.js';

export const SUMMARY_TIMEOUT_MS = 120_000;
/** A chunk whose summarize call has not settled after this long counts as a failed attempt (the command itself is killed at SUMMARY_TIMEOUT_MS). */
export const SUMMARY_CHUNK_TIMEOUT_MS = SUMMARY_TIMEOUT_MS + 10_000;
/** Turns per headless call; a normal session fits in one call. */
export const SUMMARY_CHUNK = 25;
const MAX_ATTEMPTS = 5;
const MAX_PENDING_AGE_MS = 7 * 24 * 3600_000;
const MAX_PENDING = 200;

/** Summarize mid-session once this many turns are waiting (long sessions). */
export const SUMMARY_BATCH = 10;
/** … or once the oldest waiting turn has waited this long (ADR-0023: a dashboard turn should not stay without a summary for hours). */
export const SUMMARY_MAX_WAIT_MS = 10 * 60_000;

/**
 * Whether an adapter should hand its pending digests to the summarizer now (ADR-0023): at session end, with
 * SUMMARY_BATCH or more turns waiting, or when the first of them has waited SUMMARY_MAX_WAIT_MS (`since` = the hook
 * time at which the adapter first saw digests pending; undefined = none pending yet). Pure.
 */
export function summariesDue(s: { ended: boolean; pending: number; since: number | undefined; now: number }): boolean {
  if (s.pending <= 0) return false;
  if (s.ended || s.pending >= SUMMARY_BATCH) return true;
  return s.since !== undefined && s.now - s.since >= SUMMARY_MAX_WAIT_MS;
}

// ---------------------------------------------------------------- prompt

/**
 * ONE batched prompt for all digests. Turns get short ids (t1, t2, …) so the model cannot mangle real
 * turn ids; `ids` maps them back.
 */
export function buildSummaryPrompt(digests: readonly TurnDigest[]): { prompt: string; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const turns = digests.map((d, i) => {
    const shortId = `t${i + 1}`;
    ids.set(shortId, d.turnId);
    return { id: shortId, prompt: d.prompt, tools: d.tools, last_message: d.lastAssistantMessage };
  });
  const prompt = [
    'You write one-line summaries of AI coding-agent turns for a usage dashboard.',
    'For EACH turn below write what was done, in English, at most 140 characters, past tense,',
    'e.g. "Added JWT refresh to auth middleware". Do not include file paths, code, URLs, secrets or names of people.',
    'Reply with ONLY a JSON object that maps every turn id to its summary, e.g. {"t1": "...", "t2": "..."}. No other text.',
    '',
    'Turns (JSON):',
    JSON.stringify(turns),
  ].join('\n');
  return { prompt, ids };
}

/**
 * Path-looking words → their last segment, so a stray path in a summary does not leave the machine.
 * A word counts as a path when it starts with `/`, `~`, `.` or a drive letter, has two or more
 * separators, or ends in a file name with an extension (`src/auth.ts`). URLs and `and/or` are kept.
 */
export function scrubPaths(s: string): string {
  return s
    .split(/(\s+)/)
    .map((word) => {
      if (!/[\\/]/.test(word) || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return word;
      const m = /^(["'(`]*)(.*?)([)"'`.,;:!?]*)$/.exec(word);
      const [, pre = '', core = '', post = ''] = m ?? [];
      const parts = core.split(/[\\/]+/).filter(Boolean);
      const last = parts.at(-1) ?? '';
      const isPath =
        /^(?:[\\/]|~|\.{1,2}[\\/]|[a-z]:[\\/])/i.test(core) ||
        (core.match(/[\\/]/g)?.length ?? 0) >= 2 ||
        /\.[a-z0-9]{1,6}$/i.test(last);
      return isPath && last ? `${pre}${last}${post}` : word;
    })
    .join('');
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
      const a = c.indexOf(open);
      const b = c.lastIndexOf(close);
      if (a >= 0 && b > a) {
        try {
          return JSON.parse(c.slice(a, b + 1));
        } catch {
          /* try next */
        }
      }
    }
  }
  return null;
}

/**
 * Parses the model's reply robustly: a JSON object `{"t1": "…"}` (optionally in a ``` fence or
 * surrounded by prose), an array of `{id, summary}`, or `t1: …` lines. Returns turnId → summary
 * (cleaned, path-scrubbed, ≤ 140 chars). Unknown ids are ignored.
 */
export function parseSummaryResponse(text: string, ids: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const put = (shortId: unknown, summary: unknown) => {
    const turnId = typeof shortId === 'string' ? ids.get(shortId.trim()) : undefined;
    if (!turnId || typeof summary !== 'string') return;
    const clean = cleanSummaryText(scrubPaths(summary).replace(/^["'`]+|["'`]+$/g, ''));
    if (clean) out.set(turnId, clean);
  };
  const json = extractJson(text);
  if (Array.isArray(json)) {
    for (const item of json) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        put(o.id ?? o.turn ?? o.turn_id, o.summary ?? o.text);
      }
    }
  } else if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const inner = obj.summaries && typeof obj.summaries === 'object' ? (obj.summaries as Record<string, unknown>) : obj;
    for (const [k, v] of Object.entries(inner)) put(k, v);
  }
  if (!out.size) {
    for (const m of text.matchAll(/^\s*[-*]?\s*"?(t\d+)"?\s*[:=\-–]\s*(.+?)\s*,?\s*$/gim)) put(m[1], m[2]);
  }
  return out;
}

// ---------------------------------------------------------------- running the cheap model

export interface RunCommandResult {
  ok: boolean;
  stdout: string;
  code: number | null;
  timedOut: boolean;
  error?: string;
}

/**
 * Runs a headless harness command (e.g. `claude -p --model haiku`) with AI_OBS_SUMMARIZING=1 so our
 * hooks exit immediately inside it (recursion guard). Prompt goes to stdin when `input` is set.
 * Own process group, so a timeout (default 120 s) kills the whole tree. Never throws.
 */
export function runSummaryCommand(opts: {
  argv: readonly string[];
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
}): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = opts.argv;
    if (!cmd) return resolve({ ok: false, stdout: '', code: null, timedOut: false, error: 'empty command' });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, [SUMMARIZING_ENV]: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      return resolve({ ok: false, stdout: '', code: null, timedOut: false, error: errorMessage(err) });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: RunCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs ?? SUMMARY_TIMEOUT_MS);
    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < 1_000_000) stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 2000) stderr += c.toString('utf8');
    });
    child.on('error', (err) => finish({ ok: false, stdout, code: null, timedOut, error: errorMessage(err) }));
    child.on('close', (code) =>
      finish({
        ok: code === 0 && !timedOut,
        stdout,
        code,
        timedOut,
        ...(code === 0 && !timedOut ? {} : { error: timedOut ? 'timeout' : `exit ${code}: ${stderr.slice(0, 200)}` }),
      }),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });
}

/**
 * Convenience for HarnessAdapter.summarize(): builds the batched prompt, runs the command, parses.
 * `command(prompt)` returns argv plus whether the prompt goes on stdin (`input`) or in argv.
 * `extractText` unwraps harness output formats (e.g. a JSON envelope) before parsing.
 */
export async function summarizeWithCommand(
  digests: readonly TurnDigest[],
  opts: {
    command: (prompt: string) => { argv: string[]; input?: string; env?: Record<string, string> };
    extractText?: (stdout: string) => string;
    timeoutMs?: number;
    cwd?: string;
  },
): Promise<Map<string, string>> {
  if (!digests.length) return new Map();
  const { prompt, ids } = buildSummaryPrompt(digests);
  const cmd = opts.command(prompt);
  const res = await runSummaryCommand({ ...cmd, timeoutMs: opts.timeoutMs, cwd: opts.cwd });
  if (!res.ok) throw new Error(`summary command failed: ${res.error ?? 'unknown'}`);
  return parseSummaryResponse(opts.extractText ? opts.extractText(res.stdout) : res.stdout, ids);
}

// ---------------------------------------------------------------- pipeline with retry

interface PendingDigest extends TurnDigest {
  attempts: number;
  firstFailedAt: number;
  /** the session's stream; a digest written by 0.1.x has none and is dropped (C16) */
  key?: StreamKey;
}

/** Failed digests (local only, mode 0600): ~/.ai-obs/state/summaries/<harness>.json */
export function pendingSummariesPath(stateDir: string, harness: string): string {
  return join(stateDir, 'summaries', `${harness}.json`);
}

/**
 * Digests due for summarising, written by the hook's job and read by the summary phase after the worker's flush
 * (ADR-0027): ~/.ai-obs/state/summaries/staged/<harness>/<ulid>.json (local only, mode 0600).
 */
export function stagedSummariesDir(stateDir: string, harness: string): string {
  return join(stateDir, 'summaries', 'staged', harness);
}

const STAGED_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.json$/;

/** One staged file per call (attempts 0, firstFailedAt = nowMs, key). Null key: logged, nothing written. Empty: no-op. Throws on write failure. */
export function stageDigests(stateDir: string, harness: string, digests: readonly TurnDigest[], key: StreamKey | null, nowMs: number, log: Logger): void {
  if (!digests.length) return;
  if (!key) {
    log.info('summaries: session not recorded, digests dropped', { harness, count: digests.length });
    return;
  }
  const staged: PendingDigest[] = digests.map((d) => ({ ...d, attempts: 0, firstFailedAt: nowMs, key }));
  writeJsonAtomic(join(stagedSummariesDir(stateDir, harness), `${ulid(nowMs)}.json`), staged);
}

/** Staged file paths, oldest first (ulid names sort by time); [] when none. */
export function listStagedDigests(stateDir: string, harness: string): string[] {
  const dir = stagedSummariesDir(stateDir, harness);
  try {
    return readdirSync(dir)
      .filter((n) => STAGED_RE.test(n))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** Number of staged digests (sum of file lengths). */
export function countStagedDigests(stateDir: string, harness: string): number {
  return listStagedDigests(stateDir, harness).reduce((n, f) => {
    const v = readJsonFile<unknown>(f);
    return n + (Array.isArray(v) ? v.length : 0);
  }, 0);
}

/** `turn_summary` events of one stream. */
export interface SummaryGroup {
  key: StreamKey;
  events: TurnSummaryEvent[];
}

export interface SummaryBatchOptions {
  /** Queues the summaries (and sends them); false = not done, so the staged and pending files stay untouched. */
  commit(groups: SummaryGroup[]): Promise<boolean>;
  /** run even with nothing staged (retry the pending digests; `ai-obs flush`) */
  retry?: boolean;
  /**
   * Wall-clock epoch ms after which no further chunk starts: the digests not tried yet are stored as pending (no
   * attempt counted) and the batch still commits what it has (default: no deadline).
   */
  deadline?: number;
  /** One chunk's summarize call taking longer counts as a failed attempt (default SUMMARY_CHUNK_TIMEOUT_MS). */
  chunkTimeoutMs?: number;
}

/**
 * Summarizes the staged digests plus previously failed ones and hands the `turn_summary` events to
 * `opts.commit`, grouped by stream (ADR-0027). Only after a successful commit the digests still missing are
 * stored for the next run (max 5 attempts / 7 days, staged ones too) and the staged files are deleted, so a crash or a refused
 * commit loses nothing: the next run summarises them again, with the same event ids (the time is the digest's
 * `firstFailedAt`). Pending digests without a stream (0.1.x) are dropped. Digests never leave the machine.
 * Null when there was nothing staged (and no `retry`) or the commit was refused. Run under summaries.lock.
 */
export async function runSummaryBatch(
  adapter: Pick<HarnessAdapter, 'name' | 'summarize'>,
  ctx: CollectorContext,
  opts: SummaryBatchOptions,
): Promise<{ summarized: number; pending: number } | null> {
  const files = listStagedDigests(ctx.paths.state, adapter.name);
  if (!files.length && !opts.retry) return null;
  const file = pendingSummariesPath(ctx.paths.state, adapter.name);
  const nowMs = ctx.now().getTime();
  const pending = new Map<string, PendingDigest>();
  let unkeyed = 0;
  for (const p of readJsonFile<PendingDigest[]>(file) ?? []) {
    if (!p.key) {
      unkeyed++;
      continue;
    }
    if (p.attempts < MAX_ATTEMPTS && nowMs - p.firstFailedAt < MAX_PENDING_AGE_MS) pending.set(p.turnId, p);
  }
  if (unkeyed) ctx.log.warn('summaries: pending digests without a stream dropped', { harness: adapter.name, count: unkeyed });

  const staged: string[] = [];
  for (const f of files) {
    const list = readJsonFile<PendingDigest[]>(f);
    if (!Array.isArray(list)) {
      ctx.log.warn('summaries: unreadable staged digests dropped', { harness: adapter.name });
      rmSync(f, { force: true });
      continue;
    }
    staged.push(f);
    for (const d of list) {
      if (!d || typeof d.turnId !== 'string' || !d.key) continue;
      const prev = pending.get(d.turnId);
      const firstFailedAt = prev?.firstFailedAt ?? d.firstFailedAt;
      if (!(nowMs - firstFailedAt < MAX_PENDING_AGE_MS)) continue; // a staged digest expires like a pending one
      pending.set(d.turnId, { ...d, attempts: prev?.attempts ?? 0, firstFailedAt, key: d.key });
    }
  }

  const all = [...pending.values()];
  const byKey = new Map<string, SummaryGroup>();
  let summarized = 0;
  for (let i = 0; i < all.length; i += SUMMARY_CHUNK) {
    // past the deadline the rest waits in the pending file, so the work done so far is committed, not thrown away
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
    const chunk = all.slice(i, i + SUMMARY_CHUNK);
    let result = new Map<string, string>();
    try {
      result = await withTimeout(
        adapter.summarize(
          chunk.map(({ attempts: _a, firstFailedAt: _f, key: _k, ...d }) => d),
          ctx,
        ),
        opts.chunkTimeoutMs ?? SUMMARY_CHUNK_TIMEOUT_MS,
        `${adapter.name} summarize`,
      );
    } catch (err) {
      ctx.log.warn('summaries: summarize failed, will retry', { harness: adapter.name, turns: chunk.length, error: errorMessage(err).slice(0, 200) });
    }
    for (const d of chunk) {
      const text = result.get(d.turnId);
      // stable id: a re-run after a refused commit or a crash re-sends the same event (ADR-0011)
      const ev = text ? turnSummaryEvent({ harness: adapter.name, turnId: d.turnId, summary: text, at: d.firstFailedAt }) : null;
      if (ev && d.key) {
        const tag = JSON.stringify(d.key);
        const group = byKey.get(tag) ?? { key: d.key, events: [] };
        group.events.push(ev);
        byKey.set(tag, group);
        summarized++;
        pending.delete(d.turnId);
      } else {
        d.attempts += 1;
      }
    }
  }
  if (!(await opts.commit([...byKey.values()]))) return null;
  const left = [...pending.values()].filter((p) => p.attempts < MAX_ATTEMPTS).slice(-MAX_PENDING);
  try {
    writeJsonAtomic(file, left);
  } catch (err) {
    // the staged files stay: the next run re-sends their summaries under the same ids
    ctx.log.error('summaries: cannot store pending digests', { error: errorMessage(err) });
    return { summarized, pending: left.length };
  }
  for (const f of staged) rmSync(f, { force: true });
  return { summarized, pending: left.length };
}
