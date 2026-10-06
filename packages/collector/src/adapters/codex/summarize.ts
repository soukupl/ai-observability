import { join } from 'node:path';
import type { TurnDigest } from '../../analysis/digest.js';
import { summarizeWithCommand } from '../../analysis/summaries.js';
import { readJsonFile } from '../../fsutil.js';

/** Used when models_cache.json names no small model. */
export const FALLBACK_SUMMARY_MODEL = 'gpt-5.4-mini';

interface CachedModel {
  slug?: string;
  description?: string;
  visibility?: string;
  supported_in_api?: boolean;
  supported_reasoning_levels?: Array<{ effort?: string } | string>;
}

/**
 * Cheapest model for one-line summaries. AI_OBS_CODEX_SUMMARY_MODEL wins; otherwise the user-visible
 * model in <codex home>/models_cache.json that looks smallest: "mini"/"nano" in the slug, then
 * "affordable"/"cheap", then "fast"/"efficient" in the description; ties → listed later (older).
 */
export function pickSummaryModel(codexHomeDir: string, env: Record<string, string | undefined> = process.env): string {
  if (env.AI_OBS_CODEX_SUMMARY_MODEL) return env.AI_OBS_CODEX_SUMMARY_MODEL;
  const cache = readJsonFile<{ models?: CachedModel[] }>(join(codexHomeDir, 'models_cache.json'));
  const models = (cache?.models ?? []).filter((m) => m.slug && (m.visibility ?? 'list') === 'list');
  const score = (m: CachedModel) => {
    const slug = m.slug!.toLowerCase();
    const d = (m.description ?? '').toLowerCase();
    return (/(^|-)(mini|nano)\b/.test(slug) ? 8 : 0) + (/affordable|cheap|low.cost/.test(d) ? 4 : 0) + (/\b(fast|efficient|lightweight|small)\b/.test(d) ? 2 : 0);
  };
  let best: CachedModel | null = null;
  let bestScore = 0;
  for (const m of models) {
    const s = score(m);
    if (s > 0 && s >= bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best?.slug ?? FALLBACK_SUMMARY_MODEL;
}

/**
 * Headless Codex call for the batched summary prompt (prompt on stdin via "-"):
 *   codex exec --ephemeral --skip-git-repo-check --sandbox read-only --ignore-user-config --ignore-rules
 *     -c features.hooks=false -c model_reasoning_effort="low" -m <model> -
 * --ignore-user-config keeps the user's MCP servers / plugins from starting (auth still comes from
 * CODEX_HOME); `withUserConfig` drops it (fallback for custom providers). AI_OBS_SUMMARIZING=1 is set
 * by runSummaryCommand, so even if hooks ran they would exit at once.
 */
export function summaryArgv(model: string, opts: { withUserConfig?: boolean; bin?: string } = {}): string[] {
  return [
    opts.bin ?? 'codex', 'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    ...(opts.withUserConfig ? [] : ['--ignore-user-config', '--ignore-rules']),
    '-c', 'features.hooks=false', '-c', 'model_reasoning_effort="low"', '-m', model, '-',
  ];
}

/**
 * `codex exec` prints the final agent message on stdout. If it was run with --json (JSONL events),
 * take the last agent message text instead.
 */
export function extractCodexText(stdout: string): string {
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{"type"'));
  if (!lines.length) return stdout;
  let last = '';
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as { item?: { type?: string; text?: string } };
      if (e.item?.type === 'agent_message' && typeof e.item.text === 'string') last = e.item.text;
    } catch {
      /* skip */
    }
  }
  return last || stdout;
}

/** One batched headless call; on failure retries once with the user's config (custom provider setups). */
export async function summarizeWithCodex(
  digests: TurnDigest[],
  opts: { codexHome: string; cwd: string; bin?: string; timeoutMs?: number; env?: Record<string, string | undefined> },
): Promise<Map<string, string>> {
  const model = pickSummaryModel(opts.codexHome, opts.env);
  const run = (withUserConfig: boolean) =>
    summarizeWithCommand(digests, {
      command: (prompt) => ({ argv: summaryArgv(model, { withUserConfig, ...(opts.bin ? { bin: opts.bin } : {}) }), input: prompt }),
      extractText: extractCodexText,
      cwd: opts.cwd,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  try {
    return await run(false);
  } catch {
    return run(true);
  }
}
