import { renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { writeCache } from '../cc-cache.js';
import {
  findServer,
  isUserToken,
  loadConfig,
  maskToken,
  newMachineConfig,
  normalizeEndpoint,
  retiredPrefix,
  saveConfig,
  upsertServer,
  type CollectorConfig,
  type ServerEntry,
} from '../config.js';
import { clearBlocked } from '../delivery.js';
import { lookupDotFile } from '../dotfile.js';
import { ensureDir, errorMessage } from '../fsutil.js';
import { nodeTransport, type Transport } from '../http.js';
import { createLogger } from '../log.js';
import { migrateHome } from '../migrate.js';
import type { AiObsPaths } from '../paths.js';
import { USER_TOKEN_PREFIX, type CollectorConfigResponse, type TokenSource } from '../protocol-types.js';
import { serverFor } from '../routing.js';
import { installRuntime } from '../runtime.js';
import { probeCollectorConfig, type EndpointCheck } from '../sender.js';
import { ulid } from '../ulid.js';
import { COLLECTOR_NAME, COLLECTOR_VERSION, compareVersions } from '../version.js';
import {
  canOpenBrowser,
  defaultHostname,
  defaultOpenBrowser,
  describeServer,
  nowOf,
  openStore,
  parseOptions,
  readProcessStdin,
  terminalSafe,
  UsageError,
  withWriteLock,
  type CliDeps,
  type Io,
} from './common.js';

export const DEVICE_CODE_PATH = '/api/v1/device/code';
export const DEVICE_TOKEN_PATH = '/api/v1/device/token';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** 8 letters, shown as XXXX-XXXX; the CLI accepts both forms from the server (appendix B). */
const USER_CODE_RE = /^[A-Z]{4}-?[A-Z]{4}$/;
const POLL_TIMEOUT_MS = 10_000;

export const LOGIN_OPTIONS = {
  server: { type: 'string' },
  token: { type: 'string' },
  'no-browser': { type: 'boolean', default: false },
  label: { type: 'string' },
  'keep-queue': { type: 'boolean', default: false },
} as const;

/**
 * The server of `login` (and `init --token`): --server, else AI_OBS_ENDPOINT, else the only registered
 * server, else required.
 */
export function serverOf(flag: string | undefined, deps: CliDeps): { endpoint: string; source: 'flag' | 'env' | 'config' } {
  const env = deps.env ?? process.env;
  if (flag) return { endpoint: flag, source: 'flag' };
  if (env.AI_OBS_ENDPOINT) return { endpoint: env.AI_OBS_ENDPOINT, source: 'env' };
  const config = loadConfig(deps.paths);
  if (config?.servers.length === 1) return { endpoint: config.servers[0]!.endpoint, source: 'config' };
  throw new UsageError(
    config && config.servers.length > 1
      ? `--server is required: ${config.servers.length} servers are registered (${config.servers.map((s) => s.endpoint).join(', ')})`
      : '--server is required (your ai-obs server URL), or set AI_OBS_ENDPOINT',
  );
}

/** Token check shared by `login --token` and `init --token`; prints why a token is refused. */
export function checkTokenShape(token: string, io: Io): boolean {
  const retired = retiredPrefix(token);
  if (retired) {
    io.err(
      `ai-obs: tokens starting with ${retired} no longer exist: run \`ai-obs login\` (browser approval), or create a token under "My tokens" in the dashboard`,
    );
    return false;
  }
  if (!isUserToken(token)) {
    io.err(`ai-obs: a token must start with ${USER_TOKEN_PREFIX}`);
    return false;
  }
  return true;
}

/**
 * `ai-obs login [--server URL] [--token <t>|-] [--no-browser] [--label <name>] [--keep-queue]`: the device flow
 * (approve a code in the browser) or a pasted token, verified with collector-config and stored as the server's
 * entry in config.json (one per endpoint; a new login replaces the token). Queued data is sent with the new
 * token, unless the new token belongs to another account: then it is set aside (`--keep-queue` sends it anyway).
 */
export async function loginCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseOptions(args, LOGIN_OPTIONS);
  const { endpoint: raw, source } = serverOf(values.server, deps);
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(raw);
  } catch (err) {
    io.err(`ai-obs: invalid server URL: ${errorMessage(err)}`);
    return 2;
  }
  if (source !== 'flag') io.out(`server ${endpoint} (from ${source === 'env' ? 'AI_OBS_ENDPOINT' : 'the only registered server'})`);
  if (values.token !== undefined) {
    let token = values.token;
    if (token === '-') token = (await (deps.readStdin ?? readProcessStdin)()).trim();
    if (!token) throw new UsageError('--token needs a token, or - to read it from stdin');
    if (!checkTokenShape(token, io)) return 2;
    return registerServer({ endpoint, token, source: 'manual', ...(values.label ? { label: values.label } : {}) }, io, deps, { keepQueue: values['keep-queue'] });
  }
  const got = await deviceLogin(endpoint, { noBrowser: values['no-browser'], ...(values.label ? { label: values.label } : {}) }, io, deps);
  if (!got.ok) return got.code;
  return registerServer({ endpoint, token: got.token, source: 'device', label: got.label, expiresAt: got.expiresAt }, io, deps, { keepQueue: values['keep-queue'] });
}

type DeviceResult = { ok: true; token: string; expiresAt: string | null; label: string | null } | { ok: false; code: 1 | 2 };

type PostResult = { status: number; json: unknown; headers: Record<string, string | string[] | undefined> } | { status: null; error: string };

async function postJson(transport: Transport, url: string, body: unknown): Promise<PostResult> {
  try {
    const res = await transport({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `${COLLECTOR_NAME}/${COLLECTOR_VERSION}` },
      body: Buffer.from(JSON.stringify(body)),
      timeoutMs: POLL_TIMEOUT_MS,
    });
    let json: unknown = null;
    try {
      json = JSON.parse(res.body);
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers ?? {} };
  } catch (err) {
    return { status: null, error: errorMessage(err) };
  }
}

const field = (json: unknown, key: string): unknown => (typeof json === 'object' && json !== null ? (json as Record<string, unknown>)[key] : undefined);

/** Seconds of a `Retry-After` header (delta seconds or an HTTP date), clamped to 1 – 3600; null when absent or unreadable. */
function retryAfterSec(headers: Record<string, string | string[] | undefined>, nowMs: number): number | null {
  const raw = headers['retry-after'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  const n = Number(v);
  const secs = Number.isFinite(n) ? n : (Date.parse(v) - nowMs) / 1000;
  return Number.isFinite(secs) ? Math.min(3600, Math.max(1, Math.ceil(secs))) : null;
}

/**
 * Status codes of `/device/code` that mean "this server has no device login": 404 / 405, and 401, which is what
 * a 0.3 / 0.4 server answers (its proxy refuses every non-public /api/ path without a session).
 */
const NO_DEVICE_LOGIN = new Set([401, 404, 405]);

/**
 * The device flow (appendix B, modelled on spoor-memory's `login`): request a code, print and open
 * `<server>/device` (the URL is built here, never taken from the answer), poll the token endpoint honouring
 * `interval` and `slow_down` until approved, denied or expired.
 */
export async function deviceLogin(endpoint: string, o: { noBrowser: boolean; label?: string }, io: Io, deps: CliDeps): Promise<DeviceResult> {
  const transport = deps.transport ?? nodeTransport;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env = deps.env ?? process.env;
  const clientName = (o.label ?? (deps.hostname ?? defaultHostname)()).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) || 'ai-obs';
  const code = await postJson(transport, endpoint + DEVICE_CODE_PATH, { client_name: clientName, client_version: COLLECTOR_VERSION });
  if (code.status === null) {
    io.err(`✗ ${endpoint} is not reachable (${code.error}). Nothing was changed.`);
    return { ok: false, code: 1 };
  }
  if (code.status === 429) {
    const wait = retryAfterSec(code.headers, nowOf(deps));
    const when = wait ? `try again in ${wait} s` : 'try again in a minute';
    io.err(
      field(code.json, 'error') === 'too_many_open_codes'
        ? `✗ too many logins are waiting for approval on ${endpoint} (a server-wide limit, HTTP 429); ${when}. Nothing was changed.`
        : `✗ ${endpoint} is rate limiting device logins from this address (HTTP 429); ${when}. Nothing was changed.`,
    );
    return { ok: false, code: 1 };
  }
  if (NO_DEVICE_LOGIN.has(code.status) && typeof field(code.json, 'device_code') !== 'string') {
    io.err(
      `✗ ${endpoint} does not offer device login (HTTP ${code.status}: an older server?). Create a token under "My tokens" in the dashboard and run \`ai-obs login --server ${endpoint} --token -\`. Nothing was changed.`,
    );
    return { ok: false, code: 1 };
  }
  const deviceCode = field(code.json, 'device_code');
  const userCodeRaw = field(code.json, 'user_code');
  if (code.status !== 200 || typeof deviceCode !== 'string' || !deviceCode || typeof userCodeRaw !== 'string' || !USER_CODE_RE.test(userCodeRaw)) {
    io.err(`✗ device login failed (unexpected answer from ${endpoint}, HTTP ${code.status}). Nothing was changed.`);
    return { ok: false, code: 1 };
  }
  const userCode = userCodeRaw.includes('-') ? userCodeRaw : `${userCodeRaw.slice(0, 4)}-${userCodeRaw.slice(4)}`;
  const expiresIn = Math.min(3600, Math.max(30, Number(field(code.json, 'expires_in')) || 600));
  let interval = Math.min(60, Math.max(1, Number(field(code.json, 'interval')) || 5)) * 1000;
  const verifyUrl = `${endpoint}/device`;
  io.out(`Open ${verifyUrl} and enter the code ${userCode}`);
  io.out(`  to approve "${terminalSafe(clientName)}" (waiting up to ${Math.round(expiresIn / 60)} min; Ctrl-C cancels)`);
  if (!o.noBrowser && canOpenBrowser(env)) (deps.openBrowser ?? defaultOpenBrowser)(verifyUrl);

  const end = nowOf(deps) + expiresIn * 1000;
  while (nowOf(deps) < end) {
    await sleep(interval);
    const r = await postJson(transport, endpoint + DEVICE_TOKEN_PATH, { grant_type: DEVICE_GRANT, device_code: deviceCode });
    if (r.status === null || r.status >= 500) continue; // transient: keep polling until the code expires
    if (r.status === 200) {
      const token = field(r.json, 'token');
      if (typeof token !== 'string' || !isUserToken(token)) {
        io.err('✗ device login failed (the server answered without a valid token). Nothing was changed.');
        return { ok: false, code: 1 };
      }
      const exp = field(r.json, 'expires_at');
      const label = field(r.json, 'label');
      return {
        ok: true,
        token,
        expiresAt: typeof exp === 'string' && Number.isFinite(Date.parse(exp)) ? exp : null,
        label: typeof label === 'string' && label ? label : clientName,
      };
    }
    if (r.status === 429) {
      const wait = retryAfterSec(r.headers, nowOf(deps));
      interval = Math.min(60_000, Math.max(interval + 5000, wait ? wait * 1000 : 0));
      continue;
    }
    const error = field(r.json, 'error');
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (error === 'access_denied') {
      io.err('✗ the login was denied in the browser. Nothing was changed.');
      return { ok: false, code: 1 };
    }
    if (error === 'expired_token') {
      io.err('✗ the code expired before it was approved; run `ai-obs login` again. Nothing was changed.');
      return { ok: false, code: 1 };
    }
    if (error === 'invalid_grant') {
      io.err(
        '✗ the code is no longer valid (already used?); run `ai-obs login` again. Nothing was changed here. If you had approved it, the server may have created a token this machine never received: revoke it under "My tokens".',
      );
      return { ok: false, code: 1 };
    }
    io.err(`✗ device login failed (HTTP ${r.status}${typeof error === 'string' ? `: ${terminalSafe(error).slice(0, 100)}` : ''}). Nothing was changed.`);
    return { ok: false, code: 1 };
  }
  io.err('✗ the code expired before it was approved; run `ai-obs login` again. Nothing was changed.');
  return { ok: false, code: 1 };
}

export interface RegisterInput {
  endpoint: string;
  token: string;
  source: TokenSource;
  label?: string | null;
  /** from the device-token answer; the collector-config value wins when it has one */
  expiresAt?: string | null;
}

/** Why a check gave no value (the token is stored unverified). */
function unverifiedReason(probe: EndpointCheck): string {
  if (!probe.reachable) return probe.error ?? 'not reachable';
  if (probe.tokenValid && !probe.value) return 'unreadable collector-config response';
  return probe.error ?? `HTTP ${probe.status}`;
}

/** Who a stored entry belongs to: its e-mail (lower case), null for a service user, undefined when never checked. */
function accountOf(s: ServerEntry): string | null | undefined {
  if (s.email) return s.email.toLowerCase();
  return s.source ? null : undefined;
}

export interface AccountSwitch {
  /** e-mail of the replaced token's account; null = a service user */
  from: string | null;
  to: string | null;
}

/**
 * The previous and the new account when a login replaces the token of another account (both known: the stored
 * entry was checked once and collector-config answered for the new token); null otherwise. Two service users
 * cannot be told apart (no e-mail).
 */
export function accountSwitch(prev: ServerEntry | undefined, token: string, value: CollectorConfigResponse | null): AccountSwitch | null {
  if (!prev || prev.token === token || !value?.user) return null;
  const from = accountOf(prev);
  if (from === undefined) return null;
  const to = value.user.email ? value.user.email.toLowerCase() : null;
  return from === to ? null : { from: prev.email, to: value.user.email };
}

/** Where `login` sets aside the queued events of a previous account: `queue/set-aside/<ulid>/{p,u}/<stream>`. */
export const SET_ASIDE_DIR = 'set-aside';

/**
 * The queued streams that would be sent to `endpoint` (project and unresolved streams, resolved with `config`):
 * counted, and with `move` renamed into `queue/set-aside/<ulid>/` (never sent; `about.json` says whose they
 * were). Called under worker.lock.
 */
function queuedFor(paths: AiObsPaths, config: CollectorConfig, endpoint: string, now: Date, move: { about: Record<string, unknown> } | null) {
  const dir = join(paths.queue, SET_ASIDE_DIR, ulid(now.getTime()));
  let events = 0;
  let moved = 0;
  for (const st of openStore(paths).stats().streams) {
    const ref = st.stream;
    if ((ref.kind !== 'project' && ref.kind !== 'unresolved') || ref.endpoint === undefined) continue;
    if (serverFor(config, ref.endpoint)?.endpoint !== endpoint) continue;
    if (!move) {
      events += st.events;
      continue;
    }
    try {
      const to = join(dir, ref.kind === 'project' ? 'p' : 'u', basename(ref.dir));
      ensureDir(dirname(to));
      renameSync(ref.dir, to);
      events += st.events;
      moved++;
    } catch {
      /* left in place: sent with the new token */
    }
  }
  if (move && moved) {
    try {
      writeFileSync(join(dir, 'about.json'), `${JSON.stringify({ ...move.about, endpoint, events, streams: moved, at: now.toISOString() }, null, 2)}\n`, { mode: 0o600 });
    } catch {
      /* informational */
    }
  }
  return { events, dir };
}

const accountName = (email: string | null): string => (email ? terminalSafe(email) : 'a service user');

/**
 * Verifies the token with collector-config and stores it (under worker.lock, after migrating a 0.4 home):
 * one entry per endpoint, a new login replaces the token. When the new token belongs to another account than
 * the replaced one, the server's queued events are set aside instead of being sent as the new account
 * (`keepQueue` sends them). Refreshes the hook runtime first, so an older hook copy never reads a config it does
 * not understand. Prints the result. Returns the exit code.
 */
export async function registerServer(input: RegisterInput, io: Io, deps: CliDeps, opts: { fromInit?: boolean; keepQueue?: boolean } = {}): Promise<number> {
  const paths = deps.paths;
  const check = await probeCollectorConfig({
    endpoint: input.endpoint,
    token: input.token,
    ...(deps.transport ? { transport: deps.transport } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (check.status === 401 || check.status === 403) {
    io.err(`✗ ${input.endpoint} rejected token ${maskToken(input.token)} (HTTP ${check.status}: ${check.serverError ?? 'expired or revoked'}). Nothing was changed.`);
    return 1;
  }
  if (check.exhausted) {
    io.err(`✗ ${input.endpoint} is rate limiting this machine (HTTP 429, ${check.attempts} attempts). Try again later. Nothing was changed.`);
    return 1;
  }
  const value: CollectorConfigResponse | null = check.tokenValid ? check.value : null;
  const before = loadConfig(paths);
  const notes: string[] = [];
  const refresh = deps.installRuntime ?? installRuntime;
  const locked = await withWriteLock(deps, io, async () => {
    const now = new Date(nowOf(deps));
    refresh(paths); // before the config is written in the new format (and before the migration)
    notes.push(...migrateHome(paths, { log: createLogger(paths, 'cli'), now, refreshRuntime: refresh }));
    const base = loadConfig(paths) ?? newMachineConfig(null, now);
    const prev = findServer(base, input.endpoint);
    const same = prev?.token === input.token;
    const entry: ServerEntry = {
      endpoint: input.endpoint,
      token: input.token,
      email: value?.user ? value.user.email : same ? prev.email : null,
      deployment: value?.deployment ?? (same ? prev.deployment : null),
      label: value?.token?.label ?? input.label ?? null,
      expires_at: value?.token ? value.token.expires_at : (input.expiresAt ?? null),
      // unchecked: no source, so the entry reads "not checked yet" (not "service user") until collector-config answers
      source: value ? (value.token?.source ?? input.source) : same ? prev.source : null,
      added_at: now.toISOString(),
    };
    const sw = accountSwitch(prev, input.token, value);
    const queued = sw ? queuedFor(paths, base, input.endpoint, now, opts.keepQueue ? null : { about: { from: sw.from, to: sw.to } }) : null;
    const r = upsertServer(base, entry);
    saveConfig(paths, r.config);
    if (value) writeCache(paths, entry, { fetched_at: now.toISOString(), value, failed_at: undefined });
    clearBlocked(paths, entry);
    return { ...r, sw, queued };
  });
  if (!locked) return 1;
  for (const n of notes) io.err(`ai-obs: ${n}`);
  const r = locked.value;
  io.out(`✓ logged in to ${input.endpoint}: ${describeServer(r.entry)}`);
  if (r.kind === 'replaced') {
    if (r.sw) {
      const from = accountName(r.sw.from);
      io.out(`! the previous token for this server belonged to ${from}, the new one to ${accountName(r.sw.to)}`);
      if (r.queued?.events && opts.keepQueue) {
        io.out(`  --keep-queue: ${r.queued.events} queued events recorded as ${from} are sent with the new token`);
      } else if (r.queued?.events) {
        io.out(`  ${r.queued.events} queued events recorded as ${from} were set aside in ${r.queued.dir} and are not sent.`);
        io.out(`  To send them with the new token anyway, move its p/ and u/ directories' contents into ${join(paths.queue, 'p')} and ${join(paths.queue, 'u')}`);
      }
    } else io.out('  replaced the previous token for this server; events queued for it are sent with the new one');
    io.out('  the previous token stays valid on the server until it expires: revoke it under "My tokens" if nothing else uses it');
  }
  if (value) {
    const teams = value.teams ?? [];
    if (teams.length) io.out(`  your teams: ${teams.map((t) => terminalSafe(t.slug)).join(', ')}${value.primary_team ? ` (primary: ${terminalSafe(value.primary_team)})` : ''}`);
    else io.out('  you are not a member of any team yet: usage is recorded without a team');
    io.out(`  project naming: ${value.project_naming}`);
    if (compareVersions(COLLECTOR_VERSION, value.min_collector_version) < 0) {
      io.out(`! this collector (${COLLECTOR_VERSION}) is older than the server minimum ${value.min_collector_version}; update with \`npx ai-obs-cli@latest init\``);
    }
  } else {
    io.out(`! ${input.endpoint} could not check the token now (${unverifiedReason(check)}): it is stored, and nothing is sent until the server answers`);
  }
  const servers = r.config.servers.length;
  if (servers > 1) {
    const dot = lookupDotFile(deps.cwd ?? process.cwd());
    const here = dot.root && !dot.server ? ' (this repository has none yet)' : '';
    io.out(
      `! ${servers} servers are registered: a repository reports to the server in its .ai-obs.json${here}; without one its data stays on this machine until you run \`ai-obs link --server <url> --team <slug>\` in it`,
    );
  }
  if (!before && !opts.fromInit) io.out('→ run `ai-obs init` to install the harness hooks');
  return 0;
}
