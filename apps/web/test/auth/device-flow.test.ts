import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, withRlsContext, type Database, type Tx } from '@ai-obs/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approveDeviceLogin, denyDeviceLogin, lookupDeviceLogin, normalizeUserCode, withMissBudget } from '../../src/lib/auth/device';
import { RateLimiter } from '../../src/lib/auth/rate-limit';

/**
 * The /device approval page's data layer against real Postgres (database <TEST_DATABASE_URL name>_device_test, by default ai_obs_webauth_device_test, dropped
 * afterwards): a code made by the public route's SQL (device_create_code), looked up, approved or denied by a signed-in
 * person, then exchanged by the polling CLI (device_exchange) for a 90-day device token (ADR-0029 T4).
 */
const testUrl = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_webauth_test');
const DB_NAME = `${testUrl.pathname.slice(1).replace(/_test$/, '')}_device_test`;
testUrl.pathname = `/${DB_NAME}`;
vi.stubEnv('TEST_DATABASE_URL', testUrl.toString());
const harness = await import('../../../../packages/db/test/db-harness');
const skipReason = await harness.prepareTestDatabase();
if (skipReason) console.warn(`[web] device flow tests skipped: ${skipReason}`);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe.skipIf(skipReason !== null)(skipReason ? `device approval — SKIPPED: ${skipReason}` : 'device approval (real Postgres)', () => {
  let owner: Database;
  let web: Database;
  let alice: string;
  let svc: string;
  let gone: string;

  const asDefiner = <T>(fn: (tx: Tx) => Promise<T>) =>
    owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return fn(tx);
    });
  const idOf = async (tx: Tx, s: ReturnType<typeof sql>) => ((await tx.execute(s)) as unknown as { id: string }[])[0]!.id;
  const as = <T>(userId: string, fn: (tx: Tx) => Promise<T>) => withRlsContext(web, { userId, role: 'member' }, fn);
  /** What POST /api/v1/device/code stores (the route itself is the ingest builder's). */
  const newCode = async (deviceCode: string, userCode: string, client = 'mac-alice') => {
    const rows = (await web.execute(
      sql`select * from device_create_code(${sha(deviceCode)}, ${userCode}, ${client}, '0.5.0', '203.0.113.9')`,
    )) as unknown as { user_code: string }[];
    expect(rows[0]?.user_code).toBe(normalizeUserCode(userCode));
  };
  const exchange = async (deviceCode: string, token: string) =>
    ((await web.execute(sql`select * from device_exchange(${sha(deviceCode)}, ${sha(token)}, ${token.slice(0, 12)}, 0)`)) as unknown as {
      status: string;
      token_id: string | null;
      user_id: string | null;
    }[])[0]!;

  beforeAll(async () => {
    owner = harness.connectOwner();
    web = harness.connectAs('web');
    ({ alice, svc, gone } = await asDefiner(async (tx) => {
      const alice = await idOf(tx, sql`insert into users (email, name) values ('alice@spectado.example', 'Alice') returning id`);
      await tx.execute(sql`insert into memberships (user_id, role) values (${alice}, 'member')`);
      const svc = await idOf(tx, sql`insert into users (name, kind) values ('CI', 'service') returning id`);
      await tx.execute(sql`insert into memberships (user_id, role) values (${svc}, 'member')`);
      const gone = await idOf(tx, sql`insert into users (email, name) values ('gone@spectado.example', 'Gone') returning id`);
      return { alice, svc, gone };
    }));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness.closeAll();
    const admin = new URL(testUrl);
    admin.pathname = '/postgres';
    const { db, close } = createDb({ url: admin.toString(), max: 1 });
    await db.execute(sql.raw(`drop database if exists "${DB_NAME}" with (force)`)).catch(() => {});
    await close();
  });

  it('shows the client name, requester IP and age of an open code, typed with or without the dash', async () => {
    await newCode('device-code-approve-0000000000000000000000', 'BCDF-GHJK');
    const found = await as(alice, (tx) => lookupDeviceLogin(tx, normalizeUserCode('bcdf-ghjk')!));
    expect(found).toMatchObject({ code: 'BCDFGHJK', clientName: 'mac-alice', clientVersion: '0.5.0', requesterIp: '203.0.113.9' });
    expect(found!.expiresMs - found!.createdMs).toBe(600_000);
    expect(await as(alice, (tx) => lookupDeviceLogin(tx, 'BCDFGHJM'))).toBeNull();
    // A user without a membership sees nothing.
    expect(await as(gone, (tx) => lookupDeviceLogin(tx, 'BCDFGHJK'))).toBeNull();
  });

  it('approve marks the code; the CLI poll then mints a 90-day device token for the approver, once', async () => {
    const devCode = 'device-code-approve-0000000000000000000000';
    expect((await exchange(devCode, 'aiobs_u_pending-000000000000')).status).toBe('authorization_pending');
    expect(await as(alice, (tx) => approveDeviceLogin(tx, alice, 'BCDFGHJK'))).toBe(true);
    expect(await as(alice, (tx) => approveDeviceLogin(tx, alice, 'BCDFGHJK'))).toBe(false); // no longer pending
    expect(await as(alice, (tx) => lookupDeviceLogin(tx, 'BCDFGHJK'))).toBeNull();

    const ok = await exchange(devCode, 'aiobs_u_minted-0000000000000');
    expect(ok).toMatchObject({ status: 'ok', user_id: alice });
    const [tok] = (await owner.execute(
      sql`select user_id, source, label, name, expires_at - now() as ttl, hash from ingest_tokens where id = ${ok.token_id}`,
    )) as unknown as { user_id: string; source: string; label: string; name: string; ttl: string; hash: string }[];
    expect(tok).toMatchObject({ user_id: alice, source: 'device', label: 'mac-alice', name: 'mac-alice', hash: sha('aiobs_u_minted-0000000000000') });
    expect(tok!.ttl).toMatch(/^(89 days 23:|90 days)/);
    expect((await exchange(devCode, 'aiobs_u_again-00000000000000')).status).toBe('invalid_grant'); // exchanged at most once

    const audit = (await owner.execute(sql`select action, actor_user_id, meta from audit_log order by at, id`)) as unknown as {
      action: string;
      actor_user_id: string;
      meta: Record<string, unknown>;
    }[];
    expect(audit.map((a) => [a.action, a.actor_user_id])).toEqual([
      ['device.approve', alice],
      ['token.create', alice],
    ]);
    expect(audit[0]!.meta).toMatchObject({ client_name: 'mac-alice', requester_ip: '203.0.113.9' });
  });

  it('deny: the CLI poll answers access_denied', async () => {
    await newCode('device-code-deny-000000000000000000000000', 'LMNPQRST', 'build-box');
    expect(await as(alice, (tx) => denyDeviceLogin(tx, alice, 'LMNPQRST'))).toBe(true);
    expect(await as(alice, (tx) => denyDeviceLogin(tx, alice, 'LMNPQRST'))).toBe(false);
    expect((await exchange('device-code-deny-000000000000000000000000', 'aiobs_u_denied-0000000000000')).status).toBe('access_denied');
  });

  it('once the wrong-code budget is spent, a correct code is refused too, for lookup, approve and deny alike', async () => {
    await newCode('device-code-budget-0000000000000000000000', 'MNPQ-RSTV', 'victim-box');
    const limiter = new RateLimiter(2, 60_000);
    const look = (code: string) => withMissBudget(limiter, alice, () => as(alice, (tx) => lookupDeviceLogin(tx, code)));
    expect(await look('MNPQRSTW')).toEqual({ status: 'miss' });
    expect(await withMissBudget(limiter, alice, () => as(alice, (tx) => approveDeviceLogin(tx, alice, 'MNPQRSTX')))).toEqual({ status: 'miss' });
    expect(await look('MNPQRSTV')).toEqual({ status: 'limited' });
    expect(await withMissBudget(limiter, alice, () => as(alice, (tx) => approveDeviceLogin(tx, alice, 'MNPQRSTV')))).toEqual({ status: 'limited' });
    expect(await withMissBudget(limiter, alice, () => as(alice, (tx) => denyDeviceLogin(tx, alice, 'MNPQRSTV')))).toEqual({ status: 'limited' });
    // Nothing reached the database: the code is still open and unapproved.
    expect(await as(alice, (tx) => lookupDeviceLogin(tx, 'MNPQRSTV'))).toMatchObject({ clientName: 'victim-box' });
    expect((await exchange('device-code-budget-0000000000000000000000', 'aiobs_u_budget-0000000000000')).status).toBe('authorization_pending');
  });

  it('a service user cannot approve a device login', async () => {
    await newCode('device-code-service-000000000000000000000', 'VWXYZABC');
    expect(await harness.pgErrorCode(as(svc, (tx) => approveDeviceLogin(tx, svc, 'VWXYZABC')))).toBe('42501');
  });
});
