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

/**
 * Bearer token → pre-lookup guard → lookup_ingest_token → per-token rate limit.
 * 401 unknown, revoked or wrong-prefix token, or a user token whose membership was removed;
 * 429 limited; 403 suspended company.
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
  const unauthorized = () => error(401, 'invalid or revoked ingest token', { 'www-authenticate': 'Bearer' });
  if (!bearer) return { ok: false, response: unauthorized() };

  const hash = hashToken(bearer.token);
  const guard = deps.authGuard;
  const ip = guard ? clientIp(request.headers, trustedProxyHopsFromEnv(deps.env)) : '';
  const admitted = guard?.admit(ip, hash) ?? { action: 'lookup' as const };
  if (admitted.action === 'reject-401') return { ok: false, response: unauthorized() };
  if (admitted.action === 'reject-429') {
    return { ok: false, response: error(429, 'rate limit exceeded', { 'retry-after': String(admitted.retryAfterSec) }) };
  }

  const token = await lookupToken(deps.db, hash);
  if (!token || token.kind !== bearer.kind) {
    guard?.failed(ip, hash);
    return { ok: false, response: unauthorized() };
  }
  guard?.succeeded(hash);
  const limit = deps.limiter.take(token.tokenId);
  if (!limit.ok) {
    return { ok: false, response: error(429, 'rate limit exceeded', { 'retry-after': String(limit.retryAfterSec) }) };
  }
  if (token.companyStatus !== 'active') return { ok: false, response: error(403, 'company is suspended') };
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

  const result = batch.events.length
    ? await withIngestContext(deps.db, auth.token.companyId, (tx) =>
        processBatch(tx, auth.token, batch.header, batch.events),
      )
    : { accepted: 0, duplicates: 0, rejected: [] };

  const response: IngestResponse = { ...result, rejected: [...batch.rejected, ...result.rejected] };
  return Response.json(response, { headers: NO_STORE });
}

/**
 * GET /api/v1/collector-config (BRIEF §5.1, §6, ADR-0022). Besides naming and version, it names the
 * token's company (the collector stores the token under `company.slug`) and, for a user token, the
 * user's e-mail (`user` is null for a company token). Cached privately for 5 minutes per token.
 */
export async function handleCollectorConfig(request: Request, deps: IngestDeps): Promise<Response> {
  const auth = await authenticate(request, deps);
  if (!auth.ok) return auth.response;
  const env = deps.env ?? process.env;
  const { token } = auth;
  const config: CollectorConfigResponse = {
    project_naming: token.projectNaming,
    min_collector_version: env.MIN_COLLECTOR_VERSION?.trim() || '0.0.0',
    company: { name: token.company.name, slug: token.company.slug },
    user: token.kind === 'user' && token.userEmail ? { email: token.userEmail } : null,
  };
  // The company's project salt (SEC-11): the collector HMACs hashed project keys with it. Best effort:
  // without it the collector falls back to plain SHA-256, so a read failure must not break the config.
  try {
    const salt = await withIngestContext(deps.db, token.companyId, async (tx) =>
      (await rows<{ salt: string | null }>(tx, sql`select ingest_project_salt() as salt`))[0]?.salt,
    );
    if (salt) config.project_salt = salt;
  } catch (err) {
    console.error('collector-config: project salt unavailable', (err as Error).message);
  }
  return Response.json(config, { headers: { 'cache-control': 'private, max-age=300' } });
}
