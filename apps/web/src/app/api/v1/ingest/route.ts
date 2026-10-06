// POST /api/v1/ingest (BRIEF §6). Kept as an isolated route module so ingest can become its own
// service later (ADR-0009). Logic lives in src/lib/ingest; see apps/web/README.md "Ingest API".
import { dbFor } from '@ai-obs/db';
import { handleIngest } from '../../../../lib/ingest/handler';
import { ingestAuthGuard, ingestRateLimiter } from '../../../../lib/ingest/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleIngest(request, { db: dbFor('ingest'), limiter: ingestRateLimiter(), authGuard: ingestAuthGuard() });
}
