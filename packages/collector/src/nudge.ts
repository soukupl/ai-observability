/**
 * The SessionStart nudge (collector design §4): when a repository has no usable token choice, a token is
 * rejected or unconfirmed, or kept events were dropped, the hook prints one short text into the agent's
 * context so the agent asks the user and runs `ai-obs use`. Imports only fs-level modules: the hook must stay fast.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { shellQuote } from './adapters/hook-command.js';
import { tokenKind, type TokenEntry } from './config.js';
import { droppedTotal, markDroppedShown, readDropped } from './delivery.js';
import { writeFileAtomic } from './fsutil.js';
import { nudgeMarkerPath, type AiObsPaths } from './paths.js';
import { cachedPk, readPkCache } from './pk-cache.js';
import { captureBinding, effectiveCompany, loadRouting, routable, streamDirName, OPEN, type OpenReason, type RoutingView } from './projects.js';
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
const SAFE = /^[A-Za-z0-9._~:/@+ -]+$/;
const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/;
const SLUG_RE = /^[a-z0-9-]{1,47}$/;
const MAX_LIST = 10;
const ASK = ' If you cannot ask the user (for example in a non-interactive session), do nothing.';

/** A registered token as the nudge text may show it: validated identifiers only, never the token or a display name. */
export interface NudgeToken {
  name: string;
  kind: 'user token' | 'company token';
  slug?: string;
  host?: string;
}

export type NudgeMain =
  | { kind: 'unassigned' | 'dangling'; key: string; tokens: NudgeToken[]; assignedTo?: string }
  | { kind: 'open-backlog'; key: string; only: string }
  | { kind: 'unverified'; name: string; reportedSlug?: string }
  | { kind: 'config-damaged' | 'projects-unreadable' }
  | { kind: 'no-tokens'; revoked: boolean }
  | { kind: 'blocked'; name: string; status: 401 | 403; host?: string; slug?: string };

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

/** Project keys reach the agent as quoted data: anything outside SAFE becomes `?`, at most 200 chars. */
export function safeKey(key: string): string {
  let out = '';
  for (const ch of key.slice(0, 200)) out += SAFE.test(ch) ? ch : '?';
  return `"${out}"`;
}

function describeToken(t: NudgeToken): string {
  const parts = [t.slug ? `company ${t.slug}` : null, t.kind, t.host ?? null].filter(Boolean);
  return `"${t.name}" (${parts.join(', ')})`;
}

/** Pure. Null when there is nothing to say. */
export function buildNudge(input: NudgeInput): string | null {
  const cmdSafe = input.selfCommand !== null && input.selfCommand.length > 0 && input.selfCommand.every((a) => SAFE.test(a));
  const fullCmd = cmdSafe ? input.selfCommand!.map(shellQuote).join(' ') : 'ai-obs';
  const dirSafe = input.dir !== null && SAFE.test(input.dir);

  /**
   * `detail`: token descriptions (company, kind, host) or names only. `cmdForm`: the collector's command in every
   * command (`full`), written once (`once`), or plain `ai-obs` (`plain`). `dirFlag`: `--project-dir` in the commands
   * or "run it from the repository's root". `listMax`: how many tokens to name.
   */
  type Form = { detail: boolean; cmdForm: 'full' | 'once' | 'plain'; dirFlag: boolean; listMax: number };
  const build = ({ detail, cmdForm, dirFlag: withDir, listMax }: Form): string | null => {
    const form = cmdSafe && fullCmd !== 'ai-obs' ? cmdForm : 'plain';
    const cmd = form === 'full' ? fullCmd : 'ai-obs';
    const cmdNote =
      form === 'once' ? ` (\`ai-obs\` here means \`${fullCmd}\`)` : form === 'plain' && !(cmdSafe && fullCmd === 'ai-obs') ? ' (if `ai-obs` is not on PATH, ask the user to run the command)' : '';
    const dirOk = dirSafe && withDir;
    const dirFlag = dirOk ? ` --project-dir ${shellQuote(input.dir!)}` : '';
    const dirNote = dirOk ? '' : " Run it from this repository's root directory.";
    const use = (name: string) => `${cmd} use ${name}${dirFlag}`;
    const m = input.main;
    const parts: string[] = [];
    if (m) {
      switch (m.kind) {
        case 'unassigned':
        case 'dangling': {
          const shown = m.tokens.slice(0, listMax);
          const more = m.tokens.length - shown.length;
          const list = `${shown.map((t) => (detail ? describeToken(t) : `"${t.name}"`)).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
          if (m.kind === 'unassigned')
            parts.push(
              `ai-obs: this repository (${safeKey(m.key)}) has no ai-obs token yet, so its AI usage data is kept on this machine and not reported. Registered tokens: ${list}. Ask the user which company this repository's work belongs to, then run \`${use('<name>')}\`. If the user says it should not be reported, run \`${cmd} use --none${dirFlag}\` (this keeps the data on this machine, it deletes nothing).${dirNote} Do not choose without asking; ask only once in this session.${cmdNote}${ASK}`,
            );
          else
            parts.push(
              `ai-obs: this repository (${safeKey(m.key)}) was assigned to the token "${m.assignedTo ?? '?'}", which is no longer registered or now belongs to another company, so new usage data is kept on this machine. Registered tokens: ${list}. Ask the user which one to use, then run \`${use('<name>')}\`.${dirNote}${cmdNote}${ASK}`,
            );
          break;
        }
        case 'open-backlog':
          parts.push(
            `ai-obs: usage data of this repository (${safeKey(m.key)}) recorded while several ai-obs tokens were registered is kept on this machine. Ask the user whether it belongs to "${m.only}"; if yes run \`${use(m.only)}\`, if it should not be reported run \`${cmd} use --none${dirFlag}\`.${dirNote}${cmdNote}${ASK}`,
          );
          break;
        case 'unverified':
          parts.push(
            `ai-obs: the token "${m.name}" used for this repository is not confirmed (${m.reportedSlug ? `the server reports company "${m.reportedSlug}"` : 'the server was not reachable'}), so usage data is kept on this machine. Tell the user to run \`${cmd} token confirm ${m.name}\`.${cmdNote}`,
          );
          break;
        case 'config-damaged':
          parts.push(`ai-obs: config.json contains malformed token entries, so usage data of repositories without an explicit token is kept on this machine. Tell the user to run \`${cmd} doctor\`.${cmdNote}`);
          break;
        case 'projects-unreadable':
          parts.push(`ai-obs: projects.json cannot be read, so usage data of new sessions is kept on this machine. Tell the user to run \`${cmd} doctor\`.${cmdNote}`);
          break;
        case 'no-tokens':
          parts.push(
            `ai-obs is installed but has no usable token, so nothing is recorded${m.revoked ? ' (the token used before the upgrade was revoked)' : ''}. Tell the user to create a token in the ai-obs dashboard and run \`${cmd} init --token <token> --endpoint <url>\` themselves (do not ask for the token).${cmdNote}`,
          );
          break;
        case 'blocked':
          parts.push(
            m.status === 401
              ? `ai-obs: ${m.host ?? 'the server'} rejected the token "${m.name}" (HTTP 401: revoked, or the user left the company). Usage data for this repository is kept on this machine. Tell the user to create a new token in the ai-obs dashboard and run \`${cmd} token add --token <new token> --name ${m.name}\` themselves (do not ask for the token).${cmdNote}`
              : `ai-obs: company "${m.slug ?? '?'}" is suspended on ${m.host ?? 'the server'}; usage data for this repository is kept on this machine until it is active again (\`${cmd} flush\` retries). Tell the user.${cmdNote}`,
          );
          break;
      }
    }
    if (input.droppedEvents && input.droppedEvents > 0)
      parts.push(`Note: ai-obs deleted ${Math.floor(input.droppedEvents)} kept events because its local queue reached the 50 MB cap; tell the user (\`${cmd} status\`).`);
    if (input.droppedSendable && input.droppedSendable > 0)
      parts.push(`Note: ai-obs deleted ${Math.floor(input.droppedSendable)} events it could not send in time (30-day / 50 MB queue caps); tell the user (\`${cmd} status\`).`);
    return parts.length ? parts.join(' ') : null;
  };

  // Shorten in this order so the agent can still offer every company: token details first, then the repeated
  // command (once, then not at all), then --project-dir, and only then the number of tokens named.
  const attempts: Form[] = [
    { detail: true, cmdForm: 'full', dirFlag: true, listMax: MAX_LIST },
    { detail: false, cmdForm: 'full', dirFlag: true, listMax: MAX_LIST },
    { detail: false, cmdForm: 'once', dirFlag: true, listMax: MAX_LIST },
    { detail: false, cmdForm: 'plain', dirFlag: true, listMax: MAX_LIST },
    { detail: false, cmdForm: 'plain', dirFlag: false, listMax: MAX_LIST },
  ];
  for (let n = MAX_LIST - 1; n >= 1; n--) attempts.push({ detail: false, cmdForm: 'plain', dirFlag: false, listMax: n });
  let text: string | null = null;
  for (const a of attempts) {
    text = build(a);
    if (text === null || text.length <= NUDGE_MAX_CHARS) return text;
  }
  return text === null ? null : text.slice(0, NUDGE_MAX_CHARS);
}

function nudgeToken(view: RoutingView, t: TokenEntry): NudgeToken {
  const slug = effectiveCompany(t, view.caches[t.name])?.slug;
  const host = hostOf(t.endpoint);
  return {
    name: t.name,
    kind: tokenKind(t.token) === 'company' ? 'company token' : 'user token',
    ...(slug && SLUG_RE.test(slug) ? { slug } : {}),
    ...(host ? { host } : {}),
  };
}

function hostOf(endpoint: string): string | undefined {
  try {
    const h = new URL(endpoint).host.toLowerCase();
    return HOST_RE.test(h) ? h : undefined;
  } catch {
    return undefined;
  }
}

const hasSegments = (dir: string): boolean => {
  try {
    return readdirSync(dir).some((f) => f.endsWith('.ndjson'));
  } catch {
    return false;
  }
};

const hasOpenStreams = (paths: AiObsPaths): boolean => {
  try {
    return readdirSync(paths.queueProjects).some((d) => d.startsWith('o-'));
  } catch {
    return false;
  }
};

export interface NudgeContext {
  paths: AiObsPaths;
  cwd: string;
  sessionId: unknown;
  /** wall clock, ms */
  now: number;
  /** `perfNow()` at hook entry */
  startedAt: number;
  perfNow: () => number;
  resolveProjectKey: (cwd: string, opts: { timeoutMs: number; bounded?: boolean }) => Promise<string | null>;
  selfCommand: readonly string[] | null;
}

/** Git is tried only while fewer than this many ms have elapsed since hook entry, and for at most this long (C26). */
export const GIT_START_LIMIT_MS = 40;
export const GIT_BUDGET_MS = 40;
export const HOOK_BUDGET_MS = 80;

const reasonOf = (r: OpenReason): 'unassigned' | 'dangling' | 'config-damaged' | 'projects-unreadable' => r;

/** Decides the main text for this session (§4.1 steps 1-5). */
async function decideMain(ctx: NudgeContext, view: RoutingView): Promise<NudgeMain | null> {
  const { paths } = ctx;
  const T = view.config.tokens;
  if (!T.length) return { kind: 'no-tokens', revoked: !!(view.config.legacy || view.config.legacyToken) };

  const projectsHaveEntries = view.projects.status !== 'ok' || Object.keys(view.projects.entries).length > 0;
  const needKey = T.length >= 2 || projectsHaveEntries || view.config.invalidTokens.length > 0 || hasOpenStreams(paths);

  let pk: string | null = null;
  if (needKey) {
    pk = cachedPk(readPkCache(paths), ctx.cwd); // only while the directory is still the same repository
    if (pk === null) {
      const elapsed = ctx.perfNow() - ctx.startedAt;
      if (elapsed < GIT_START_LIMIT_MS) pk = await ctx.resolveProjectKey(ctx.cwd, { timeoutMs: Math.min(GIT_BUDGET_MS, HOOK_BUDGET_MS - elapsed), bounded: true });
    }
    if (pk === null) return null; // no key, no guessing: the worker fills the cache, so the next session asks
  }

  const d = captureBinding(view, pk, ctx.now);
  if (d.kind === 'drop') return null;
  if (d.bind.kind === 'open') {
    const reason = reasonOf(d.openReason ?? 'unassigned');
    if (reason === 'config-damaged' || reason === 'projects-unreadable') return { kind: reason };
    const tokens = T.slice(0, 50).map((t) => nudgeToken(view, t));
    if (reason === 'dangling') {
      const a = pk !== null && view.projects.status === 'ok' ? view.projects.entries[pk] : undefined;
      const name = a && a.token !== null && /^[a-z0-9-]{1,63}$/.test(a.token) ? a.token : undefined;
      return { kind: 'dangling', key: pk ?? '', tokens, ...(name ? { assignedTo: name } : {}) };
    }
    return { kind: 'unassigned', key: pk ?? '', tokens };
  }
  const boundName = d.bind.name;
  const t = T.find((x) => x.name === boundName);
  if (!t) return null;
  const blocked = view.blocked[t.name];
  if (blocked) {
    const slug = effectiveCompany(t, view.caches[t.name])?.slug;
    const host = hostOf(t.endpoint);
    return { kind: 'blocked', name: t.name, status: blocked.status, ...(host ? { host } : {}), ...(slug && SLUG_RE.test(slug) ? { slug } : {}) };
  }
  const r = routable(t, view.caches[t.name]);
  if (r !== 'ok') {
    const reported = view.caches[t.name]?.company?.slug;
    return { kind: 'unverified', name: t.name, ...(reported && SLUG_RE.test(reported) ? { reportedSlug: reported } : {}) };
  }
  const explicit = pk !== null && view.projects.status === 'ok' && Object.prototype.hasOwnProperty.call(view.projects.entries, pk);
  if (pk !== null && !explicit && hasSegments(join(paths.queueProjects, streamDirName(pk, OPEN)))) return { kind: 'open-backlog', key: pk, only: t.name };
  return null;
}

export interface Nudge {
  text: string;
  /** call after the text was written to stdout: records the once-per-session marker and the dropped-counter mark */
  commit: () => void;
}

/** The SessionStart nudge for this session, or null (§4.1). Never throws. */
export async function computeNudge(ctx: NudgeContext): Promise<Nudge | null> {
  const view = loadRouting(ctx.paths);
  if (!view) return null;
  const main = await decideMain(ctx, view);
  let droppedEvents = 0;
  let droppedSendable = 0;
  let droppedShown = false;
  const dropped = readDropped(ctx.paths);
  if (droppedTotal(dropped) > 0 && dropped.last_at && (!dropped.shown_at || dropped.last_at > dropped.shown_at)) {
    droppedEvents = dropped.held_events;
    droppedSendable = dropped.sendable_events;
    droppedShown = true;
  }
  const text = buildNudge({ main, droppedEvents, droppedSendable, selfCommand: ctx.selfCommand, dir: ctx.cwd });
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
          markDroppedShown(ctx.paths, new Date(ctx.now));
        } catch {
          /* ignore */
        }
      }
    },
  };
}
