#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from '../src/history.mjs';
import { draftLogRevision } from '../src/draft-capture.mjs';
import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
const run = promisify(execFile);
const { values } = parseArgs({ options: {
  sync: { type: 'boolean', default: false },
  'from-start': { type: 'boolean', default: false },
  watch: { type: 'boolean', default: false }, 'data-dir': { type: 'string' },
  'log-dir': { type: 'string' }, python: { type: 'string', default: 'python3' },
  rebuild: { type: 'boolean', default: false },
} });
const script = fileURLToPath(new URL('../tools/draft-capture/capture.py', import.meta.url));
const dataDir = values['data-dir'] ?? defaultDataDir(), logDir = values['log-dir'];
if (values.rebuild) {
  const temporary = await mkdtemp(join(dataDir, '.draft-rebuild-'));
  const target = join(dataDir, 'draft-capture.sqlite3');
  const backup = `${target}.before-rebuild-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
  try {
    const result = JSON.parse((await run(values.python, [script, '--from-start', '--data-dir', temporary,
      ...(logDir ? ['--log-dir', logDir] : [])], { timeout: 120000, maxBuffer: 8192 })).stdout);
    await stat(join(temporary, 'draft-capture.sqlite3'));
    try { await rename(target, backup); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(join(temporary, 'draft-capture.sqlite3'), target);
    console.log(JSON.stringify({ ...result, rebuilt: true, backup }, null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
  process.exit(0);
}
const args = [script, ...(values['from-start'] ? ['--from-start'] : []), '--data-dir', dataDir,
  ...(logDir ? ['--log-dir', logDir] : [])];
let closed = false, lastSyncAttempt = 0, lastSyncedCount = null, lastSyncedGaps = null, lastSyncedInput = null, syncActive = null;
let lastLogRevision, lastCapture;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { closed = true; });
do {
  try {
    const logRevision = await draftLogRevision(values['log-dir']);
    let result;
    if (lastCapture && logRevision === lastLogRevision) result = { ...lastCapture, added: 0 };
    else {
      result = JSON.parse((await run(values.python, args, { timeout: 30000, maxBuffer: 8192 })).stdout);
      lastCapture = result; lastLogRevision = logRevision;
    }
    if (!values.watch || result.added) console.log(JSON.stringify(result));
    const { draftBindingInputKey } = await import('../src/draft-publication.mjs');
    const inputKey = values.sync ? await draftBindingInputKey(values['data-dir'] ?? defaultDataDir()) : null;
    if (values.sync && !syncActive && (result.observations !== lastSyncedCount || result.gaps !== lastSyncedGaps || inputKey !== lastSyncedInput) && Date.now() - lastSyncAttempt >= 60000) {
      lastSyncAttempt = Date.now();
      syncActive = (async () => { try {
        const { syncDraftCapture } = await import('../src/draft-sync.mjs');
        const receipt = await syncDraftCapture({ dataDir: values['data-dir'] ?? defaultDataDir(), automatic: true });
        if (receipt.verified) {
          lastSyncedCount = result.observations; lastSyncedGaps = result.gaps; lastSyncedInput = receipt.input_key;
          console.log(JSON.stringify({ backup: 'verified', observations: receipt.observations, linked_runs: receipt.linked_runs,
            pending_runs: receipt.pending_runs, revision: receipt.revision }));
        }
      } catch { console.error('Git 轮抽备份暂未完成；本地记录继续保留，将自动重试。'); }
      })().finally(() => { syncActive = null; });
    }
  } catch {
    console.error('轮抽本地同步失败；已保存记录保留，下次重试。');
    if (!values.watch) { process.exitCode = 1; break; }
  }
  if (values.watch && !closed) await new Promise(done => setTimeout(done, 2000));
} while (values.watch && !closed);

await syncActive;
