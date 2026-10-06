import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { pk, tstz } from './columns.js';
import { companies, users } from './tenancy.js';

/** Logins, token changes, settings changes, exports, platform actions (company_id null = platform-level). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target: text('target'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_company_at_idx').on(t.companyId, t.at)],
);
