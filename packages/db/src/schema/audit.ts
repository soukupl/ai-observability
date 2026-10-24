import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { pk, tstz } from './columns.js';
import { users } from './tenancy.js';

/** Logins, token changes, settings changes, exports, device approvals (ADR-0028: no company column). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target: text('target'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_at_idx').on(t.at)],
);
