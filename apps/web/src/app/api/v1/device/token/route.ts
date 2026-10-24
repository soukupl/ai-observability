// POST /api/v1/device/token → 200 { token, expires_at, label } once the code is approved on /device, else
// 400 { error } (ADR-0029, brief Appendix B). Public, with a per-IP miss limiter; logic in src/lib/ingest/device.ts.
import { dbFor } from '@ai-obs/db';
import { handleDeviceToken } from '../../../../../lib/ingest/device';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleDeviceToken(request, { db: dbFor('ingest') });
}
