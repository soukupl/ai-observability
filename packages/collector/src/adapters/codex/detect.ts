import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../../fsutil.js';
import { compareVersions } from '../../version.js';
import type { Detection, DetectOptions } from '../types.js';
import { type CodexHooksFile, hasAiObsHooks, hooksFeatureDisabled, readHooksFile, untrustedEvents } from './hooks-config.js';
import { codexHome, hooksFilePath } from './locate.js';

/** Oldest Codex CLI whose hooks (incl. SessionEnd / SubagentStop) and rollout format we tested. */
export const MIN_TESTED_CODEX_VERSION = '0.147.0';

/** `codex --version` → "0.154.0" (null when codex is not on PATH or does not answer in 3 s). */
export function codexVersion(bin = 'codex'): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(bin, ['--version'], { timeout: 3000, windowsHide: true, env: { ...process.env, AI_OBS_SUMMARIZING: '1' } }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(String(stdout))?.[1] ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function scopeStatus(path: string): { installed: boolean; file: CodexHooksFile; error?: string } {
  try {
    const file = readHooksFile(path);
    return { installed: hasAiObsHooks(file), file };
  } catch (err) {
    return { installed: false, file: {}, error: errorMessage(err) };
  }
}

/** Never throws. `deps` lets tests replace the version probe and the Codex home. */
export async function detectCodex(opts: DetectOptions = {}, deps: { home?: string; version?: () => Promise<string | null> } = {}): Promise<Detection> {
  const notes: string[] = [];
  const warnings: string[] = [];
  try {
    const home = deps.home ?? codexHome();
    const version = await (deps.version ?? (() => codexVersion()))();
    const installed = version !== null || existsSync(home);
    const userPath = hooksFilePath('user', { home });
    const configToml = readText(join(home, 'config.toml'));

    const user = scopeStatus(userPath);
    if (user.error) notes.push(`cannot read ${userPath}: ${user.error}`);
    let project: boolean | null = null;
    const trust = (label: string, path: string, file: CodexHooksFile) => {
      const untrusted = untrustedEvents(configToml, path, file);
      if (untrusted.length) {
        warnings.push(`trust pending (${label}): Codex has not trusted ${untrusted.length} ai-obs hook(s) yet (${untrusted.join(', ')}); open Codex and run /hooks to review and trust them, until then nothing is recorded`);
      } else notes.push(`ai-obs hooks are trusted in Codex (${label})`);
    };
    if (opts.projectDir) {
      const projectPath = hooksFilePath('project', { projectDir: opts.projectDir });
      const p = scopeStatus(projectPath);
      project = p.installed;
      if (p.error) notes.push(`cannot read ${projectPath}: ${p.error}`);
      if (p.installed) trust('project', projectPath, p.file);
    }
    if (user.installed) trust('user', userPath, user.file);
    if (hooksFeatureDisabled(configToml)) notes.push('hooks are disabled in Codex config ([features] hooks = false); ai-obs receives nothing');
    if (installed && version === null) notes.push('`codex` is not on PATH (desktop app only?); version unknown');
    return {
      installed,
      version,
      versionSupported: version ? compareVersions(version, MIN_TESTED_CODEX_VERSION) >= 0 : null,
      hooksInstalled: { user: user.installed, project },
      configPath: userPath,
      ...(notes.length ? { notes } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (err) {
    return { installed: false, version: null, versionSupported: null, hooksInstalled: { user: false, project: null }, notes: [`detect failed: ${errorMessage(err)}`] };
  }
}
