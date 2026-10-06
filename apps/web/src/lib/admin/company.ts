import { sql } from 'drizzle-orm';
import { companies, DEFAULT_COMPANY_SETTINGS, type CompanySettings, type Plan, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { name, parse } from './input';
import { isAdmin } from './permissions';
import { retentionError } from './plans';
import { AdminError, ensure, type Actor } from './types';

export interface CompanyInfo {
  id: string;
  name: string;
  plan: Plan;
  status: 'active' | 'suspended';
  settings: CompanySettings;
}

/** The actor's company, read in the transaction (fresher than the session). `lock` serializes limit checks. */
export async function loadCompany(tx: Tx, companyId: string, lock = false): Promise<CompanyInfo> {
  const [c] = await rows<{ id: string; name: string; plan: Plan; status: 'active' | 'suspended'; settings: CompanySettings }>(
    tx,
    sql`select id, name, plan, status, settings from companies where id = ${companyId}::uuid ${lock ? sql`for update` : sql``}`,
  );
  if (!c) throw new AdminError('Company not found.');
  return { ...c, settings: { ...DEFAULT_COMPANY_SETTINGS, ...c.settings } };
}

export interface CompanyCounts {
  users: number;
  pendingInvitations: number;
  teams: number;
  activeTokens: number;
  projects: number;
}

/** Counts for plan limits and the overview. Invitations / tokens are admin-visible only (RLS). */
export async function companyCounts(tx: Tx, companyId: string): Promise<CompanyCounts> {
  const [r] = await rows<Record<keyof CompanyCounts, number>>(
    tx,
    sql`select
      (select count(*)::int from users where company_id = ${companyId}::uuid) as users,
      (select count(*)::int from invitations where company_id = ${companyId}::uuid and accepted_at is null and expires_at > now()) as "pendingInvitations",
      (select count(*)::int from teams where company_id = ${companyId}::uuid) as teams,
      (select count(*)::int from ingest_tokens where company_id = ${companyId}::uuid and revoked_at is null) as "activeTokens",
      (select count(*)::int from projects where company_id = ${companyId}::uuid) as projects`,
  );
  return {
    users: Number(r?.users ?? 0),
    pendingInvitations: Number(r?.pendingInvitations ?? 0),
    teams: Number(r?.teams ?? 0),
    activeTokens: Number(r?.activeTokens ?? 0),
    projects: Number(r?.projects ?? 0),
  };
}

export const settingsInput = z.object({
  individualVisibility: z.enum(['aggregates-only', 'full']),
  projectNaming: z.enum(['plain', 'hashed']),
  retentionDays: z.coerce.number().int('whole days only'),
});

/** Company settings (BRIEF §4, ADR-0008, ADR-0012). Audit meta records old and new values. */
export async function updateSettings(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only company admins can change settings.');
  const next = parse(settingsInput, input);
  const company = await loadCompany(tx, actor.companyId, true);
  const err = retentionError(company.plan, next.retentionDays);
  if (err) throw new AdminError(err);
  const before = company.settings;
  const changed = (Object.keys(next) as (keyof CompanySettings)[]).filter((k) => before[k] !== next[k]);
  if (changed.length === 0) return 'No changes.';
  const updated = await tx
    .update(companies)
    .set({ settings: { ...before, ...next }, updatedAt: new Date() })
    .where(sql`${companies.id} = ${actor.companyId}::uuid`)
    .returning({ id: companies.id });
  ensure(updated.length === 1, 'You are not allowed to change settings.');
  await audit(tx, actor, 'settings.update', `company:${actor.companyId}`, {
    changed,
    before: Object.fromEntries(changed.map((k) => [k, before[k]])),
    after: Object.fromEntries(changed.map((k) => [k, next[k]])),
  });
  return `Saved: ${changed.join(', ')}.`;
}

export async function renameCompany(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only company admins can rename the company.');
  const { name: newName } = parse(z.object({ name: name(120) }), input);
  const company = await loadCompany(tx, actor.companyId, true);
  if (company.name === newName) return 'No changes.';
  await tx.update(companies).set({ name: newName, updatedAt: new Date() }).where(sql`${companies.id} = ${actor.companyId}::uuid`);
  await audit(tx, actor, 'company.rename', `company:${actor.companyId}`, { before: company.name, after: newName });
  return 'Company renamed.';
}
