import { z } from 'zod';
import {
  MAX_MCP_SERVERS_PER_EVENT,
  MAX_MCP_TOOLS_PER_SERVER,
  MAX_SKILLS_PER_EVENT,
  MAX_SUMMARY_LENGTH,
  MAX_USAGE_NAME_LENGTH,
  MCP_LATENCY_BUCKETS_MS,
  OUTCOME_STATUSES,
  PHASES,
} from './constants.js';

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

/**
 * A skill, MCP server or MCP tool name: the harness's name in the company's `plain` project-naming
 * mode, `sha256:<64 hex>` in `hashed` mode. No whitespace or control characters.
 */
export const usageName = z
  .string()
  .min(1)
  .max(MAX_USAGE_NAME_LENGTH)
  .regex(/^[^\s\p{Cc}]+$/u, 'must not contain whitespace or control characters');

const maxKeys = (max: number) => (r: Record<string, unknown>) => Object.keys(r).length <= max;

/** Skill name → uses by source, e.g. `{ "code-review": { model: 2, user: 1 } }`. */
export const skills = z
  .record(usageName, z.object({ model: count.default(0), user: count.default(0) }))
  .refine(maxKeys(MAX_SKILLS_PER_EVENT), { message: `at most ${MAX_SKILLS_PER_EVENT} skills` });

/** MCP server → tool → call count, e.g. `{ github: { create_pull_request: 3 } }`. */
export const mcp = z
  .record(
    usageName,
    z.record(usageName, count).refine(maxKeys(MAX_MCP_TOOLS_PER_SERVER), { message: `at most ${MAX_MCP_TOOLS_PER_SERVER} tools per server` }),
  )
  .refine(maxKeys(MAX_MCP_SERVERS_PER_EVENT), { message: `at most ${MAX_MCP_SERVERS_PER_EVENT} MCP servers` });

export const outcome = z.object({
  status: z.enum(OUTCOME_STATUSES),
  signals: z.array(z.string().min(1).max(64)).max(32).default([]),
  provisional: z.boolean().default(false),
});

export const summary = z.string().min(1).max(MAX_SUMMARY_LENGTH);

/**
 * Reliability of MCP calls per server × tool (docs/briefs/mcp-reliability.md): `errors` (the harness marked the
 * result as failed), `denied` (the user refused the call), and for calls that got a result their total wall time
 * `ms` and a latency histogram over MCP_LATENCY_BUCKETS_MS (`buckets[i]` = calls in bucket i; 5 buckets). Calls
 * still open when the turn ended are in neither. Error texts and payloads are never sent.
 */
export const mcpToolStats = z.object({
  errors: count.default(0),
  denied: count.default(0),
  ms: count.default(0),
  buckets: z.array(count).length(MCP_LATENCY_BUCKETS_MS.length + 1),
});

export const mcpStats = z
  .record(
    usageName,
    z.record(usageName, mcpToolStats).refine(maxKeys(MAX_MCP_TOOLS_PER_SERVER), { message: `at most ${MAX_MCP_TOOLS_PER_SERVER} tools per server` }),
  )
  .refine(maxKeys(MAX_MCP_SERVERS_PER_EVENT), { message: `at most ${MAX_MCP_SERVERS_PER_EVENT} MCP servers` });
