import { sql } from 'drizzle-orm';
import {
  DEFAULT_DEPLOYMENT_SETTINGS,
  deployment,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RUNAWAY_BOUNDS,
  type DeploymentSettings,
  type Tx,
} from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { name, parse } from './input';
import { isAdmin } from './permissions';
import { AdminError, ensure, type Actor } from './types';

export interface DeploymentRow {
  id: string;
  name: string;
  slug: string;
  settings: DeploymentSettings;
}

/** The deployment row, read in the transaction (fresher than the session). `lock` serializes concurrent edits. */
export async function loadDeployment(tx: Tx, lock = false): Promise<DeploymentRow> {
  const [d] = await rows<{ id: string; name: string; slug: string; settings: DeploymentSettings }>(
    tx,
    sql`select id, name, slug, settings from deployment limit 1 ${lock ? sql`for update` : sql``}`,
  );
  if (!d) throw new AdminError('The deployment row is missing. Run the database migrations.');
  return { ...d, settings: { ...DEFAULT_DEPLOYMENT_SETTINGS, ...d.settings } };
}

export interface DeploymentCounts {
  members: number;
  serviceUsers: number;
  pendingInvitations: number;
  teams: number;
  activeTokens: number;
  projects: number;
}

/** Counts for the admin overview. Invitations and every token are admin-visible only (RLS). */
export async function deploymentCounts(tx: Tx): Promise<DeploymentCounts> {
  const [r] = await rows<Record<keyof DeploymentCounts, number>>(
    tx,
    sql`select
      (select count(*)::int from memberships m join users u on u.id = m.user_id where u.kind = 'person') as members,
      (select count(*)::int from memberships m join users u on u.id = m.user_id where u.kind = 'service') as "serviceUsers",
      (select count(*)::int from invitations where accepted_at is null and expires_at > now()) as "pendingInvitations",
      (select count(*)::int from teams) as teams,
      (select count(*)::int from ingest_tokens where revoked_at is null and (expires_at is null or expires_at > now())) as "activeTokens",
      (select count(*)::int from projects) as projects`,
  );
  return {
    members: Number(r?.members ?? 0),
    serviceUsers: Number(r?.serviceUsers ?? 0),
    pendingInvitations: Number(r?.pendingInvitations ?? 0),
    teams: Number(r?.teams ?? 0),
    activeTokens: Number(r?.activeTokens ?? 0),
    projects: Number(r?.projects ?? 0),
  };
}

/** An optional numeric form field: empty or missing = not changed. */
const optionalNumber = (n: z.ZodType<number, unknown>) => z.preprocess((v) => (v === '' || v === null ? undefined : v), n.optional());

export const settingsInput = z.object({
  individualVisibility: z.enum(['aggregates-only', 'full']),
  projectNaming: z.enum(['plain', 'hashed']),
  /** ADR-0012 / ADR-0028 E8: admin-editable within 30–730 days, no plan caps. */
  retentionDays: z.coerce
    .number()
    .int('whole days only')
    .min(MIN_RETENTION_DAYS, `at least ${MIN_RETENTION_DAYS} days`)
    .max(MAX_RETENTION_DAYS, `at most ${MAX_RETENTION_DAYS} days`),
  /** runaway alert thresholds (docs/briefs/runaway-alerts.md) */
  runawayCostUsd: optionalNumber(
    z.coerce
      .number()
      .min(RUNAWAY_BOUNDS.costUsd[0], `at least $${RUNAWAY_BOUNDS.costUsd[0]}`)
      .max(RUNAWAY_BOUNDS.costUsd[1], `at most $${RUNAWAY_BOUNDS.costUsd[1]}`),
  ),
  runawayHours: optionalNumber(
    z.coerce
      .number()
      .min(RUNAWAY_BOUNDS.hours[0], `at least ${RUNAWAY_BOUNDS.hours[0]} hours`)
      .max(RUNAWAY_BOUNDS.hours[1], `at most ${RUNAWAY_BOUNDS.hours[1]} hours`),
  ),
});

/** Deployment settings (BRIEF §4, ADR-0008, ADR-0012, ADR-0028 E1). Audit meta records old and new values. */
export async function updateSettings(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only admins can change settings.');
  const parsed = parse(settingsInput, input);
  const next = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)) as Partial<DeploymentSettings> & typeof parsed;
  const dep = await loadDeployment(tx, true);
  const before = dep.settings;
  const changed = (Object.keys(next) as (keyof DeploymentSettings)[]).filter((k) => before[k] !== next[k]);
  if (changed.length === 0) return 'No changes.';
  const updated = await tx
    .update(deployment)
    .set({ settings: { ...before, ...next }, updatedAt: new Date() })
    .where(sql`${deployment.id} = ${dep.id}::uuid`)
    .returning({ id: deployment.id });
  ensure(updated.length === 1, 'You are not allowed to change settings.');
  await audit(tx, actor, 'settings.update', `deployment:${dep.slug}`, {
    changed,
    before: Object.fromEntries(changed.map((k) => [k, before[k]])),
    after: Object.fromEntries(changed.map((k) => [k, next[k]])),
  });
  return `Saved: ${changed.join(', ')}.`;
}

/** The display name (header, e-mails, collector-config). The slug is fixed. */
export async function renameDeployment(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only admins can rename the deployment.');
  const { name: newName } = parse(z.object({ name: name(120) }), input);
  const dep = await loadDeployment(tx, true);
  if (dep.name === newName) return 'No changes.';
  const updated = await tx
    .update(deployment)
    .set({ name: newName, updatedAt: new Date() })
    .where(sql`${deployment.id} = ${dep.id}::uuid`)
    .returning({ id: deployment.id });
  ensure(updated.length === 1, 'You are not allowed to rename the deployment.');
  await audit(tx, actor, 'deployment.rename', `deployment:${dep.slug}`, { before: dep.name, after: newName });
  return 'Deployment renamed.';
}
