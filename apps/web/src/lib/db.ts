import { dbFor, type Database } from '@ai-obs/db';

export { withUserDb } from './auth/rls';

/** Pool connected as app_web (RLS-bound). Lazily created, so `next build` needs no DB. Prefer withUserDb(). */
export function getDb(): Database {
  return dbFor('web');
}
