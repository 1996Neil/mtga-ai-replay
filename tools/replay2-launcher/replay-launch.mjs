import { fileURLToPath } from 'node:url';
import { createReplayLauncher } from './replay-launcher.mjs';
const action = process.argv[2] ?? 'start';
if (!['start', 'stop', 'status'].includes(action)) throw new Error('Expected start, stop or status.');
const launcher = createReplayLauncher({ projectRoot: fileURLToPath(new URL('../../', import.meta.url)) });
try { console.log(JSON.stringify(await launcher[action](), null, 2)); }
catch (error) { console.error(`Replay 2.0：${error.message}`); process.exitCode = 1; }
