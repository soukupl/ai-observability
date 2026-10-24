// GET /api/v1/collector-config → { project_naming, min_collector_version, project_salt?, deployment, user, teams,
// primary_team, token } (brief Appendix A, ADR-0029).
import { dbFor } from '@ai-obs/db';
import { handleCollectorConfig } from '../../../../lib/ingest/handler';
import { ingestAuthGuard, ingestRateLimiter } from '../../../../lib/ingest/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleCollectorConfig(request, { db: dbFor('ingest'), limiter: ingestRateLimiter(), authGuard: ingestAuthGuard() });
}
