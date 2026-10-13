import { rmSync } from 'node:fs';
import { cacheInfo, readCache, renameCache, writeCache } from '../cc-cache.js';
import {
  identityMatches,
  isTokenName,
  loadConfig,
  maskToken,
  newMachineConfig,
  normalizeEndpoint,
  PROVISIONAL_TOKEN_NAME,
  saveConfig,
  tokenKind,
  upsertToken,
  type CollectorConfig,
  type CompanyLabel,
  type TokenEntry,
  type TokenIdentity,
} from '../config.js';
import { clearBlocked, renameTokenDelivery } from '../delivery.js';
import { errorMessage } from '../fsutil.js';
import { recentKeys } from '../pk-cache.js';
import { assignmentIdentity, effectiveCompany, isExplicit, loadProjects } from '../projects.js';
import { COMPANY_TOKEN_PREFIX, LEGACY_TEAM_TOKEN_PREFIX, USER_TOKEN_PREFIX, type CollectorConfigResponse } from '../protocol-types.js';
import { getCollectorConfig, probeCollectorConfig, type EndpointCheck } from '../sender.js';
import { COLLECTOR_VERSION, compareVersions } from '../version.js';
import { listSome, movePreUpgrade, nowOf, openStore, withWriteLock, type CliDeps, type Io } from './common.js';

export interface RegisterInput {
  token: string;
  /** raw --endpoint / AI_OBS_ENDPOINT / config.json value (normalized here) */
  endpoint: string;
  endpointSource: 'flag' | 'env' | 'config';
  name?: string;
  /** given → stored on this token's entry (and as config.git_email when the machine has none yet); undefined → kept */
  gitEmail?: string | null;
}

export type RegisterOutcome =
  | {
      ok: true;
      config: CollectorConfig;
      entry: TokenEntry;
      action: 'added' | 'replaced';
      previous?: TokenEntry;
      verified: boolean;
      value: CollectorConfigResponse | null;
      tokensBefore: number;
      strandedEvents: number;
      /** explicit projects.json choices that point to the replaced entry's old endpoint */
      strandedRepos: number;
      /** the same token string was registered at another endpoint */
      endpointMoved: boolean;
      /** root segments of the 0.1.x collector moved to queue/dead/pre-upgrade by this registration */
      preUpgrade: { batches: number; events: number } | null;
    }
  | { ok: false; code: 1 | 2 };

/** The entry's company as routing sees it (stored, or its cache's when the slug equals its name). */
export function effOf(paths: CliDeps['paths'], e: TokenEntry): CompanyLabel | undefined {
  return effectiveCompany(e, cacheInfo(readCache(paths, e)));
}

/** "user token, alice@acme.example" | "company token" */
export function kindLabel(entry: TokenEntry): string {
  return tokenKind(entry.token) === 'company' ? 'company token' : `user token${entry.email ? `, ${entry.email}` : ''}`;
}

/** One line per token (status, token list, doctor): company · kind / account · endpoint · masked token. */
export function describeTokenLine(entry: TokenEntry, eff?: CompanyLabel): string {
  const kind = tokenKind(entry.token) === 'company' ? 'company token' : `user ${entry.email ?? '(no e-mail yet)'}`;
  return [eff ? eff.name : '(unconfirmed)', kind, entry.endpoint, maskToken(entry.token)].join(' · ');
}

function endpointHint(endpoint: string, source: RegisterInput['endpointSource']): string | null {
  if (source === 'flag') return null;
  return `  ${endpoint} was taken from ${source === 'env' ? 'AI_OBS_ENDPOINT' : 'your last registration'}; pass --endpoint if this token belongs to another server`;
}

/** Why a probe gave no company (unverified registration). */
function unverifiedReason(probe: EndpointCheck): string {
  if (!probe.reachable) return probe.error ?? 'not reachable';
  if (probe.tokenValid && !probe.value) return 'unreadable collector-config response';
  if (probe.value && !probe.value.company) return 'the server does not report its company (older server)';
  return probe.error ?? `HTTP ${probe.status}`;
}

/** The refusal printed for a 401 / 403 / exhausted 429 (also used by `token confirm`). Null for any other result. */
export function probeRefusal(endpoint: string, token: string, probe: EndpointCheck & { attempts: number; exhausted: boolean }): string | null {
  if (probe.status === 401) return `✗ ${endpoint} rejected token ${maskToken(token)} (HTTP 401: ${probe.serverError ?? 'invalid or revoked token'}). Nothing was changed.`;
  if (probe.status === 403) return `✗ ${endpoint}: company is suspended (HTTP 403). Nothing was changed.`;
  if (probe.exhausted) {
    const wait = probe.retryAfterMs ? `, server asks to wait ${Math.ceil(probe.retryAfterMs / 1000)} s` : '';
    return `✗ ${endpoint} is rate limiting this machine (HTTP 429, ${probe.attempts} attempts${wait}). Try again later. Nothing was changed.`;
  }
  return null;
}

export const probeToken = (deps: CliDeps, endpoint: string, token: string) =>
  probeCollectorConfig({
    endpoint,
    token,
    ...(deps.transport ? { transport: deps.transport } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });

/**
 * Shared registration of `init` and `token add` (design §2.2). Nothing is written before the probe has
 * succeeded and the worker lock is held. Prints its own result and failures.
 */
export async function registerToken(
  input: RegisterInput,
  io: Io,
  deps: CliDeps & { refreshRuntime: () => Promise<void> | void },
): Promise<RegisterOutcome> {
  const paths = deps.paths;
  // 1–3. local checks
  if (input.token.startsWith(LEGACY_TEAM_TOKEN_PREFIX)) {
    io.err(`ai-obs: tokens starting with ${LEGACY_TEAM_TOKEN_PREFIX} no longer exist: create a user token (My tokens) or a company token (Settings → Tokens) in the dashboard`);
    return { ok: false, code: 2 };
  }
  if (!tokenKind(input.token) || input.token.length <= USER_TOKEN_PREFIX.length) {
    io.err(`ai-obs: token must start with ${USER_TOKEN_PREFIX} (user token) or ${COMPANY_TOKEN_PREFIX} (company token)`);
    return { ok: false, code: 2 };
  }
  if (input.name !== undefined && !isTokenName(input.name)) {
    io.err("ai-obs: --name must be 1–63 characters of a-z, 0-9 and '-', not starting or ending with '-'");
    return { ok: false, code: 2 };
  }
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(input.endpoint);
  } catch (err) {
    io.err(`ai-obs: invalid endpoint: ${errorMessage(err)}`);
    return { ok: false, code: 2 };
  }

  // 4. probe (429 retries happen here, before the lock)
  const check = await probeToken(deps, endpoint, input.token);
  const refusal = probeRefusal(endpoint, input.token, check);
  if (refusal) {
    io.err(refusal);
    if (check.status === 401 || check.status === 403) {
      const hint = endpointHint(endpoint, input.endpointSource);
      if (hint) io.err(hint);
    }
    return { ok: false, code: 1 };
  }
  const value = check.tokenValid ? check.value : null;
  const company = value?.company;
  const before = loadConfig(paths);
  const sameTokenEntry = before?.tokens.find((t) => t.token === input.token);
  let name = input.name;
  let provisional = false;
  if (company) {
    if (name === undefined) {
      if (!isTokenName(company.slug)) {
        io.err(`ai-obs: the server's company slug ${JSON.stringify(company.slug)} cannot be used as a token name; pass --name`);
        return { ok: false, code: 2 };
      }
      name = company.slug;
    }
  } else if (name === undefined) {
    if (sameTokenEntry) name = sameTokenEntry.name;
    else if (!before?.tokens.length) {
      name = PROVISIONAL_TOKEN_NAME;
      provisional = true;
    } else {
      io.err(
        `! cannot read the company from ${endpoint} (${unverifiedReason(check)}). Pass --name <name> to register the token anyway: it sends nothing until its company is confirmed (\`ai-obs token confirm <name>\`). Nothing was changed.`,
      );
      return { ok: false, code: 1 };
    }
  }
  const tokenName = name as string;
  const email = value?.user?.email;

  // 5–6. under the lock: re-read, upsert, save, caches, pre-upgrade data, runtime
  const locked = await withWriteLock(deps, io, async () => {
    const nowDate = new Date(nowOf(deps));
    const existing = loadConfig(paths);
    let base = existing ?? newMachineConfig(null, nowDate);
    if (existing?.legacyToken && !existing.legacy) {
      base = { ...base, legacy: { ...(existing.endpoint ? { endpoint: existing.endpoint } : {}), token_mask: existing.legacyToken, found_at: nowDate.toISOString() } };
    }
    const tokensBefore = base.tokens.length;
    const entry: TokenEntry = {
      name: tokenName,
      ...(company ? { company } : {}),
      ...(email ? { email } : {}),
      ...(input.gitEmail ? { git_email: input.gitEmail } : {}),
      endpoint,
      token: input.token,
      added_at: nowDate.toISOString(),
      ...(provisional ? { provisional_name: true as const } : {}),
    };
    const r = upsertToken(base, entry, {
      nameGiven: input.name !== undefined,
      effOf: (e) => effOf(paths, e),
      cachedSlugOf: (e) => cacheInfo(readCache(paths, e)).company?.slug,
    });
    if (r.kind === 'conflict') return { conflict: r.message } as const;
    // the e-mail goes with this token only; config.git_email (tokens without their own) is set once
    const next: CollectorConfig = {
      ...r.config,
      endpoint,
      ...(input.gitEmail && !r.config.git_email ? { git_email: input.gitEmail } : {}),
    };
    const previous = r.kind === 'replaced' ? r.previous : undefined;
    saveConfig(paths, next, nowDate);
    if (previous && previous.name !== r.entry.name) {
      renameCache(paths, previous.name, r.entry.name);
      renameTokenDelivery(paths, previous.name, r.entry.name);
    }
    if (value) {
      writeCache(paths, r.entry, { fetched_at: nowDate.toISOString(), value, failed_at: undefined });
      clearBlocked(paths, r.entry);
    }
    rmSync(paths.collectorConfigCache, { force: true }); // the 0.1.x single cache (C5)
    const preUpgrade = movePreUpgrade(paths, nowDate);
    await deps.refreshRuntime();
    let strandedEvents = 0;
    let strandedRepos = 0;
    // the same token at a new endpoint is a new identity (C8): what pointed to the old endpoint is stranded
    const endpointMoved = !!previous && previous.endpoint !== r.entry.endpoint;
    if (previous && r.kind === 'replaced' && (!r.sameCompany || endpointMoved)) {
      const prevEff = previous.company;
      const stranded = (id: TokenIdentity) => identityMatches(id, previous, prevEff) && !identityMatches(id, r.entry, r.entry.company);
      for (const st of openStore(paths).stats().streams) {
        const b = st.stream.bind;
        if (b?.kind === 'token' && stranded(b.id)) strandedEvents += st.events;
      }
      const projects = loadProjects(paths);
      if (endpointMoved && projects.status === 'ok') {
        strandedRepos = Object.values(projects.entries).filter((a) => isExplicit(a) && stranded(assignmentIdentity(a))).length;
      }
    }
    return { config: next, entry: r.entry, action: r.kind, previous, tokensBefore, strandedEvents, strandedRepos, endpointMoved, preUpgrade } as const;
  });
  if (!locked) return { ok: false, code: 1 };
  const res = locked.value;
  if ('conflict' in res) {
    io.err(`✗ ${res.conflict}. Nothing was changed.`);
    return { ok: false, code: 1 };
  }

  // 7. result
  const { entry, previous } = res;
  const shown = company ?? entry.company;
  const label = shown ? `${shown.name} (${kindLabel(entry)})` : `(unconfirmed ${tokenKind(entry.token)} token)`;
  io.out(`✓ token ${entry.name} ${res.action === 'added' ? 'registered' : 'replaced'}: ${label} at ${endpoint}`);
  if (previous && tokenKind(previous.token) !== tokenKind(entry.token)) {
    io.out(
      tokenKind(entry.token) === 'company'
        ? '  replaced a user token with a company token: activity is now matched by git e-mail instead of verified'
        : '  replaced a company token with a user token: activity is now verified by the token instead of matched by git e-mail',
    );
  }
  if (!company) {
    const reason = unverifiedReason(check);
    const only = res.config.tokens.length === 1;
    if (entry.company) {
      io.out(`! ${endpoint} could not be checked now (${reason}); token ${entry.name} keeps its company ${entry.company.slug}`);
    } else if (entry.provisional_name) {
      io.out(
        `! ${check.reachable ? `cannot read the company from ${endpoint}` : `${endpoint} is not reachable now`} (${reason}): token registered as \`${entry.name}\`; it is checked and named after its company on the first successful send. Events queue locally until then.`,
      );
    } else if (only) {
      io.out(`! token ${entry.name} registered without checking it (${reason}). It is checked on the first successful send; events queue locally until then.`);
    } else {
      io.out(
        `! token ${entry.name} registered without checking it (${reason}). It sends nothing until its company is confirmed: run \`ai-obs token confirm ${entry.name}\` when ${endpoint} is reachable`,
      );
    }
  }
  if (res.endpointMoved && previous && (res.strandedEvents > 0 || res.strandedRepos > 0)) {
    io.out(
      `! token ${entry.name} now reports to ${entry.endpoint} instead of ${previous.endpoint}: ${res.strandedEvents} queued events recorded for ${previous.endpoint} stay on this machine and ${res.strandedRepos} repositories assigned to it ask for a token again. Run \`ai-obs use ${entry.name} --move-queued\` in each of them to send their events to ${entry.endpoint} (\`ai-obs status\` lists them).`,
    );
  } else if (res.strandedEvents > 0) {
    io.out(`! ${res.strandedEvents} queued events were recorded with the token you replaced, which belongs to another company; they stay on this machine (\`ai-obs status\` lists them)`);
  }
  if (res.preUpgrade) {
    io.out(
      `! ${res.preUpgrade.batches} pre-upgrade batches (${res.preUpgrade.events} events, recorded by ai-obs 0.1) moved to ${paths.deadPreUpgrade}: they are not sent, because every token from before the upgrade was reset`,
    );
  }
  return { ok: true, ...res, verified: !!company, value };
}

/**
 * `init` step 6–7 / `token add`: per-token naming and minimum version, then the "several tokens" hints.
 */
export async function afterRegistration(outcome: Extract<RegisterOutcome, { ok: true }>, io: Io, deps: CliDeps): Promise<void> {
  const tokens = outcome.config.tokens;
  const several = tokens.length > 1;
  for (const t of tokens) {
    const isNew = t.name === outcome.entry.name;
    const cc = await getCollectorConfig(
      { token: t, paths: deps.paths, ...(deps.transport ? { transport: deps.transport } : {}), ...(deps.now ? { now: deps.now } : {}) },
      { force: isNew && !outcome.verified },
    );
    if (cc.source === 'default') {
      io.out(
        several
          ? `! ${t.name}: project naming unknown until ${t.endpoint} is reached; its events stay queued meanwhile`
          : '! project naming unknown until the server is reached; events stay queued meanwhile, so no unhashed project keys leave this machine',
      );
    } else {
      io.out(several ? `✓ ${t.name}: project naming ${cc.value.project_naming}` : `✓ project naming: ${cc.value.project_naming}`);
      if (compareVersions(COLLECTOR_VERSION, cc.value.min_collector_version) < 0) {
        io.out(
          `! this collector (${COLLECTOR_VERSION}) is older than the server minimum ${cc.value.min_collector_version}${several ? ` (${t.name})` : ''}; update with \`npx @soukupl/ai-obs@latest init\``,
        );
      }
    }
  }
  if (outcome.action === 'added' && several) {
    const names = tokens.map((t) => t.name).join(', ');
    const base = `! ${tokens.length} tokens are registered (${names}). From now on each repository must be assigned once with \`ai-obs use <name>\` inside it; until then new sessions are kept on this machine and your AI agent asks at the start of a session.`;
    if (outcome.tokensBefore === 1) {
      const recent = recentKeys(deps.paths, nowOf(deps) - 30 * 24 * 3600_000);
      const first = tokens.find((t) => t.name !== outcome.entry.name)?.name ?? tokens[0]!.name;
      io.out(
        `${base} Events already queued stay with ${first}.${recent.length ? ` Repositories seen recently: ${listSome(recent, 10)}.` : ''} To assign all waiting repositories to one token: \`ai-obs use <name> --all-held\`.`,
      );
    } else {
      io.out(base);
    }
  }
}
