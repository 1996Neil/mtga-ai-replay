import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverLogs } from './discovery.mjs';
import { replayWorker } from './replay-worker.mjs';
import { createHash } from 'node:crypto';
const syncDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function identity(path, emptyWal = false) {
  try {
    const info = await stat(path, { bigint: true });
    if (emptyWal && info.size === 0n) return 'no-wal-frames';
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
  } catch (error) {
    if (error.code === 'ENOENT') return emptyWal ? 'no-wal-frames' : 'missing';
    throw error;
  }
}

/** Cheap discovery gate only. Every actual import still uses the existing full
 * content/rules/archive fingerprints before reusing parsed data. */
export async function localReplaySignature({ dataDir, logPath, logDir, cardDb } = {}) {
  const paths = await discoverLogs({ logPath, logDir });
  // Poll only log/settings metadata. Discovering the card DB performs SQL joins.
  const files = [...paths, ...(cardDb ? [cardDb, cardDb + '-wal'] : []), join(dataDir, 'replay-settings.json')].sort();
  const input = syncDigest(await Promise.all(files.map(async path => [path, await identity(path, path.endsWith('-wal'))])));
  return { input, archive: 'independent-of-archive' };
}

/** Local import has no publisher, authentication or model/TTS entry point.
 * Coalesce changes while a log is being written; one import at a time. */
export function createLocalReplayHistory({ dataDir, logPath, logDir, cardDb,
  pollIntervalMs = 2000, settleMs = 2000, maxWaitMs = 30000, minImportIntervalMs = 30000,
  probe = localReplaySignature, workflow = options => replayWorker('ingest', options), now = Date.now } = {}) {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 ||
      !Number.isSafeInteger(settleMs) || settleMs < 0 ||
      !Number.isSafeInteger(maxWaitMs) || maxWaitMs < settleMs ||
      !Number.isSafeInteger(minImportIntervalMs) || minImportIntervalMs < 0) throw new Error('Invalid local history polling budget.');
  const options = { dataDir, logPath, logDir, cardDb, all: true };
  let timer = null, active = null, closed = false, applied = null, pending = null, nextImportAt = 0;
  let status = { status: 'idle', imports: 0, last_success_at: null, error: null };
  const snapshot = () => ({ ...status });
  async function checkOnce(immediate) {
    if (closed) return snapshot();
    try {
      const observed = await probe(options);
      if (!immediate && now() < nextImportAt) return snapshot();
      if (applied && observed.input === applied.input && observed.archive === applied.archive) {
        pending = null;
        return snapshot();
      }
      const key = syncDigest(observed), at = now();
      if (!pending) pending = { key, first: at, changed: at };
      else if (pending.key !== key) pending = { ...pending, key, changed: at };
      // Quiet gaps between player actions must not trigger a full history parse
      // every few seconds. A successful import defers the next automatic import by at least 30s.
      if (applied && !immediate && at < nextImportAt) return snapshot();
      if (applied && !immediate && at - pending.changed < settleMs && at - pending.first < maxWaitMs) return snapshot();
      status = { ...status, status: 'running', error: null };
      const imported = await workflow(options);
      const after = await probe(options);
      // Archive writes are ours; inputs appended during parsing remain dirty.
      applied = { input: observed.input, archive: after.archive };
      pending = null; nextImportAt = now() + minImportIntervalMs;
      status = { status: 'succeeded', imports: status.imports + 1,
        last_success_at: new Date(now()).toISOString(), error: null,
        cached: Boolean(imported.cached), archived: imported.archive?.archived ?? 0,
        preserved_conflicts: imported.archive?.conflicts ?? 0 };
    } catch {
      nextImportAt = now() + minImportIntervalMs;
      // Paths and raw log/parser errors never enter the browser status API.
      status = { ...status, status: 'failed', error: '本地回放更新暂时失败；会自动重试。' };
    }
    return snapshot();
  }
  function check({ immediate = false } = {}) {
    if (!active) active = checkOnce(immediate).finally(() => { active = null; });
    return active;
  }
  return { snapshot, check,
    start() {
      if (timer || closed) return;
      void check({ immediate: true });
      timer = setInterval(() => { void check(); }, pollIntervalMs);
      timer.unref?.();
    },
    async close() { closed = true; clearInterval(timer); timer = null; await active; },
  };
}
