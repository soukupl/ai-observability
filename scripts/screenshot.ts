/**
 * Dev tool: full-page screenshots of every dashboard/admin route, light+dark x desktop+phone, using
 * headless Chrome over the DevTools protocol (no dependencies; Node 22 global WebSocket/fetch).
 *
 *   SESSION_COOKIE=<ai_obs_session value> TURN_ID=<uuid> pnpm tsx scripts/screenshot.ts [outDir]
 *
 * Env: BASE_URL (default http://localhost:3100), CHROME (path to Chrome), CDP_PORT (default 9333),
 * ROUTES (comma list to override). Also prints horizontal overflow (scrollWidth > viewport) and
 * console errors/hydration warnings per page. The session cookie comes from a magic-link login (README).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const COOKIE = process.env.SESSION_COOKIE ?? '';
const OUT = process.argv[2] ?? 'shots';
const turn = process.env.TURN_ID;
const ROUTES = (process.env.ROUTES?.split(',') ??
  ['/overview', '/projects', '/models', '/phases', '/agents', '/turns', ...(turn ? [`/turns/${turn}`] : []), '/tokens',
   '/admin', '/admin/teams', '/admin/tokens', '/admin/settings', '/admin/budgets', '/login']);
const SIZES = { desktop: [1440, 900], phone: [360, 800] } as const;

mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1440,900', '--no-first-run',
  '--user-data-dir=' + join(OUT, '.chrome-profile'), 'about:blank'], { stdio: 'ignore' });

async function wsUrl(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const p = t.find((x) => x.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {}
    await sleep(200);
  }
  throw new Error('chrome did not start');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map<number, (v: any) => void>(); const logs: string[] = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) pending.get(m.id)!(m.result ?? m.error);
  else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
    logs.push(`${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description).join(' ').slice(0, 300)}`);
  else if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
});
const send = (method: string, params: object = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
if (COOKIE) await send('Network.setCookie', { name: 'ai_obs_session', value: COOKIE, url: BASE });

const report: string[] = [];
for (const [size, [w, h]] of Object.entries(SIZES)) for (const theme of ['light', 'dark']) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: size === 'phone' });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  for (const route of ROUTES) {
    logs.length = 0;
    await send('Page.navigate', { url: BASE + route });
    await sleep(1800);
    await ev(`localStorage.setItem('theme','${theme}'); document.documentElement.classList.toggle('dark', ${theme === 'dark'})`);
    await sleep(300);
    const m = await ev(`JSON.stringify({sw: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, path: location.pathname})`);
    const { sw, h: ph, path } = JSON.parse(m);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: w, height: Math.min(ph, 6000), scale: 1 } });
    const name = `${(route.slice(1) || 'root').replace(/\//g, '_')}-${theme}-${size}.png`;
    writeFileSync(join(OUT, name), Buffer.from(shot.data, 'base64'));
    report.push(`${name} path=${path} scrollWidth=${sw}${sw > w ? ' OVERFLOW' : ''} height=${ph}${logs.length ? ' LOGS=' + JSON.stringify(logs) : ''}`);
  }
}
console.log(report.join('\n'));
ws.close(); chrome.kill();
