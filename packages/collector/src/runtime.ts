import { cpSync, existsSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiObsPaths } from './paths.js';

/** The collector package root (holds bin/, dist/, package.json). */
export function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

export interface RuntimeInstall {
  /** script hooks run: <home>/app/bin/ai-obs.js */
  entry: string;
  /** node binary hooks run with */
  node: string;
  copied: boolean;
}

const same = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * Copies the collector (bin, dist, package.json — it has no dependencies) to ~/.ai-obs/app so hooks
 * keep working after the npx cache is cleared. Hooks then run `<node> <home>/app/bin/ai-obs.js hook …`.
 * Without a built dist/ (running from source) it points hooks at the source checkout instead.
 */
export function installRuntime(paths: AiObsPaths, sourceRoot = packageRoot()): RuntimeInstall {
  const node = process.execPath;
  if (same(sourceRoot, paths.app)) return { entry: join(paths.app, 'bin', 'ai-obs.js'), node, copied: false };
  if (!existsSync(join(sourceRoot, 'dist', 'cli.js'))) {
    return { entry: join(sourceRoot, 'bin', 'ai-obs.js'), node, copied: false };
  }
  const tmp = `${paths.app}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const part of ['bin', 'dist', 'package.json']) {
    cpSync(join(sourceRoot, part), join(tmp, part), { recursive: true, filter: (src) => !src.endsWith('.map') });
  }
  rmSync(paths.app, { recursive: true, force: true });
  renameSync(tmp, paths.app);
  return { entry: join(paths.app, 'bin', 'ai-obs.js'), node, copied: true };
}

/** True when the collector home is the default ~/.ai-obs (hook commands then omit --home). */
export function isDefaultHome(paths: AiObsPaths): boolean {
  return paths.root === join(homedir(), '.ai-obs');
}
