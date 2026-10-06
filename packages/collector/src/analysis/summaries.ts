import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { CollectorContext, HarnessAdapter } from '../adapters/types.js';
import { cleanSummaryText, turnSummaryEvent } from '../events.js';
import { errorMessage, readJsonFile, writeJsonAtomic } from '../fsutil.js';
import { SUMMARIZING_ENV, type IngestEvent } from '../protocol-types.js';
import type { TurnDigest } from './digest.js';

export const SUMMARY_TIMEOUT_MS = 120_000;
/** Turns per headless call; a normal session fits in one call. */
export const SUMMARY_CHUNK = 25;
const MAX_ATTEMPTS = 5;
const MAX_PENDING_AGE_MS = 7 * 24 * 3600_000;
const MAX_PENDING = 200;

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
}

/** Failed digests (local only, mode 0600): ~/.ai-obs/state/summaries/<harness>.json */
export function pendingSummariesPath(stateDir: string, harness: string): string {
  return join(stateDir, 'summaries', `${harness}.json`);
}

/**
 * Summarizes new digests plus previously failed ones, enqueues `turn_summary` events and stores
 * what is still missing for the next run (max 5 attempts / 7 days). Only summaries are enqueued;
 * digests never leave the machine. Never throws.
 */
export async function summarizeAndQueue(
  adapter: Pick<HarnessAdapter, 'name' | 'summarize'>,
  digests: readonly TurnDigest[],
  ctx: CollectorContext,
): Promise<{ summarized: number; pending: number }> {
  const file = pendingSummariesPath(ctx.paths.state, adapter.name);
  const nowMs = ctx.now().getTime();
  const pending = new Map<string, PendingDigest>();
  for (const p of readJsonFile<PendingDigest[]>(file) ?? []) {
    if (p.attempts < MAX_ATTEMPTS && nowMs - p.firstFailedAt < MAX_PENDING_AGE_MS) pending.set(p.turnId, p);
  }
  for (const d of digests) pending.set(d.turnId, { ...d, attempts: pending.get(d.turnId)?.attempts ?? 0, firstFailedAt: pending.get(d.turnId)?.firstFailedAt ?? nowMs });

  const all = [...pending.values()];
  const events: IngestEvent[] = [];
  for (let i = 0; i < all.length; i += SUMMARY_CHUNK) {
    const chunk = all.slice(i, i + SUMMARY_CHUNK);
    let result = new Map<string, string>();
    try {
      result = await adapter.summarize(
        chunk.map(({ attempts: _a, firstFailedAt: _f, ...d }) => d),
        ctx,
      );
    } catch (err) {
      ctx.log.warn('summaries: summarize failed, will retry', { harness: adapter.name, turns: chunk.length, error: errorMessage(err).slice(0, 200) });
    }
    for (const d of chunk) {
      const text = result.get(d.turnId);
      const ev = text ? turnSummaryEvent({ harness: adapter.name, turnId: d.turnId, summary: text, at: ctx.now() }) : null;
      if (ev) {
        events.push(ev);
        pending.delete(d.turnId);
      } else {
        d.attempts += 1;
      }
    }
  }
  if (events.length) ctx.queue.enqueue(events);
  const left = [...pending.values()].filter((p) => p.attempts < MAX_ATTEMPTS).slice(-MAX_PENDING);
  try {
    writeJsonAtomic(file, left);
  } catch (err) {
    ctx.log.error('summaries: cannot store pending digests', { error: errorMessage(err) });
  }
  return { summarized: events.length, pending: left.length };
}
