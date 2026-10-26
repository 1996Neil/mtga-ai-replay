import { join } from 'node:path';
import { importReplayLogs } from './replay-workflow.mjs';
import { archiveReplays, listReplays, getReplay, isReplayExcluded, acknowledgeReplayOutbox, defaultDataDir } from './history.mjs';
import { syncCoachCatalog } from './coach-catalog-sync.mjs';
import { readCoachSyncState } from './coach-sync.mjs';

const active = new Map();
/** The outbox is a durable transmission queue, separate from Viewer's archive. */
export function syncGitFirstReplays(options = {}) {
  const dataDir = options.dataDir ?? defaultDataDir();
  if (active.has(dataDir)) return active.get(dataDir);
  const promise = run({ ...options, dataDir }).finally(() => active.delete(dataDir));
  active.set(dataDir, promise);
  return promise;
}
async function run({ dataDir, onProgress, importWorkflow = importReplayLogs,
  publishWorkflow = syncCoachCatalog, ...options }) {
  const started = performance.now();
  onProgress?.({ phase: 'scanning' });
  const imported = await importWorkflow({ ...options, dataDir, all: true, gitFirst: true });
  const archiveDataDir = join(dataDir, 'replay-outbox');
  const staged = await listReplays({ dataDir: archiveDataDir, limit: null });
  const stagedReplays = new Map();
  for (const entry of staged) {
    if (await isReplayExcluded(entry.id, { dataDir })) continue;
    const replay = await getReplay(entry.id, { dataDir: archiveDataDir });
    if (replay?.match.account_key) stagedReplays.set(entry.id, replay);
  }
  if (!publishWorkflow || publishWorkflow === syncCoachCatalog) {
    const state = await readCoachSyncState(dataDir);
    const local = await listReplays({ dataDir, limit: null });
    if (state.enabled && !state.pending.length && !stagedReplays.size && local.every(match => state.synced[match.id])) {
      return { ...imported, status: 'succeeded', new_matches: 0, local_matches: local.length,
        published: 0, updated: 0, failed: 0, skipped: 0, github_matches: Object.keys(state.synced).length,
        failures: [], error: null, source: 'local-outbox', remote_checked: false,
        elapsed_ms: Math.round(performance.now() - started) };
    }
  }
  const result = await publishWorkflow({ ...options, dataDir, archiveDataDir,
    stagedReplays, fastSync: true, cardDb: imported.database, onProgress });
  const promoted = [];
  if (!result.sync_error && result.index_source === 'remote') {
    for (const confirmed of result.confirmed ?? []) {
      const replay = stagedReplays.get(confirmed.match_id);
      if (!replay || !confirmed.content_hash || !confirmed.history_key ||
          await isReplayExcluded(replay.match.id, { dataDir })) continue;
      const archived = await archiveReplays([replay], { dataDir });
      if (archived.archived) promoted.push(replay);
      else {
        const visible = await getReplay(replay.match.id, { dataDir });
        const { coachNotes: a, ...left } = visible ?? {};
        const { coachNotes: b, ...right } = replay;
        if (visible && JSON.stringify(left) === JSON.stringify(right)) promoted.push(replay);
        else result.failed.push({ match_id: replay.match.id, reason: 'Git 已保存；本地版本存在冲突，待发送记录已保留。' });
      }
    }
    await acknowledgeReplayOutbox(promoted, { dataDir: archiveDataDir });
  }
  const local = await listReplays({ dataDir, limit: null });
  return { ...imported, archive: { ...imported.archive, archived: promoted.length },
    status: result.sync_error || result.failed.length ? 'failed' : 'succeeded',
    new_matches: promoted.length, local_matches: local.length, published: result.published,
    updated: result.updated, failed: result.failed.length, skipped: result.skipped.length,
    github_matches: result.github_total, latest: result.latest, failures: result.failed,
    error: result.sync_error ?? null, elapsed_ms: Math.round(performance.now() - started) };
}
