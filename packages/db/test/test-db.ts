/**
 * Test database names. Every suite owns a database derived from TEST_DATABASE_URL (default
 * postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test): `<base without _test>_<suffix>_test`, so parallel runs with a
 * different TEST_DATABASE_URL never share a database, and every name still ends in `_test` (the harness refuses to
 * reset anything else).
 */
export const BASE_TEST_URL = process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test';

export function testDbName(suffix: string): string {
  const base = new URL(BASE_TEST_URL).pathname.slice(1).replace(/_test$/, '');
  return `${base}_${suffix}_test`;
}

/** URL of the suite's database (`suffix` = '' gives TEST_DATABASE_URL itself). */
export function testDbUrl(suffix: string): string {
  const u = new URL(BASE_TEST_URL);
  if (suffix) u.pathname = `/${testDbName(suffix)}`;
  return u.toString();
}

/** The maintenance URL (database `postgres`) for create / drop. */
export function adminDbUrl(): string {
  const u = new URL(BASE_TEST_URL);
  u.pathname = '/postgres';
  return u.toString();
}
