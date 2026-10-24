// POST /api/v1/device/code → { device_code, user_code, verification_uri, expires_in, interval } (ADR-0029, brief
// Appendix B). Public and rate limited per client IP; logic in src/lib/ingest/device.ts.
import { dbFor } from '@ai-obs/db';
import { handleDeviceCode } from '../../../../../lib/ingest/device';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleDeviceCode(request, { db: dbFor('ingest') });
}
