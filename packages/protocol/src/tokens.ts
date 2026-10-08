import { COMPANY_TOKEN_PREFIX, USER_TOKEN_PREFIX, type TokenKind } from './constants.js';

/**
 * Returns the token kind from its prefix, or null for anything that is not an ai-obs ingest token (including
 * the retired team-scoped prefix, ADR-0022).
 */
export function tokenKind(token: string): TokenKind | null {
  if (token.startsWith(USER_TOKEN_PREFIX) && token.length > USER_TOKEN_PREFIX.length) return 'user';
  if (token.startsWith(COMPANY_TOKEN_PREFIX) && token.length > COMPANY_TOKEN_PREFIX.length) return 'company';
  return null;
}
