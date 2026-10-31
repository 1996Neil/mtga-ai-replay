import { DatabaseSync } from 'node:sqlite';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readReplaySettings, replayInRetention } from './replay-settings.mjs';
import { defaultDataDir } from './history.mjs';
import { withCoachSyncLock, readCoachSyncState, atomicSyncWrite } from './coach-sync.mjs';
const execute = promisify(execFile);
async function realDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Invalid replay storage directory');
}
async function diskBytes(dataDir) {
  const { stdout } = await execute('du', ['-sk', dataDir], { timeout: 30000 });
  return Number(stdout.trim().split(/\s/)[0]) * 1024;
}
async function sparseTransport(dataDir, state, settings, now) {
  const cwd = join(dataDir, 'coach-sync/repository');
  try { const info = await lstat(join(cwd, '.git')); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Invalid transport checkout'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const git = async (args, input) => {
    if (!input) return (await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd })).stdout;
    await new Promise((resolve, reject) => {
      const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd }, error => error ? reject(error) : resolve());
      child.stdin.on('error', reject); child.stdin.end(input);
    });
  };
  if (String(await git(['status', '--porcelain'])).trim()) throw Error('Transport checkout has unsaved changes');
  if (settings.retention_days === null) {
    const sparse = String(await git(['config', '--get', '--default', 'false', 'core.sparseCheckout'])).trim();
    if (sparse === 'true') await git(['sparse-checkout', 'disable']);
    return;
  }
  const recent = [...Object.entries(state.synced).map(([match_id, value]) => ({ ...value, match_id })), ...state.pending]
    .filter(item => replayInRetention(item, settings, now));
  const patterns = ['/*', '!/matches/*/', '!/reviews/*/'];
  for (const item of recent) {
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.history_key)) patterns.push(`/matches/${item.history_key}/`);
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.match_id)) patterns.push(`/reviews/${item.match_id}/`);
  }
  if (!recent.length) patterns.push('!/latest/');
  await git(['sparse-checkout', 'set', '--no-cone', '--stdin'], [...new Set(patterns)].join('\n') + '\n');
}

async function db(path, callback) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Invalid replay database');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout=5000');
  try { return callback(database); } finally { database.close(); }
}
export async function retentionPreview({ dataDir = defaultDataDir(), settings, now = Date.now() } = {}) {
  settings ??= await readReplaySettings(dataDir);
  const cutoff = settings.retention_days === null ? null : new Date(now - settings.retention_days * 86400000).toISOString();
  let matches = 0, bytes = 0;
  for (const directory of [dataDir, join(dataDir, 'replay-outbox')]) {
    const value = await db(join(directory, 'replays.sqlite3'), database =>
      database.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(replay_json AS BLOB))),0) AS bytes
        FROM replays WHERE julianday(started_at)<julianday(?)`).get(cutoff));
    matches += value?.count ?? 0; bytes += value?.bytes ?? 0;
  }
  return { settings, expired_records: matches, estimated_replay_bytes: bytes, cutoff };
}
export async function cleanReplayRetention({ dataDir = defaultDataDir(), now = Date.now() } = {}) {
  await realDirectory(dataDir);
  try { await realDirectory(join(dataDir, 'replay-outbox')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const before = await diskBytes(dataDir);
  const settings = await readReplaySettings(dataDir), preview = await retentionPreview({ dataDir, settings, now });
  const expired = new Set(); let deleted = 0, bundles = 0;
  for (const directory of [dataDir, join(dataDir, 'replay-outbox')]) {
    await db(join(directory, 'replays.sqlite3'), database => {
      const ids = database.prepare('SELECT match_id FROM replays WHERE julianday(started_at)<julianday(?)').all(preview.cutoff);
      for (const row of ids) expired.add(row.match_id);
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`DELETE FROM coach_notes WHERE match_id IN
          (SELECT match_id FROM replays WHERE julianday(started_at)<julianday(?))`).run(preview.cutoff);
        deleted += Number(database.prepare('DELETE FROM replays WHERE julianday(started_at)<julianday(?)').run(preview.cutoff).changes);
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      // DELETE alone keeps free pages allocated. Reclaim only after a deletion.
      if (database.prepare('PRAGMA freelist_count').get().freelist_count > 0) database.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    });
  }
  await withCoachSyncLock(dataDir, async () => {
    const state = await readCoachSyncState(dataDir);
    state.pending = state.pending.filter(item => replayInRetention(item, settings, now));
    await atomicSyncWrite(join(dataDir, 'coach-sync/state.json'), JSON.stringify(state));
    await sparseTransport(dataDir, state, settings, now);
    const keep = new Set(state.pending.map(item => `${item.history_key}/${item.content_hash}`));
    const root = join(dataDir, 'coach-sync/bundles');
    let keys;
    try {
      await realDirectory(join(dataDir, 'coach-sync'));
      await realDirectory(root);
      keys = await readdir(root, { withFileTypes: true });
    }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const key of keys) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(key.name) || !key.isDirectory() || key.isSymbolicLink()) continue;
      for (const hash of await readdir(join(root, key.name), { withFileTypes: true })) {
        if (!/^[a-f0-9]{64}$/.test(hash.name) || !hash.isDirectory() || hash.isSymbolicLink() || keep.has(`${key.name}/${hash.name}`)) continue;
        // Generated, no-longer-pending transport copies only. Never the Git checkout.
        await rm(join(root, key.name, hash.name), { recursive: true }); bundles++;
      }
    }
  });
  await db(join(dataDir, 'replay-ingest.sqlite3'), database => {
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='matches'").get()) {
      for (const row of database.prepare('SELECT * FROM matches').all()) if (!replayInRetention(row, settings, now)) expired.add(row.match_id);
    }
    for (const id of expired) {
      database.prepare('DELETE FROM records WHERE match_id=?').run(id);
      database.prepare('DELETE FROM dirty WHERE match_id=?').run(id);
    }
    if (database.prepare('PRAGMA freelist_count').get().freelist_count > 0)
      database.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  });
  await db(join(dataDir, 'reviews.sqlite3'), database => {
    for (const table of ['cloud_review_cache', 'cloud_review_observations']) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const id of expired) database.prepare(`DELETE FROM ${table} WHERE match_id=?`).run(id);
    }
    if (expired.size) database.exec('VACUUM');
  });
  const result = { ...preview, deleted_records: deleted, removed_bundle_copies: bundles,
    freed_bytes: Math.max(0, before - await diskBytes(dataDir)) };
  await atomicSyncWrite(join(dataDir, 'replay-retention-receipt.json'), JSON.stringify({ checked_at: now, ...result }));
  return result;
}
