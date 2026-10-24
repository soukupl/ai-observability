import { DEFAULT_DEPLOYMENT_SETTINGS, type Database, type DeploymentSettings } from '@ai-obs/db';
import { sql } from 'drizzle-orm';

/** The one deployment row (ADR-0028): its name for e-mails and its settings (retention, visibility, runaway thresholds). */
export interface DeploymentInfo {
  name: string;
  slug: string;
  settings: DeploymentSettings;
}

/**
 * Reads the deployment row. Migration 0018 always creates it; should it be missing anyway, the defaults apply so the
 * jobs keep working (retention 395 days, aggregates-only, default runaway thresholds).
 */
export async function loadDeployment(db: Database): Promise<DeploymentInfo> {
  const [row] = (await db.execute(sql`select name, slug, settings from deployment limit 1`)) as unknown as Array<{
    name: string;
    slug: string;
    settings: Partial<DeploymentSettings> | null;
  }>;
  return {
    name: row?.name ?? 'ai-obs',
    slug: row?.slug ?? 'ai-obs',
    settings: { ...DEFAULT_DEPLOYMENT_SETTINGS, ...(row?.settings ?? {}) },
  };
}
