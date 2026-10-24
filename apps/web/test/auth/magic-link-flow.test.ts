import { sql } from 'drizzle-orm';
import { createDb, withRlsContext, type Database, type Tx } from '@ai-obs/db';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { magicLinkGet, magicLinkPost } from '../../src/app/api/auth/magic/[token]/handlers';
import { endSession, loadSessionUser, requestMagicLink, resolveIdentity, verifyMagicLink, type AuthDeps, type LoginResult } from '../../src/lib/auth/login';
import { hashToken, newToken } from '../../src/lib/auth/tokens';
import type { MailMessage } from '../../src/lib/mail';

/**
 * Login end to end against a real Postgres in its own database (TEST_DATABASE_URL's server, database
 * ai_obs_webauth_test, dropped afterwards): request → fake mailer → verify (single use) → provisioning (ADR-0028 E6/E7:
 * ADMIN_EMAILS, auto-accepted invitations, ALLOWED_EMAIL_DOMAINS, refusal) → session → current user.
 */
const testUrl = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_webauth_test');
testUrl.pathname = '/ai_obs_webauth_test';
vi.stubEnv('TEST_DATABASE_URL', testUrl.toString());
const harness = await import('../../../../packages/db/test/db-harness');
const skipReason = await harness.prepareTestDatabase();
if (skipReason) console.warn(`[web] auth flow tests skipped: ${skipReason}`);

const ROOT = 'root@spectado.example';
const ENV = { APP_URL: 'http://localhost:3000', SESSION_SECRET: 'test-secret-0123456789', ADMIN_EMAILS: ` ${ROOT.toUpperCase()} `, ALLOWED_EMAIL_DOMAINS: 'corp.example' };

describe.skipIf(skipReason !== null)(skipReason ? `auth flow — SKIPPED: ${skipReason}` : 'auth flow (real Postgres)', () => {
  let owner: Database;
  let deps: AuthDeps;
  const outbox: MailMessage[] = [];
  let core: string;
  let mobile: string;
  let bossId: string;

  const asDefiner = <T>(fn: (tx: Tx) => Promise<T>) =>
    owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return fn(tx);
    });
  const q = async <T>(s: ReturnType<typeof sql>) => Array.from((await owner.execute(s)) as unknown as T[]);
  const idOf = async (tx: Tx, s: ReturnType<typeof sql>) => ((await tx.execute(s)) as unknown as { id: string }[])[0]!.id;
  const invite = (email: string, teamId: string | null, role: 'admin' | 'member', teamRole: 'member' | 'lead' = 'member', ageMin = 0) =>
    asDefiner((tx) =>
      idOf(
        tx,
        sql`insert into invitations (email, team_id, team_role, role, invited_by_user_id, expires_at, created_at)
            values (${email}, ${teamId}, ${teamRole}, ${role}, ${bossId}, now() + interval '7 days', now() - make_interval(mins => ${ageMin})) returning id`,
      ),
    );
  const userCount = async (email: string) => (await q<{ n: number }>(sql`select count(*)::int as n from users where email = ${email}`))[0]!.n;
  const audit = (action: string) =>
    q<{ actor_user_id: string; meta: Record<string, string> }>(sql`select actor_user_id, meta from audit_log where action = ${action} order by at, id`);

  beforeAll(async () => {
    owner = harness.connectOwner();
    deps = { web: harness.connectAs('web'), mailer: { send: async (m) => void outbox.push(m) }, env: ENV };
    ({ core, mobile, bossId } = await asDefiner(async (tx) => {
      await tx.execute(sql`update deployment set name = 'SPECTADO', slug = 'spectado'`);
      const core = await idOf(tx, sql`insert into teams (name, slug) values ('Core', 'core') returning id`);
      const mobile = await idOf(tx, sql`insert into teams (name) values ('Mobile App') returning id`);
      const bossId = await idOf(tx, sql`insert into users (email, name) values ('boss@spectado.example', 'Boss') returning id`);
      await tx.execute(sql`insert into memberships (user_id, role, primary_team_id) values (${bossId}, 'admin', ${core})`);
      await tx.execute(sql`insert into team_memberships (team_id, user_id, role) values (${core}, ${bossId}, 'lead')`);
      return { core, mobile, bossId };
    }));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness.closeAll();
    const admin = new URL(testUrl);
    admin.pathname = '/postgres';
    const { db, close } = createDb({ url: admin.toString(), max: 1 });
    await db.execute(sql.raw('drop database if exists "ai_obs_webauth_test" with (force)')).catch(() => {});
    await close();
  });

  /** Request a link, read it from the fake mailbox, verify it, resolve the identity. */
  async function loginByMagicLink(email: string, next: string | null = null, ip = '203.0.113.7') {
    const sent = await requestMagicLink(deps, { email, ip, next });
    expect(sent).toEqual({ ok: true });
    const mail = outbox.at(-1)!;
    expect(mail.to).toBe(email.toLowerCase());
    const link = new URL(mail.text.match(/http\S+/)![0]);
    expect(link.origin).toBe('http://localhost:3000');
    const token = link.pathname.split('/').at(-1)!;
    const identity = await verifyMagicLink(deps, token);
    expect(identity?.email).toBe(email.toLowerCase());
    expect(await verifyMagicLink(deps, token)).toBeNull(); // single use
    return { link, result: await resolveIdentity(deps, identity!, next) };
  }

  const sessionOf = (r: LoginResult) => {
    if (r.kind !== 'session') throw new Error(`expected a session, got ${JSON.stringify(r)}`);
    return r;
  };
  const me = async (r: LoginResult) => (await loadSessionUser(deps, sessionOf(r).token))!;

  it('stores only token hashes; the e-mail names the deployment', async () => {
    await requestMagicLink(deps, { email: 'hash@check.example', ip: null, next: null });
    const mail = outbox.at(-1)!;
    expect(mail.subject).toBe('Your SPECTADO sign-in link');
    expect(mail.text).toContain('Sign in to SPECTADO');
    const token = mail.text.match(/magic\/([\w-]{43})/)![1]!;
    const rows = await q<{ token_hash: string; ttl: string }>(sql`select token_hash, expires_at - now() as ttl from magic_links where email = 'hash@check.example'`);
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(rows[0]!.ttl).toMatch(/^00:1[45]:/);
  });

  it('rejects unknown, malformed and expired links', async () => {
    expect(await verifyMagicLink(deps, newToken())).toBeNull();
    expect(await verifyMagicLink(deps, "x' or 1=1 --")).toBeNull();
    const token = newToken();
    await deps.web.execute(sql`insert into magic_links (email, token_hash, expires_at) values ('late@x.example', ${hashToken(token)}, now() - interval '1 minute')`);
    expect(await verifyMagicLink(deps, token)).toBeNull();
    expect(await requestMagicLink(deps, { email: 'nope', ip: null, next: null })).toEqual({ ok: false, error: 'invalid_email' });
  });

  it('ADMIN_EMAILS: an unknown listed e-mail becomes admin at its first login, with the welcome notice once', async () => {
    const first = sessionOf((await loginByMagicLink(ROOT)).result);
    expect(first).toMatchObject({ joined: 'admin-email', landing: '/welcome' });
    const user = await me(first);
    expect(user).toMatchObject({ email: ROOT, role: 'admin', teams: [], primaryTeamId: null });
    expect(user.deployment).toMatchObject({ name: 'SPECTADO', slug: 'spectado' });
    expect(user.deployment.settings.individualVisibility).toBe('aggregates-only');
    expect((await audit('auth.provisioned')).filter((r) => r.actor_user_id === user.id)).toEqual([
      { actor_user_id: user.id, meta: { method: 'magic', rule: 'admin-email' } },
    ]);
    // Second login: a plain login, no notice, no new membership.
    const again = sessionOf((await loginByMagicLink(ROOT, '/turns')).result);
    expect(again).toMatchObject({ joined: null, landing: '/turns' });
    expect(await userCount(ROOT)).toBe(1);
  });

  it('an invited e-mail is auto-accepted: role, team and team role from the invitation; `next` survives the notice', async () => {
    const invitationId = await invite('invitee@beta.example', core, 'member', 'lead');
    const r = sessionOf((await loginByMagicLink('Invitee@Beta.example', '/device')).result);
    expect(r).toMatchObject({ joined: 'invitation', landing: '/welcome?next=%2Fdevice' });
    const user = await me(r);
    expect(user).toMatchObject({ role: 'member', primaryTeamId: core, teams: [{ id: core, slug: 'core', name: 'Core', role: 'lead' }] });
    expect((await q<{ accepted_at: Date | null }>(sql`select accepted_at from invitations where id = ${invitationId}`))[0]!.accepted_at).not.toBeNull();
    expect((await audit('auth.invitation_accepted')).map((a) => a.actor_user_id)).toContain(user.id);
    expect((await audit('auth.login')).some((a) => a.actor_user_id === user.id && a.meta.method === 'magic')).toBe(true);
  });

  it('several invitations: the admin one is accepted first (role + primary team), every team is joined', async () => {
    await invite('two@beta.example', core, 'member', 'member', 1);
    await invite('two@beta.example', mobile, 'admin', 'lead', 5);
    const user = await me((await loginByMagicLink('two@beta.example')).result);
    expect(user.role).toBe('admin');
    expect(user.primaryTeamId).toBe(mobile);
    expect(user.teams.map((t) => [t.name, t.slug, t.role])).toEqual([
      ['Core', 'core', 'member'],
      ['Mobile App', 'mobile-app', 'lead'],
    ]);
  });

  it('ALLOWED_EMAIL_DOMAINS: a verified e-mail of an allowed domain joins as a member with no team; sub-domains do not', async () => {
    const r = sessionOf((await loginByMagicLink('dev@corp.example')).result);
    expect(r.joined).toBe('allowed-domain');
    expect(await me(r)).toMatchObject({ role: 'member', teams: [], primaryTeamId: null });
    expect((await loginByMagicLink('dev@sub.corp.example')).result).toEqual({ kind: 'error', code: 'not-invited' });
    expect(await userCount('dev@sub.corp.example')).toBe(0);
  });

  it('refuses an e-mail no rule admits, creating nothing', async () => {
    expect((await loginByMagicLink('stranger@else.example')).result).toEqual({ kind: 'error', code: 'not-invited' });
    expect(await userCount('stranger@else.example')).toBe(0);
    expect(await q(sql`select 1 from auth_sessions s join users u on u.id = s.user_id where u.email = 'stranger@else.example'`)).toHaveLength(0);
  });

  it('an existing member just logs in; an open invitation for them only adds the team', async () => {
    await invite('boss@spectado.example', mobile, 'member', 'member');
    const r = sessionOf((await loginByMagicLink('boss@spectado.example')).result);
    expect(r).toMatchObject({ joined: null, landing: '/overview' });
    const user = await me(r);
    expect(user.role).toBe('admin'); // unchanged by the member invitation
    expect(user.primaryTeamId).toBe(core);
    expect(user.teams.map((t) => t.name)).toEqual(['Core', 'Mobile App']);
  });

  it('a removed member loses the session at once and gets back in only with a new invitation', async () => {
    const live = sessionOf((await loginByMagicLink('dev@corp.example')).result);
    const dev = await me(live);
    await withRlsContext(deps.web, { userId: bossId, role: 'admin' }, (tx) => tx.execute(sql`select * from admin_remove_member(${dev.id}::uuid)`));
    expect(await loadSessionUser(deps, live.token)).toBeNull();
    // The domain rule must not undo the removal.
    expect((await loginByMagicLink('dev@corp.example')).result).toEqual({ kind: 'error', code: 'removed' });
    await invite('dev@corp.example', core, 'member');
    const back = sessionOf((await loginByMagicLink('dev@corp.example')).result);
    expect(back.joined).toBe('invitation');
    expect(back.userId).toBe(dev.id); // same identity, past activity stays attributed
    expect((await me(back)).teams.map((t) => t.slug)).toEqual(['core']);
  });

  it('logout deletes the session and is audited', async () => {
    const r = sessionOf((await loginByMagicLink('invitee@beta.example')).result);
    expect(await loadSessionUser(deps, r.token)).not.toBeNull();
    const before = (await audit('auth.logout')).length;
    await endSession(deps, r.token);
    expect(await loadSessionUser(deps, r.token)).toBeNull();
    expect((await audit('auth.logout')).length).toBe(before + 1);
  });

  it('OAuth: links the provider account by verified e-mail and logs in via the link afterwards', async () => {
    const identity = { email: 'boss@spectado.example', name: 'Boss', method: 'github' as const, account: { provider: 'github' as const, id: '4242' } };
    sessionOf(await resolveIdentity(deps, identity));
    // Same GitHub account, different e-mail at the provider → still the linked user (no domain or admin rule applies).
    const r = sessionOf(await resolveIdentity(deps, { ...identity, email: 'renamed@corp.example' }));
    expect((await me(r)).email).toBe('boss@spectado.example');
    expect(await userCount('renamed@corp.example')).toBe(0);
  });

  it('e-mailed link: GET only redirects to the confirm page (scanner-safe); a same-origin POST consumes it', async () => {
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    vi.stubEnv('SESSION_SECRET', 'test-secret-0123456789');
    await requestMagicLink(deps, { email: 'invitee@beta.example', ip: null, next: '/turns' });
    const link = new URL(outbox.at(-1)!.text.match(/http\S+/)![0]);
    const token = link.pathname.split('/').at(-1)!;

    for (let i = 0; i < 2; i++) {
      const res = magicLinkGet(new NextRequest(link), token);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`http://localhost:3000/login/magic/${token}?next=%2Fturns`);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(magicLinkGet(new NextRequest(link), 'not-a-token').headers.get('location')).toBe('http://localhost:3000/login?error=link_invalid');

    const post = (tok: string, headers: Record<string, string>) =>
      magicLinkPost(
        new NextRequest(`${link.origin}/api/auth/magic/${tok}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
          body: 'next=%2Fturns',
        }),
        tok,
        () => deps,
      );
    expect((await post(token, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(token, {})).status).toBe(403);

    const ok = await post(token, { origin: 'http://localhost:3000' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('http://localhost:3000/turns');
    expect(ok.headers.get('set-cookie')).toMatch(/ai_obs_session=/);
    const replay = await post(token, { origin: 'http://localhost:3000' });
    expect(replay.headers.get('location')).toBe('http://localhost:3000/login?error=link_invalid');

    // An e-mail no rule admits lands on the refusal page, without a session cookie.
    await requestMagicLink(deps, { email: 'nobody@else.example', ip: null, next: null });
    const refusedToken = new URL(outbox.at(-1)!.text.match(/http\S+/)![0]).pathname.split('/').at(-1)!;
    const refused = await post(refusedToken, { origin: 'http://localhost:3000' });
    expect(refused.headers.get('location')).toBe('http://localhost:3000/login/refused?reason=not-invited');
    expect(refused.headers.get('set-cookie') ?? '').not.toMatch(/ai_obs_session=[^;]/);
  });

  it('rate-limits magic links per e-mail', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await requestMagicLink(deps, { email: 'spam@x.example', ip: `198.51.100.${i}`, next: null }));
    expect(results.at(-1)).toEqual({ ok: false, error: 'rate_limited' });
  });
});
