/** Entry of the detached worker process: `node dist/worker-main.js` (spawned by hook.ts). */
import { aiObsPaths } from './paths.js';
import { SUMMARIZING_ENV } from './protocol-types.js';
import { runWorker } from './worker.js';

if (!process.env[SUMMARIZING_ENV]) {
  try {
    await runWorker({ paths: aiObsPaths() });
  } catch {
    /* runWorker logs; never crash loudly */
  }
}
process.exit(0);
