import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverLogs } from './discovery.mjs';
import { discoverCardDatabase } from './cards.mjs';
import { importReplayLogs } from './replay-workflow.mjs';
import { syncDigest } from './sync-cache.mjs';

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
  const database = await discoverCardDatabase({ cardDb });
  const files = [...paths, ...(database ? [database, database + '-wal'] : [])].sort();
  const input = syncDigest(await Promise.all(files.map(async path => [path, await identity(path, path.endsWith('-wal'))])));
  const archive = syncDigest(await Promise.all(['replays.sqlite3', 'replays.sqlite3-wal'].map(async name =>
    [name, await identity(join(dataDir, name), name.endsWith('-wal'))])));
  return { input, archive };
}

/** Local import has no publisher, authentication or model/TTS entry point.
 * Coalesce changes while a log is being written; one import at a time. */
export function createLocalReplayHistory({ dataDir, logPath, logDir, cardDb,
  pollIntervalMs = 2000, settleMs = 2000, maxWaitMs = 30000, minImportIntervalMs = 30000,
  probe = localReplaySignature, workflow = importReplayLogs, now = Date.now } = {}) {
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
        cached: Boolean(imported.cached), archived: imported.archive?.archived ?? 0 };
    } catch {
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
