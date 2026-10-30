import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { archiveReplays, listReplays, getReplay, acknowledgeReplayOutbox, defaultDataDir } from './history.mjs';
import { readCoachSyncState, atomicSyncWrite } from './coach-sync.mjs';
import { syncCoachCatalog } from './coach-catalog-sync.mjs';
import { readReplaySettings, replayInRetention, withReplayOperation } from './replay-settings.mjs';
import { replayWorker } from './replay-worker.mjs';
import { replaySyncSnapshot } from './replay-sync-snapshot.mjs';

const active = new Map();
/** Synchronize the archive, independent of raw-log discovery and parsing. */
export function syncReplays(options = {}) {
  const dataDir = options.dataDir ?? defaultDataDir();
  if (active.has(dataDir)) return active.get(dataDir);
  const work = withReplayOperation(dataDir, () => run({ ...options, dataDir }), { exclusive: false }).finally(() => active.delete(dataDir));
  active.set(dataDir, work); return work;
}
async function run({ dataDir, onProgress, publisher = syncCoachCatalog, remoteImport = replayWorker, ...options }) {
  const started = performance.now(), settings = await readReplaySettings(dataDir);
  // One-time migration: queued replays become locally visible even when offline.
  const outbox = join(dataDir, 'replay-outbox');
  for (const match of await listReplays({ dataDir: outbox, limit: null })) {
    if (!replayInRetention(match, settings)) continue;
    const replay = await getReplay(match.id, { dataDir: outbox });
    const result = await archiveReplays([replay], { dataDir });
    if (!result.conflicts) await acknowledgeReplayOutbox([replay], { dataDir: outbox });
  }
  let receipts = {};
  const receiptPath = join(dataDir, 'replay-sync-revisions.json');
  try { receipts = JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = await readCoachSyncState(dataDir);
  const local = (await listReplays({ dataDir, limit: null })).filter(match => replayInRetention(match, settings));
  // Bootstrap existing published history without regenerating old files.
  for (const match of local) if (!receipts[match.id] && state.synced[match.id]) receipts[match.id] = match.replay_revision;
  await atomicSyncWrite(receiptPath, JSON.stringify(receipts));
  const refreshMatchIds = local.filter(match => receipts[match.id] && receipts[match.id] !== match.replay_revision).map(match => match.id);
  const baselines = Object.fromEntries(local.filter(match => state.synced[match.id]).map(match => [match.id, {
    content_hash: state.synced[match.id].content_hash, local_revision: receipts[match.id],
  }]));
  const remoteReceiptsPath = join(dataDir, 'replay-remote-receipts.json');
  let savedBaselines = {};
  try { savedBaselines = JSON.parse(await readFile(remoteReceiptsPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomicSyncWrite(remoteReceiptsPath, JSON.stringify({ ...baselines, ...savedBaselines }));
  onProgress?.({ phase: 'comparing' });
  // Compare both sides BEFORE uploading, so a local change cannot overwrite an
  // independent remote change. The publisher rechecks the hash before writes.
  const snapshot = await replaySyncSnapshot({ ...options, state, dataDir, onProgress });
  onProgress?.({ phase: 'downloading' });
  const imported = await remoteImport('remote', { dataDir, snapshot, baselines });
  const downloaded = imported.downloaded, failures = [...imported.conflicts];
  Object.assign(receipts, imported.remote_revisions ?? {});
  await atomicSyncWrite(receiptPath, JSON.stringify(receipts));
  const publishedIds = new Set(snapshot.index.matches.map(entry => entry.match_id));
  const needsUpload = state.pending.length || refreshMatchIds.some(id => !imported.remote_revisions?.[id]) ||
    local.some(match => !publishedIds.has(match.id));
  const result = failures.length
    ? { published: 0, updated: 0, failed: [], skipped: [], github_total: snapshot.index.matches.length,
      sync_error: '本地和线上有冲突，已保留双方版本；请先核对冲突记录。' }
    : !needsUpload ? { published: 0, updated: 0, failed: [], skipped: [], github_total: snapshot.index.matches.length, snapshot }
    : await publisher({ ...options, dataDir, fastSync: true, publishedSnapshot: snapshot,
      expectedRemoteContentHashes: Object.fromEntries(snapshot.index.matches.map(entry => [entry.match_id, entry.content_hash])),
      refreshMatchIds: refreshMatchIds.filter(id => !imported.remote_revisions?.[id]), onProgress });
  failures.push(...result.failed);
  if (!result.sync_error) {
    for (const match of local) if (!imported.remote_revisions?.[match.id] && !failures.some(failure => failure.match_id === match.id))
      receipts[match.id] = match.replay_revision;
    await atomicSyncWrite(receiptPath, JSON.stringify(receipts));
    // Save upload baselines even when no subsequent download is required.
    const final = new Map((result.snapshot?.index ?? snapshot.index).matches.map(entry => [entry.match_id, entry]));
    await atomicSyncWrite(join(dataDir, 'replay-remote-receipts.json'), JSON.stringify(Object.fromEntries(
      Object.entries(receipts).filter(([id]) => final.has(id)).map(([id, revision]) =>
        [id, { local_revision: revision, content_hash: final.get(id).content_hash }]))));
  }
  const count = (await listReplays({ dataDir, limit: null })).length;
  return { status: result.sync_error || failures.length ? (result.published || downloaded ? 'partial' : 'failed') : 'succeeded',
    new_matches: downloaded, local_matches: count, published: result.published, downloaded, updated: result.updated,
    failed: failures.length, skipped: result.skipped.length, github_matches: result.github_total,
    latest: result.latest, failures, error: result.sync_error ?? null, remote_checked: !result.sync_error,
    elapsed_ms: Math.round(performance.now() - started) };
}
