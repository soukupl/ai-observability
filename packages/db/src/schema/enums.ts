import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Deployment-level role of a member (memberships.role). "Lead" is not a deployment role — it is a per-team role
 * (team_memberships). One deployment = one company (ADR-0028), so there is no company role any more.
 */
export const memberRoleEnum = pgEnum('member_role', ['admin', 'member']);
export const teamRoleEnum = pgEnum('team_role', ['member', 'lead']);
/** A person logs in; a service user (CI, bots, shared machines) never does and only holds admin-made tokens (Q9). */
export const userKindEnum = pgEnum('user_kind', ['person', 'service']);
/** How an ingest token was made (ADR-0029): `device` = `ai-obs login` (fixed 90 days), `manual` = created in the dashboard. */
export const tokenSourceEnum = pgEnum('token_source', ['device', 'manual']);
/** Lifecycle of a device-login code (ADR-0029, brief Appendix B). */
export const deviceCodeStatusEnum = pgEnum('device_code_status', ['pending', 'approved', 'denied', 'consumed', 'expired']);
/** How a turn was tied to a user (ADR-0007). New rows are always `verified`; `matched` / `unverified` are history. */
export const attributionEnum = pgEnum('attribution', ['verified', 'matched', 'unverified']);
export const outcomeEnum = pgEnum('outcome', ['success', 'failed', 'abandoned', 'unknown']);
export const budgetKindEnum = pgEnum('budget_kind', ['tokens', 'cost']);

export type MemberRole = (typeof memberRoleEnum.enumValues)[number];
export type TeamRole = (typeof teamRoleEnum.enumValues)[number];
export type UserKind = (typeof userKindEnum.enumValues)[number];
export type TokenSource = (typeof tokenSourceEnum.enumValues)[number];
export type DeviceCodeStatus = (typeof deviceCodeStatusEnum.enumValues)[number];
export type Attribution = (typeof attributionEnum.enumValues)[number];
export type Outcome = (typeof outcomeEnum.enumValues)[number];
export type BudgetKind = (typeof budgetKindEnum.enumValues)[number];
