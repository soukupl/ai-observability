import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../../fsutil.js';
import { compareVersions } from '../../version.js';
import type { Detection, DetectOptions } from '../types.js';
import { hooksDisabledAt, hooksInstalledAt, settingsPath } from './settings.js';

/** Oldest version whose hooks / transcript format this adapter was built against (FORMAT.md). */
export const MIN_SUPPORTED_VERSION = '2.1.0';
const VERSION_TTL_MS = 6 * 3600_000;

export type VersionProbe = () => Promise<string | null>;

/** `claude --version` → "2.1.289" (null when the binary is missing or silent). */
export const probeClaudeVersion: VersionProbe = () =>
  new Promise((resolve) => {
    try {
      execFile('claude', ['--version'], { timeout: 10_000, windowsHide: true, env: { ...process.env, AI_OBS_SUMMARIZING: '1' } }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(/(\d+\.\d+\.\d+)/.exec(String(stdout))?.[1] ?? null);
      });
    } catch {
      resolve(null);
    }
  });

/**
 * Version for session_start events, cached in <state>/claude-code.version.json for a few hours, so
 * the worker does not start the claude binary on every SessionStart.
 */
export async function cachedVersion(stateDir: string, probe: VersionProbe, now: number): Promise<string | null> {
  const file = join(stateDir, 'claude-code.version.json');
  const cached = readJsonFile<{ version: string | null; at: number }>(file);
  if (cached && now - cached.at < VERSION_TTL_MS && cached.version) return cached.version;
  const version = await probe();
  try {
    writeJsonAtomic(file, { version, at: now });
  } catch {
    /* cache only */
  }
  return version;
}

export async function detectClaudeCode(opts: DetectOptions & { claudeDir: string; probe: VersionProbe }): Promise<Detection> {
  const version = await opts.probe().catch(() => null);
  const userSettings = settingsPath('user', { claudeDir: opts.claudeDir });
  const installed = version !== null || existsSync(opts.claudeDir);
  const projectSettings = opts.projectDir ? settingsPath('project', { projectDir: opts.projectDir }) : null;
  const notes: string[] = [];
  if (version === null && installed) notes.push('`claude` not found on PATH; hooks will only fire once Claude Code is installed');
  if (hooksDisabledAt(userSettings) || (projectSettings && hooksDisabledAt(projectSettings))) notes.push('disableAllHooks is set; no hooks run');
  return {
    installed,
    version,
    versionSupported: version ? compareVersions(version, MIN_SUPPORTED_VERSION) >= 0 : null,
    hooksInstalled: { user: hooksInstalledAt(userSettings), project: projectSettings ? hooksInstalledAt(projectSettings) : null },
    configPath: userSettings,
    ...(notes.length ? { notes } : {}),
  };
}
