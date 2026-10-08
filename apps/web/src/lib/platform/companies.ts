import { auditLog, companies, companyMemberships, invitations, users, type CompanyStatus, type Database, type Plan } from '@ai-obs/db';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { appUrl, superAdminEmails } from '../auth/config';
import { planOverages } from '../admin/plans';
import type { Mailer } from '../mail';
import { adminInvitationEmail } from './mail';
import { parseEmail, parseName, parsePlan, parseSlug, slugFromName, type Result } from './validate';

/**
 * Super-admin console data layer. Everything here runs on dbFor('platform') (role app_platform):
 * it can read and write companies, read admin contacts (admin memberships and their users), insert
 * admin invitations and audit rows, and call platform_company_counts() / platform_invitee_status().
 * It has NO grants on telemetry, teams or tokens (ADR-0006),
 * so a bug here cannot leak customer data. Every mutation writes an audit_log row with the target
 * company in the same transaction.
 */
export interface PlatformDeps {
  db: Database;
  mailer: Mailer;
  env?: NodeJS.ProcessEnv;
}
export interface Actor {
  id: string;
}

export const INVITATION_DAYS = 14;
const DAY = 86_400_000;

export interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  status: CompanyStatus;
  createdAt: number;
  /** Members (company memberships). */
  users: number;
  teams: number;
  adminEmails: string[];
}

export interface AdminContact {
  email: string;
  name: string | null;
  /** Last time a session started in, or switched to, this company (not the last sign-in anywhere). */
  lastActiveAt: number | null;
}
export interface PendingInvite {
  id: string;
  email: string;
  expiresAt: number;
  acceptedAt: number | null;
  createdAt: number;
}
export interface AuditRow {
  id: string;
  at: number;
  action: string;
  target: string | null;
  actorEmail: string | null;
  companyId: string | null;
  companyName: string | null;
  meta: Record<string, unknown>;
}

const ms = (d: Date | string | null): number | null => (d === null ? null : new Date(d).getTime());

/** Postgres error code of a (possibly Drizzle-wrapped) driver error. */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

interface CountRow {
  company_id: string;
  users: string | number;
  teams: string | number;
}

export async function listCompanies(db: Database, opts: { q?: string; limit?: number } = {}): Promise<CompanyRow[]> {
  const q = opts.q?.trim().toLowerCase();
  const where = q ? sql`(lower(${companies.name}) like ${'%' + q.replace(/[\\%_]/g, '\\$&') + '%'} or ${companies.slug} like ${'%' + q.replace(/[\\%_]/g, '\\$&') + '%'})` : undefined;
  const rows = await db.select().from(companies).where(where).orderBy(desc(companies.createdAt)).limit(opts.limit ?? 500);
  if (rows.length === 0) return [];
  const counts = (await db.execute(sql`select company_id, users, teams from platform_company_counts()`)) as unknown as CountRow[];
  const countOf = new Map(counts.map((c) => [c.company_id, c]));
  const admins = await db
    .select({ companyId: companyMemberships.companyId, email: users.email })
    .from(companyMemberships)
    .innerJoin(users, eq(users.id, companyMemberships.userId))
    .where(eq(companyMemberships.companyRole, 'admin'))
    .orderBy(users.email);
  const adminsOf = new Map<string, string[]>();
  for (const a of admins) adminsOf.set(a.companyId, [...(adminsOf.get(a.companyId) ?? []), a.email]);
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    plan: c.plan,
    status: c.status,
    createdAt: ms(c.createdAt)!,
    users: Number(countOf.get(c.id)?.users ?? 0),
    teams: Number(countOf.get(c.id)?.teams ?? 0),
    adminEmails: adminsOf.get(c.id) ?? [],
  }));
}

export interface CompanyDetail extends CompanyRow {
  admins: AdminContact[];
  invitations: PendingInvite[];
}

export async function getCompanyDetail(db: Database, id: string): Promise<CompanyDetail | null> {
  const [c] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  if (!c) return null;
  const counts = (await db.execute(sql`select company_id, users, teams from platform_company_counts()`)) as unknown as CountRow[];
  const mine = counts.find((r) => r.company_id === id);
  const admins = await db
    .select({ email: users.email, name: users.name, lastActiveAt: companyMemberships.lastActiveAt })
    .from(companyMemberships)
    .innerJoin(users, eq(users.id, companyMemberships.userId))
    .where(and(eq(companyMemberships.companyId, id), eq(companyMemberships.companyRole, 'admin')))
    .orderBy(users.email);
  const invites = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.companyId, id), eq(invitations.companyRole, 'admin')))
    .orderBy(desc(invitations.createdAt))
    .limit(20);
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    plan: c.plan,
    status: c.status,
    createdAt: ms(c.createdAt)!,
    users: Number(mine?.users ?? 0),
    teams: Number(mine?.teams ?? 0),
    adminEmails: admins.map((a) => a.email),
    admins: admins.map((a) => ({ email: a.email, name: a.name, lastActiveAt: ms(a.lastActiveAt) })),
    invitations: invites.map((i) => ({
      id: i.id,
      email: i.email,
      expiresAt: ms(i.expiresAt)!,
      acceptedAt: ms(i.acceptedAt),
      createdAt: ms(i.createdAt)!,
    })),
  };
}

/** Platform actions (`platform.*`), newest first; for one company or across all. */
export async function listPlatformAudit(db: Database, opts: { companyId?: string; limit?: number } = {}): Promise<AuditRow[]> {
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      target: auditLog.target,
      meta: auditLog.meta,
      companyId: auditLog.companyId,
      actorEmail: users.email,
      companyName: companies.name,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .leftJoin(companies, eq(companies.id, auditLog.companyId))
    .where(and(like(auditLog.action, 'platform.%'), opts.companyId ? eq(auditLog.companyId, opts.companyId) : undefined))
    .orderBy(desc(auditLog.at))
    .limit(opts.limit ?? 50);
  return rows.map((r) => ({ ...r, at: ms(r.at)! }));
}

export type ActionResult = { ok: true; notice?: string; warning?: string; companyId?: string } | { ok: false; error: string };

type PlatformTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Inserts the invitation row (admin role, no team) inside a caller's transaction. */
async function insertInvitation(tx: PlatformTx, actor: Actor, companyId: string, email: string): Promise<void> {
  await tx.insert(invitations).values({
    companyId,
    email,
    companyRole: 'admin',
    teamRole: 'member',
    invitedByUserId: actor.id,
    expiresAt: new Date(Date.now() + INVITATION_DAYS * DAY),
  });
}

async function sendInvitation(deps: PlatformDeps, companyName: string, email: string): Promise<string | null> {
  try {
    // New e-mails join on the sign-up step; existing accounts (members of another company) at /invitations (D9).
    const login = new URL('/login?next=%2Finvitations', appUrl(deps.env ?? process.env)).toString();
    await deps.mailer.send(adminInvitationEmail(email, companyName, login, INVITATION_DAYS));
    return null;
  } catch {
    return `The invitation was saved, but the e-mail to ${email} could not be sent. Use "Invite admin" to send it again.`;
  }
}

function emailBlocked(email: string, env: NodeJS.ProcessEnv): string | null {
  return superAdminEmails(env).has(email) ? 'That address is listed in SUPER_ADMIN_EMAILS; super admins cannot be company admins.' : null;
}

/**
 * What the console may know about an invitee (SECURITY DEFINER platform_invitee_status): 'super_admin',
 * 'admin' (already an admin of `companyId`) or null (no account, or an account that is not an admin
 * there). Plain membership is never disclosed to the platform: a member of the company simply does not
 * see the invitation (auth_pending_invitations hides it), and members of other companies may be invited,
 * since one login can belong to several companies (ADR-0022).
 */
export async function inviteeStatus(
  tx: Pick<Database, 'execute'>,
  email: string,
  companyId: string | null,
): Promise<'super_admin' | 'admin' | null> {
  const rows = (await tx.execute(sql`select platform_invitee_status(${email}::text, ${companyId}::uuid) as status`)) as unknown as Array<{
    status: 'super_admin' | 'admin' | null;
  }>;
  return rows[0]?.status ?? null;
}

const SUPER_ADMIN_REFUSED = 'That address belongs to a super admin; super admins cannot be company admins.';

export interface CreateCompanyInput {
  name: unknown;
  slug: unknown;
  plan: unknown;
  adminEmail: unknown;
}

export async function createCompany(deps: PlatformDeps, actor: Actor, input: CreateCompanyInput): Promise<ActionResult> {
  const name = parseName(input.name);
  if (!name.ok) return name;
  const rawSlug = typeof input.slug === 'string' && input.slug.trim() ? input.slug : slugFromName(name.value);
  const slug = parseSlug(rawSlug);
  if (!slug.ok) return slug;
  const plan = parsePlan(input.plan);
  if (!plan.ok) return plan;
  const email = parseEmail(input.adminEmail);
  if (!email.ok) return email;
  const blocked = emailBlocked(email.value, deps.env ?? process.env);
  if (blocked) return { ok: false, error: blocked };

  let companyId: string;
  try {
    companyId = await deps.db.transaction(async (tx) => {
      if ((await inviteeStatus(tx, email.value, null)) === 'super_admin') throw Object.assign(new Error('super-admin'), { code: 'super-admin' });
      const [c] = await tx.insert(companies).values({ name: name.value, slug: slug.value, plan: plan.value }).returning({ id: companies.id });
      await insertInvitation(tx, actor, c!.id, email.value);
      await tx.insert(auditLog).values({
        companyId: c!.id,
        actorUserId: actor.id,
        action: 'platform.company_created',
        target: slug.value,
        meta: { name: name.value, plan: plan.value, adminEmail: email.value },
      });
      return c!.id;
    });
  } catch (err) {
    if (pgCode(err) === '23505') return { ok: false, error: `The slug "${slug.value}" is already taken.` };
    if (pgCode(err) === 'super-admin') return { ok: false, error: SUPER_ADMIN_REFUSED };
    throw err;
  }
  const warning = await sendInvitation(deps, name.value, email.value);
  return { ok: true, companyId, notice: `Company "${name.value}" created; invitation sent to ${email.value}.`, ...(warning ? { warning } : {}) };
}

/** Invites (another) admin to an existing company; also the way to re-send a lost invitation. */
export async function inviteAdmin(deps: PlatformDeps, actor: Actor, companyId: string, rawEmail: unknown): Promise<ActionResult> {
  const email = parseEmail(rawEmail);
  if (!email.ok) return email;
  const blocked = emailBlocked(email.value, deps.env ?? process.env);
  if (blocked) return { ok: false, error: blocked };
  type Outcome = { kind: 'ok'; name: string } | { kind: 'missing' } | { kind: 'already-admin' } | { kind: 'super-admin' };
  const out = await deps.db.transaction(async (tx): Promise<Outcome> => {
    const [c] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!c) return { kind: 'missing' };
    const status = await inviteeStatus(tx, email.value, companyId);
    if (status === 'admin') return { kind: 'already-admin' };
    if (status === 'super_admin') return { kind: 'super-admin' };
    await insertInvitation(tx, actor, companyId, email.value);
    await tx.insert(auditLog).values({ companyId, actorUserId: actor.id, action: 'platform.admin_invited', target: email.value, meta: {} });
    return { kind: 'ok', name: c.name };
  });
  if (out.kind === 'missing') return { ok: false, error: 'Company not found.' };
  if (out.kind === 'already-admin') return { ok: false, error: 'That person is already an admin of this company.' };
  if (out.kind === 'super-admin') return { ok: false, error: SUPER_ADMIN_REFUSED };
  const warning = await sendInvitation(deps, out.name, email.value);
  return {
    ok: true,
    notice:
      `Invitation sent to ${email.value}. If they are already a member, the invitation is not offered to them; ` +
      'a company admin can promote them instead.',
    ...(warning ? { warning } : {}),
  };
}

export async function changePlan(deps: PlatformDeps, actor: Actor, companyId: string, rawPlan: unknown): Promise<ActionResult> {
  const plan = parsePlan(rawPlan);
  if (!plan.ok) return plan;
  return deps.db.transaction(async (tx): Promise<ActionResult> => {
    const [c] = await tx.select({ plan: companies.plan, settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).for('update');
    if (!c) return { ok: false, error: 'Company not found.' };
    if (c.plan === plan.value) return { ok: false, error: `The company is already on the ${plan.value} plan.` };
    // A downgrade never deletes anything: existing usage above the new plan's limits is grandfathered,
    // only growth is refused, and retention is capped by the worker (dod:C2). Say so, with the numbers.
    const [n] = (await tx.execute(sql`select users, teams from platform_company_counts() where company_id = ${companyId}::uuid`)) as unknown as Array<{ users: number | string; teams: number | string }>;
    const overages = planOverages(plan.value, {
      users: Number(n?.users ?? 0),
      teams: Number(n?.teams ?? 0),
      retentionDays: c.settings?.retentionDays,
    });
    await tx.update(companies).set({ plan: plan.value, updatedAt: new Date() }).where(eq(companies.id, companyId));
    await tx.insert(auditLog).values({
      companyId,
      actorUserId: actor.id,
      action: 'platform.plan_changed',
      target: plan.value,
      meta: { from: c.plan, to: plan.value },
    });
    const warning = overages.length
      ? `Over the ${plan.value} plan: ${overages.join('; ')}. Existing data and members are kept, new growth is refused.`
      : undefined;
    return { ok: true, notice: `Plan changed from ${c.plan} to ${plan.value}.`, ...(warning ? { warning } : {}) };
  });
}

/** Suspended companies are refused by ingest (403) and by login; data is kept. */
export async function setStatus(deps: PlatformDeps, actor: Actor, companyId: string, status: CompanyStatus, rawReason?: unknown): Promise<ActionResult> {
  const reason = typeof rawReason === 'string' ? rawReason.trim().slice(0, 200) : '';
  return deps.db.transaction(async (tx): Promise<ActionResult> => {
    const [c] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId)).for('update');
    if (!c) return { ok: false, error: 'Company not found.' };
    if (c.status === status) return { ok: false, error: `The company is already ${status}.` };
    await tx.update(companies).set({ status, updatedAt: new Date() }).where(eq(companies.id, companyId));
    await tx.insert(auditLog).values({
      companyId,
      actorUserId: actor.id,
      action: status === 'suspended' ? 'platform.company_suspended' : 'platform.company_unsuspended',
      target: status,
      meta: { from: c.status, to: status, ...(reason ? { reason } : {}) },
    });
    return { ok: true, notice: status === 'suspended' ? 'Company suspended.' : 'Company reactivated.' };
  });
}
