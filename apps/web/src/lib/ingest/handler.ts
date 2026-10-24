import { sql } from 'drizzle-orm';
import { withIngestContext, type Database } from '@ai-obs/db';
import { validateBatch, type CollectorConfigResponse, type IngestResponse } from '@ai-obs/protocol';
import { readBatchBody } from './body';
import { lookupToken, rows, type TokenContext } from './context';
import { processBatch } from './process-batch';
import { clientIp, trustedProxyHopsFromEnv, type AuthGuard, type TokenBucketLimiter } from './rate-limit';
import { hashToken, parseBearer } from './tokens';

/** Injected so tests can use their own database and limiter; the routes pass dbFor('ingest'). */
export interface IngestDeps {
  db: Database;
  /** Per-token limit, keyed by token_id after a successful lookup. */
  limiter: TokenBucketLimiter;
  /** Pre-lookup defence against invalid bearers (per-IP failed-auth budget, negative cache). Routes pass it. */
  authGuard?: AuthGuard;
  env?: NodeJS.ProcessEnv;
}

const NO_STORE = { 'cache-control': 'no-store' };

function error(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: message }, { status, headers: { ...NO_STORE, ...headers } });
}

/** 401 wording for a token that does not resolve (ADR-0029): the collector tells the user to log in again. */
export const TOKEN_REJECTED = 'ingest token expired or revoked, run `ai-obs login`';
/** 401 wording for the retired company (`aiobs_c_`) and team (`aiobs_t_`) tokens. */
export const TOKEN_RETIRED = 'company and team tokens are no longer accepted, run `ai-obs login`';

/**
 * Bearer token → pre-lookup guard → lookup_ingest_token → per-token rate limit.
 * 401 for a missing, malformed, unknown, revoked or expired token, for a token whose user no longer holds a
 * membership, and (explicitly, without a lookup) for the retired `aiobs_c_` / `aiobs_t_` prefixes; 429 limited.
 *
 * The per-token bucket is keyed by token_id and only taken after a successful lookup, so random
 * bearers can neither get a fresh bucket each nor evict real tokens' buckets. Invalid bearers are
 * handled by the AuthGuard before they cost a DB call (SEC-9).
 */
export async function authenticate(
  request: Request,
  deps: IngestDeps,
): Promise<{ ok: true; token: TokenContext } | { ok: false; response: Response }> {
  const bearer = parseBearer(request.headers.get('authorization'));
  const unauthorized = (message = TOKEN_REJECTED) => error(401, message, { 'www-authenticate': 'Bearer' });
  if (!bearer) return { ok: false, response: unauthorized() };
  if ('retired' in bearer) return { ok: false, response: unauthorized(TOKEN_RETIRED) };

  const hash = hashToken(bearer.token);
  const guard = deps.authGuard;
  const ip = guard ? clientIp(request.headers, trustedProxyHopsFromEnv(deps.env)) : '';
  const admitted = guard?.admit(ip, hash) ?? { action: 'lookup' as const };
  if (admitted.action === 'reject-401') return { ok: false, response: unauthorized() };
  if (admitted.action === 'reject-429') {
    return { ok: false, response: error(429, 'rate limit exceeded', { 'retry-after': String(admitted.retryAfterSec) }) };
  }

  const token = await lookupToken(deps.db, hash);
  if (!token) {
    guard?.failed(ip, hash);
    return { ok: false, response: unauthorized() };
  }
  guard?.succeeded(hash);
  const limit = deps.limiter.take(token.tokenId);
  if (!limit.ok) {
    return { ok: false, response: error(429, 'rate limit exceeded', { 'retry-after': String(limit.retryAfterSec) }) };
  }
  return { ok: true, token };
}

/** POST /api/v1/ingest (BRIEF §6). */
export async function handleIngest(request: Request, deps: IngestDeps): Promise<Response> {
  const auth = await authenticate(request, deps);
  if (!auth.ok) return auth.response;

  const body = await readBatchBody(request);
  if (!body.ok) return error(body.status, body.error);

  const batch = validateBatch(body.json);
  if (!batch.ok) return error(400, `invalid batch: ${batch.error}`);

  const result: IngestResponse = batch.events.length
    ? await withIngestContext(deps.db, auth.token.userId, (tx) =>
        processBatch(tx, auth.token, batch.header, batch.events),
      )
    : { accepted: 0, duplicates: 0, rejected: [] };

  const response: IngestResponse = { ...result, rejected: [...batch.rejected, ...result.rejected] };
  return Response.json(response, { headers: NO_STORE });
}

/**
 * GET /api/v1/collector-config (brief Appendix A, ADR-0029). Naming mode, project salt and minimum collector version
 * as before, plus the deployment, the token's user, the teams they belong to (`ai-obs link` validates against them),
 * their primary team and the token's expiry, label and source. Cached privately for 5 minutes per token.
 */
export async function handleCollectorConfig(request: Request, deps: IngestDeps): Promise<Response> {
  const auth = await authenticate(request, deps);
  if (!auth.ok) return auth.response;
  const env = deps.env ?? process.env;
  const { token } = auth;
  const teams = await rows<{ team_id: string; slug: string; name: string }>(
    deps.db,
    sql`select team_id, slug, name from ingest_user_teams(${token.userId}::uuid)`,
  );
  const config: CollectorConfigResponse = {
    project_naming: token.projectNaming,
    min_collector_version: env.MIN_COLLECTOR_VERSION?.trim() || '0.0.0',
    deployment: { name: token.deployment.name, slug: token.deployment.slug },
    user: { email: token.userEmail, name: token.userName ?? token.userEmail ?? '', kind: token.userKind },
    teams: teams.map((t) => ({ slug: t.slug, name: t.name })),
    primary_team: teams.find((t) => t.team_id === token.primaryTeamId)?.slug ?? null,
    token: {
      expires_at: token.token.expiresAt ? token.token.expiresAt.toISOString() : null,
      label: token.token.label,
      source: token.token.source,
    },
  };
  // The deployment's project salt (SEC-11): the collector HMACs hashed project keys with it.
  if (token.projectSalt) config.project_salt = token.projectSalt;
  return Response.json(config, { headers: { 'cache-control': 'private, max-age=300' } });
}
