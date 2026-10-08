import { pgEnum } from 'drizzle-orm/pg-core';

/** Plans set by the super admin (BRIEF §10). */
export const planEnum = pgEnum('plan', ['free', 'team', 'business']);
export const companyStatusEnum = pgEnum('company_status', ['active', 'suspended']);
/** Company-level role. "Lead" is not a company role — it is a per-team role (team_memberships). */
export const companyRoleEnum = pgEnum('company_role', ['admin', 'member']);
export const teamRoleEnum = pgEnum('team_role', ['member', 'lead']);
/** Collector token kinds (ADR-0022): company tokens (`aiobs_c_`) and user tokens (`aiobs_u_`). */
export const tokenKindEnum = pgEnum('token_kind', ['user', 'company']);
/** How a turn was tied to a user (ADR-0007). */
export const attributionEnum = pgEnum('attribution', ['verified', 'matched', 'unverified']);
export const outcomeEnum = pgEnum('outcome', ['success', 'failed', 'abandoned', 'unknown']);
export const budgetKindEnum = pgEnum('budget_kind', ['tokens', 'cost']);
export const identityProviderKindEnum = pgEnum('identity_provider_kind', ['saml', 'oidc']);

export type Plan = (typeof planEnum.enumValues)[number];
export type CompanyStatus = (typeof companyStatusEnum.enumValues)[number];
export type CompanyRole = (typeof companyRoleEnum.enumValues)[number];
export type TeamRole = (typeof teamRoleEnum.enumValues)[number];
export type TokenKind = (typeof tokenKindEnum.enumValues)[number];
export type Attribution = (typeof attributionEnum.enumValues)[number];
export type Outcome = (typeof outcomeEnum.enumValues)[number];
export type BudgetKind = (typeof budgetKindEnum.enumValues)[number];
