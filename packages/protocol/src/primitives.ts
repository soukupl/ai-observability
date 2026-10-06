import { z } from 'zod';
import { MAX_SUMMARY_LENGTH, OUTCOME_STATUSES, PHASES } from './constants.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const HASHED_PROJECT_KEY_RE = /^sha256:[0-9a-f]{64}$/;
/** A plain key is a normalized git remote such as `github.com/acme/billing` — never a local path. */
const PLAIN_PROJECT_KEY_RE = /^[a-z0-9.-]+(:\d+)?\/[^\s\\]+$/i;

export const ulid = z.string().regex(ULID_RE, 'must be a ULID');
export const timestamp = z.iso.datetime({ offset: true });
export const count = z.int().nonnegative();
export const shortText = z.string().min(1).max(128);
export const nonEmptyId = z.string().min(1).max(256);

export const harness = z.string().min(1).max(64);
export const model = z.string().min(1).max(128);
export const effort = z.string().min(1).max(32).nullable();

/** Harness-specific extras (ADR-0005). Must not carry prompts, code, diffs or file paths. */
export const ext = z.record(z.string(), z.unknown());

export const projectKey = z
  .string()
  .max(512)
  .refine((k) => HASHED_PROJECT_KEY_RE.test(k) || PLAIN_PROJECT_KEY_RE.test(k), {
    message: 'must be a normalized git remote (host/path) or sha256:<64 hex>',
  });

export function projectKeyKind(key: string): 'plain' | 'hashed' {
  return HASHED_PROJECT_KEY_RE.test(key) ? 'hashed' : 'plain';
}

export const project = z.object({
  key: projectKey,
  name: z.string().min(1).max(200).optional(),
});

/** Token counts for one model × effort pair. */
export const usageEntry = z.object({
  model,
  effort,
  input: count,
  output: count,
  cache_read: count,
  cache_write: count,
  reasoning: count,
  requests: count,
});

const phaseShape = Object.fromEntries(PHASES.map((p) => [p, count.optional()])) as Record<
  (typeof PHASES)[number],
  z.ZodOptional<typeof count>
>;
export const phasesMs = z.object(phaseShape);

/** Tool category → call count, e.g. `{ edit: 3, bash: 2, read: 7 }`. */
export const tools = z.record(z.string().min(1).max(128), count);

export const outcome = z.object({
  status: z.enum(OUTCOME_STATUSES),
  signals: z.array(z.string().min(1).max(64)).max(32).default([]),
  provisional: z.boolean().default(false),
});

export const summary = z.string().min(1).max(MAX_SUMMARY_LENGTH);
