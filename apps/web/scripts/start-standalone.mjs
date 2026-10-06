// `pnpm start`: runs the Next standalone server. The standalone bundle does not contain `.next/static`
// or `public` (the Dockerfile copies them next to it); without them every CSS/JS asset is a 404 and the
// UI is unstyled. This copies them in (idempotent), then starts server.js.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Copies `.next/static` and `public` next to the standalone server. Returns the server.js path. */
export function prepareStandalone(webDir) {
  const server = join(webDir, '.next', 'standalone', 'apps', 'web');
  if (!existsSync(join(server, 'server.js'))) {
    throw new Error(`No standalone build at ${server}. Run \`pnpm --filter @ai-obs/web build\` first.`);
  }
  const staticSrc = join(webDir, '.next', 'static');
  if (existsSync(staticSrc)) {
    mkdirSync(join(server, '.next'), { recursive: true });
    cpSync(staticSrc, join(server, '.next', 'static'), { recursive: true });
  }
  const publicSrc = join(webDir, 'public');
  if (existsSync(publicSrc)) cpSync(publicSrc, join(server, 'public'), { recursive: true });
  return join(server, 'server.js');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const entry = prepareStandalone(webDir);
  const child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
