/**
 * Admin console types shared by server actions and client forms. No server imports here: client
 * components import this file.
 */
export type TeamRole = 'member' | 'lead';
export type MemberRole = 'admin' | 'member';

/** Who performs an admin operation. `CurrentUser` (lib/auth/session) satisfies it structurally. */
export interface Actor {
  id: string;
  role: MemberRole;
  teams: { id: string; role: TeamRole }[];
}

/** A freshly created ingest token, shown once in the browser and never stored in plain text. */
export interface TokenReveal {
  plaintext: string;
  /** The `ai-obs login --server … --token …` command for the machine that uses it. */
  command: string;
  /** ISO date-time, or null for a token without expiry. */
  expiresAt: string | null;
}

/** Result of a server action, rendered by the client form (useActionState). */
export type ActionState =
  | { status: 'idle' }
  | { status: 'ok'; message: string; token?: TokenReveal }
  | { status: 'error'; message: string };

export const IDLE: ActionState = { status: 'idle' };

/** An error whose message is safe to show to the user. */
export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminError';
  }
}

export function ensure(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AdminError(message);
}
