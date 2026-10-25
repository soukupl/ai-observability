/**
 * The SessionStart nudge: one short text the hook puts into the agent's context, only when (a) the
 * repository has no dot-file server and two or more servers are registered (run `ai-obs link`), (b) the
 * repository's server has no token, or an expired or refused one (run `ai-obs login --server …`), (c) its
 * token expires within 14 days, (d) queued events were dropped. Identifiers only (hosts, URLs, the sanitized
 * directory), at most 1000 characters, once per session per text. No git call. Imports only fs-level modules: the hook must stay fast.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { shellQuote } from './adapters/hook-command.js';
import { daysLeft, findServer, isExpired, loadConfig } from './config.js';
import { droppedTotal, markDroppedShown, readDelivery, readDropped, serverDelivery } from './delivery.js';
import { lookupDotFile } from './dotfile.js';
import { writeFileAtomic } from './fsutil.js';
import { nudgeMarkerPath, type AiObsPaths } from './paths.js';
import type { HarnessName } from './protocol-types.js';

/**
 * How SessionStart output reaches the agent. Claude Code: JSON `hookSpecificOutput.additionalContext`.
 * Codex (codex-cli 0.154.0): plain stdout; the JSON form is rejected there (see adapters/codex/FORMAT.md).
 * `none` keeps the hook silent (the CLI still shows everything).
 */
export const SESSION_START_OUTPUT: Record<HarnessName, 'json' | 'text' | 'none'> = { 'claude-code': 'json', codex: 'text' };

export function formatSessionStartOutput(harness: HarnessName, text: string): string | null {
  const mode = SESSION_START_OUTPUT[harness];
  if (mode === 'json') return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`;
  if (mode === 'text') return `${text}\n`;
  return null;
}

/** Hook-name normalization: `SessionStart`, `session_start` and `session-start` are the same event. */
export const isSessionStart = (hook: string): boolean => hook.replace(/[_-]/g, '').toLowerCase() === 'sessionstart';

export const NUDGE_MAX_CHARS = 1000;
/** A token expiring within this many days is mentioned (brief Q6). */
export const EXPIRY_NUDGE_DAYS = 14;
const SAFE = /^[A-Za-z0-9._~:/@+ -]+$/;
const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/;
const MAX_HOSTS = 10;
const ASK = ' If you cannot ask the user (for example in a non-interactive session), do nothing.';
const DAY_MS = 86_400_000;

export type NudgeMain =
  | { kind: 'link'; hosts: string[] }
  | { kind: 'login'; server: string; reason: 'no-token' | 'expired' | 'rejected' }
  | { kind: 'expiring'; server: string; days: number; date: string };

export interface NudgeInput {
  main: NudgeMain | null;
  /** kept (held) events deleted by the size cap that the user has not been told about */
  droppedEvents?: number;
  /** sendable events deleted by the 30-day / size caps that the user has not been told about (C13) */
  droppedSendable?: number;
  /** argv of this collector (`[node, entry, ...]`); null = `ai-obs` on PATH */
  selfCommand: readonly string[] | null;
  /** the session's working directory */
  dir: string | null;
}

/** A host as the text may show it, or null. */
export function safeHost(endpoint: string): string | null {
  try {
    const h = new URL(endpoint).host.toLowerCase();
    return HOST_RE.test(h) ? h : null;
  } catch {
    return null;
  }
}

/** Pure. Null when there is nothing to say. */
export function buildNudge(input: NudgeInput): string | null {
  const cmdSafe = input.selfCommand !== null && input.selfCommand.length > 0 && input.selfCommand.every((a) => SAFE.test(a));
  const fullCmd = cmdSafe ? input.selfCommand!.map(shellQuote).join(' ') : 'ai-obs';
  const dirSafe = input.dir !== null && SAFE.test(input.dir);

  /** `cmdForm`: the collector's command in every command, written once, or plain `ai-obs`; `withDir`: `--project-dir` or "run it from the root". */
  type Form = { cmdForm: 'full' | 'once' | 'plain'; withDir: boolean; listMax: number; hostOnly?: boolean };
  const build = ({ cmdForm, withDir, listMax, hostOnly }: Form): string | null => {
    const form = cmdSafe && fullCmd !== 'ai-obs' ? cmdForm : 'plain';
    const cmd = form === 'full' ? fullCmd : 'ai-obs';
    const cmdNote =
      form === 'once' ? ` (\`ai-obs\` here means \`${fullCmd}\`)` : form === 'plain' && !(cmdSafe && fullCmd === 'ai-obs') ? ' (if `ai-obs` is not on PATH, ask the user to run the command)' : '';
    const dirOk = dirSafe && withDir;
    const dirFlag = dirOk ? ` --project-dir ${shellQuote(input.dir!)}` : '';
    const dirNote = dirOk ? '' : " Run it from this repository's root directory.";
    const server = (endpoint: string) =>
      !hostOnly && SAFE.test(endpoint) ? { text: endpoint, arg: shellQuote(endpoint) } : { text: safeHost(endpoint) ?? 'the server', arg: '<url>' };
    const parts: string[] = [];
    const m = input.main;
    if (m) {
      switch (m.kind) {
        case 'link': {
          const shown = m.hosts.slice(0, listMax);
          const more = m.hosts.length - shown.length;
          parts.push(
            `ai-obs: this repository has no .ai-obs.json and this machine is logged in to ${m.hosts.length} ai-obs servers (${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}), so its AI usage data is kept on this machine and not reported. Ask the user which server this repository reports to, then run \`${cmd} link --server <url>${dirFlag}\`.${dirNote} Do not choose without asking; ask only once in this session.${cmdNote}${ASK}`,
          );
          break;
        }
        case 'login': {
          const s = server(m.server);
          const what =
            m.reason === 'no-token'
              ? `this repository reports to ${s.text} (its .ai-obs.json), but this machine is not logged in to that server`
              : m.reason === 'expired'
                ? `the ai-obs token for ${s.text} has expired`
                : `${s.text} rejected this machine's ai-obs token (expired or revoked)`;
          parts.push(
            `ai-obs: ${what}, so usage data of this repository is kept on this machine. Tell the user to run \`${cmd} login --server ${s.arg}\` themselves (it opens the browser to approve the login; never ask for a token).${cmdNote}`,
          );
          break;
        }
        case 'expiring': {
          const s = server(m.server);
          parts.push(
            `ai-obs: the ai-obs token for ${s.text} expires ${m.days <= 0 ? 'today' : `in ${m.days} day${m.days === 1 ? '' : 's'}`} (${m.date}). Tell the user to run \`${cmd} login --server ${s.arg}\` before then.${cmdNote}`,
          );
          break;
        }
      }
    }
    if (input.droppedEvents && input.droppedEvents > 0)
      parts.push(`Note: ai-obs deleted ${Math.floor(input.droppedEvents)} kept events because its local queue reached the 50 MB cap; tell the user (\`${cmd} status\`).`);
    if (input.droppedSendable && input.droppedSendable > 0)
      parts.push(`Note: ai-obs deleted ${Math.floor(input.droppedSendable)} events it could not send in time (30-day / 50 MB queue caps); tell the user (\`${cmd} status\`).`);
    return parts.length ? parts.join(' ') : null;
  };

  // Shorten: the repeated command first (once, then not at all), then --project-dir, then the hosts named.
  const attempts: Form[] = [
    { cmdForm: 'full', withDir: true, listMax: MAX_HOSTS },
    { cmdForm: 'once', withDir: true, listMax: MAX_HOSTS },
    { cmdForm: 'plain', withDir: true, listMax: MAX_HOSTS },
    { cmdForm: 'plain', withDir: false, listMax: MAX_HOSTS },
  ];
  for (let n = MAX_HOSTS - 1; n >= 1; n--) attempts.push({ cmdForm: 'plain', withDir: false, listMax: n });
  attempts.push({ cmdForm: 'plain', withDir: false, listMax: 1, hostOnly: true }); // a long server URL: name its host only
  let text: string | null = null;
  for (const a of attempts) {
    text = build(a);
    if (text === null || text.length <= NUDGE_MAX_CHARS) return text;
  }
  return text === null ? null : text.slice(0, NUDGE_MAX_CHARS);
}

export interface NudgeContext {
  paths: AiObsPaths;
  cwd: string;
  sessionId: unknown;
  /** wall clock, ms */
  now: number;
  selfCommand: readonly string[] | null;
}

interface Decision {
  main: NudgeMain | null;
  /** the repository root (where `link` writes the dot file); null outside git */
  root: string | null;
}

/** (a) – (c): no network, local files only. */
function decideMain(ctx: NudgeContext): Decision | null {
  const config = loadConfig(ctx.paths);
  if (!config) return null;
  const dot = lookupDotFile(ctx.cwd, { cache: ctx.paths });
  const root = dot.root;
  const servers = config.servers;
  if (!dot.server && servers.length >= 2) {
    const hosts = servers.map((s) => safeHost(s.endpoint)).filter((h): h is string => h !== null);
    return { main: { kind: 'link', hosts }, root };
  }
  const endpoint = dot.server ?? (servers.length === 1 ? servers[0]!.endpoint : null);
  if (!endpoint) return { main: null, root };
  const entry = findServer(config, endpoint);
  if (!entry) return { main: { kind: 'login', server: endpoint, reason: 'no-token' }, root };
  if (isExpired(entry, ctx.now)) return { main: { kind: 'login', server: endpoint, reason: 'expired' }, root };
  let blocked = false;
  try {
    blocked = !!serverDelivery(readDelivery(ctx.paths), entry).blocked;
  } catch {
    blocked = false;
  }
  if (blocked) return { main: { kind: 'login', server: endpoint, reason: 'rejected' }, root };
  const days = daysLeft(entry, ctx.now);
  if (days !== null && Date.parse(entry.expires_at!) - ctx.now <= EXPIRY_NUDGE_DAYS * DAY_MS) {
    return { main: { kind: 'expiring', server: endpoint, days, date: entry.expires_at!.slice(0, 10) }, root };
  }
  return { main: null, root };
}

export interface Nudge {
  text: string;
  /** call after the text was written to stdout: records the once-per-session marker and the dropped-counter mark */
  commit: () => void;
}

/** The SessionStart nudge for this session, or null. Never throws. */
export async function computeNudge(ctx: NudgeContext): Promise<Nudge | null> {
  const d = decideMain(ctx);
  if (!d) return null;
  let droppedEvents = 0;
  let droppedSendable = 0;
  let droppedShown = false;
  const dropped = readDropped(ctx.paths);
  if (droppedTotal(dropped) > 0 && dropped.last_at && (!dropped.shown_at || dropped.last_at > dropped.shown_at)) {
    // the counters are lifetime totals: report only what was dropped since the text last mentioned it
    droppedEvents = Math.max(0, dropped.held_events - dropped.shown_held);
    droppedSendable = Math.max(0, dropped.sendable_events - dropped.shown_sendable);
    droppedShown = true;
  }
  const text = buildNudge({ main: d.main, droppedEvents, droppedSendable, selfCommand: ctx.selfCommand, dir: d.root ?? ctx.cwd });
  if (text === null) return null;

  const markerFile = nudgeMarkerPath(ctx.paths, ctx.sessionId);
  const digest = createHash('sha1').update(text).digest('hex');
  if (markerFile) {
    try {
      if (readFileSync(markerFile, 'utf8').trim() === digest) return null; // already shown in this session
    } catch {
      /* no marker yet */
    }
  }
  return {
    text,
    commit: () => {
      if (markerFile) {
        try {
          mkdirSync(dirname(markerFile), { recursive: true, mode: 0o700 });
          writeFileAtomic(markerFile, digest, 0o600);
        } catch {
          /* a missing marker only repeats the text */
        }
      }
      if (droppedShown) {
        try {
          markDroppedShown(ctx.paths, new Date(ctx.now), dropped);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
