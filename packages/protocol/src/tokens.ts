import { TEAM_TOKEN_PREFIX, USER_TOKEN_PREFIX, type TokenKind } from './constants.js';

/** Returns the token kind from its prefix, or null for anything that is not an ai-obs ingest token. */
export function tokenKind(token: string): TokenKind | null {
  if (token.startsWith(USER_TOKEN_PREFIX) && token.length > USER_TOKEN_PREFIX.length) return 'user';
  if (token.startsWith(TEAM_TOKEN_PREFIX) && token.length > TEAM_TOKEN_PREFIX.length) return 'team';
  return null;
}
