import { createHash, randomBytes } from 'node:crypto';
import { REJECTED_TOKEN_PREFIXES, TOKEN_PREFIXES, tokenKind, type TokenKind } from '@ai-obs/protocol';

/** Random secret bytes per token (256 bit), base64url-encoded after the kind prefix. */
export const TOKEN_SECRET_BYTES = 32;
/** Characters of the secret kept in the non-secret display prefix, e.g. `aiobs_u_Ab3x`. */
export const TOKEN_DISPLAY_CHARS = 4;
/** Anything longer is not one of our tokens; refuse before hashing. */
export const MAX_TOKEN_LENGTH = 256;

/** Hex SHA-256 of the full plaintext token; the only form stored (ingest_tokens.hash, ADR-0007). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface GeneratedToken {
  kind: TokenKind;
  /** Shown to the user exactly once, never stored. */
  plaintext: string;
  /** Non-secret beginning for the UI (ingest_tokens.prefix). */
  prefix: string;
  /** ingest_tokens.hash */
  hash: string;
}

/**
 * Creates a new ingest token `aiobs_u_…` (person and service users alike, ADR-0029). Used by the admin console, the
 * "My tokens" page and the device exchange, which passes only the hash and the prefix to the database.
 */
export function generateToken(kind: TokenKind = 'user'): GeneratedToken {
  const kindPrefix = TOKEN_PREFIXES[kind];
  const plaintext = kindPrefix + randomBytes(TOKEN_SECRET_BYTES).toString('base64url');
  return {
    kind,
    plaintext,
    prefix: plaintext.slice(0, kindPrefix.length + TOKEN_DISPLAY_CHARS),
    hash: hashToken(plaintext),
  };
}

export type ParsedBearer = { token: string; kind: TokenKind } | { retired: true };

/**
 * Extracts an ai-obs token from `Authorization: Bearer …`. A retired company (`aiobs_c_`) or team (`aiobs_t_`) token is
 * reported as `{ retired: true }` so the caller can answer it with an explicit 401 without a lookup (ADR-0029); null
 * for anything else.
 */
export function parseBearer(header: string | null): ParsedBearer | null {
  const m = /^Bearer[ ]+(\S+)\s*$/i.exec(header ?? '');
  const token = m?.[1];
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  if (REJECTED_TOKEN_PREFIXES.some((p) => token.startsWith(p))) return { retired: true };
  const kind = tokenKind(token);
  return kind ? { token, kind } : null;
}
