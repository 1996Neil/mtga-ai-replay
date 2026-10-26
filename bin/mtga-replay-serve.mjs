#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startReplayServer } from '../src/server.mjs';

// Replay has no live runtime, voice grants, standby controller or model switch.
const { values } = parseArgs({ options: {
  port: { type: 'string', default: '57016' }, 'data-dir': { type: 'string' },
  'viewer-dir': { type: 'string' },
} });
const port = Number(values.port);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid replay port.');
const runtime = await startReplayServer({ port, dataDir: values['data-dir'], viewerDir: values['viewer-dir'],
  observeLocalLogs: true, autoSyncReplays: true });
console.log(`Replay 2.0 ${runtime.url}`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await runtime.close(); process.exit(0); });
