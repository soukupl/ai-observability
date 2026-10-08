/**
 * Admin console types shared by server actions and client forms. No server imports here: client
 * components import this file.
 */
export type TeamRole = 'member' | 'lead';
export type CompanyRole = 'admin' | 'member';

/** Who performs an admin operation. `CompanyUser` (lib/auth/session) satisfies it structurally. */
export interface Actor {
  id: string;
  companyId: string;
  companyRole: CompanyRole;
  teams: { id: string; role: TeamRole }[];
}

/** A freshly created ingest token, shown once in the browser and never stored in plain text. */
export interface TokenReveal {
  kind: 'user' | 'company';
  plaintext: string;
  command: string;
  /** Company tokens: collector settings JSON for MDM / dotfiles rollout. */
  mdmJson?: string;
  mdmFilename?: string;
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
