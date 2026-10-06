/**
 * Condensed per-turn digest used ONLY locally as input for the summary model (BRIEF §5.6). It is
 * never queued or sent; only the resulting ≤ 140-char summary leaves the machine.
 */
export interface TurnDigest {
  turnId: string;
  sessionId?: string;
  /** user prompt, truncated to 300 chars */
  prompt: string;
  /** distinct tool names used in the turn, in first-use order (max 30) */
  tools: string[];
  /** final assistant message, truncated to 300 chars */
  lastAssistantMessage: string;
}

export const DIGEST_TEXT_LIMIT = 300;

export function truncate(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function buildDigest(input: {
  turnId: string;
  sessionId?: string;
  prompt: string;
  toolNames: Iterable<string>;
  lastAssistantMessage: string;
}): TurnDigest {
  const tools = [...new Set(input.toolNames)].filter(Boolean).slice(0, 30);
  return {
    turnId: input.turnId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    prompt: truncate(input.prompt ?? '', DIGEST_TEXT_LIMIT),
    tools,
    lastAssistantMessage: truncate(input.lastAssistantMessage ?? '', DIGEST_TEXT_LIMIT),
  };
}
