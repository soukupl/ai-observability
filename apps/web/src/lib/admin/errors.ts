import { AdminError } from './types';

interface PgLike {
  code?: string;
  constraint_name?: string;
  cause?: PgLike;
}

/** Postgres SQLSTATE of an error, also when Drizzle wraps it. */
export function pgCode(err: unknown): string | undefined {
  const e = err as PgLike | null;
  return e?.code ?? e?.cause?.code;
}

/** Turns any thrown value into a message that is safe to show (no SQL, no internals). */
export function userMessage(err: unknown): string {
  if (err instanceof AdminError) return err.message;
  switch (pgCode(err)) {
    case '23505':
      return 'That already exists.';
    case '23503':
      return 'It is still in use, so it cannot be changed or removed.';
    case '23514':
      return 'That value is not allowed.';
    case '42501':
      return 'You are not allowed to do that.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
