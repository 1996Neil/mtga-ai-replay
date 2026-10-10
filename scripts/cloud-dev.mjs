import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { archiveReplays } from '../src/history.mjs';
import { buildReplays } from '../src/replay.mjs';
import { startReplayServer } from '../src/server.mjs';
import { syntheticMatchRecords } from '../tests/helpers/synthetic-log.mjs';

/** Disposable synthetic API workspace. Never invokes discovery, credentials,
 * collection memory reader, publisher, model provider or speech provider. */
export async function startCloudReplay({ port = 8787 } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback port.');
  const directory = await mkdtemp(join(tmpdir(), 'mtga-cloud-source-'));
  const dataDir = join(directory, 'data'), viewerDir = join(directory, 'viewer');
  try {
    const { replays } = await buildReplays(syntheticMatchRecords('synthetic-cloud-match'));
    await archiveReplays(replays, { dataDir });
    await mkdir(viewerDir);
    await writeFile(join(viewerDir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>MTGA source API</title><h1>MTGA synthetic development API</h1><p>Disposable synthetic replay. Restricted Viewer source is excluded.</p><a href="/api/health">Health</a> <a href="/api/matches">Matches</a>');
    const running = await startReplayServer({ dataDir, viewerDir, port, writeInfo: false, displayNamesZh: new Map(),
      fetchFn: async () => { throw new Error('External card requests are disabled in cloud development.'); }, enableReplaySync: false, enableCollection: false, observeLocalLogs: false });
    let closed = false;
    return { ...running, directory, dataDir, close: async () => { if (closed) return; closed = true; try { await running.close(); } finally { await rm(directory, { recursive: true, force: true }); } } };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8787' }, help: { type: 'boolean' } } });
  if (values.help) console.log('npm start -- --port 8787: synthetic disposable loopback API; no private data, credentials, model/TTS or publishing.');
  else { const running = await startCloudReplay({ port: Number(values.port) }); console.log(`Synthetic API: ${running.url}`); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await running.close(); process.exit(0); }); }
}
