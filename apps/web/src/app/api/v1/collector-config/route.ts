// GET /api/v1/collector-config → { project_naming, min_collector_version, project_salt?, company: { name, slug },
// user: { email } | null } (BRIEF §6, ADR-0022). `user` is null for a company token.
import { dbFor } from '@ai-obs/db';
import { handleCollectorConfig } from '../../../../lib/ingest/handler';
import { ingestAuthGuard, ingestRateLimiter } from '../../../../lib/ingest/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleCollectorConfig(request, { db: dbFor('ingest'), limiter: ingestRateLimiter(), authGuard: ingestAuthGuard() });
}
