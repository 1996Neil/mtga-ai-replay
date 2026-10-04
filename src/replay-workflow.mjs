import { discoverLogs } from './discovery.mjs';
import { discoverCardDatabase, loadCardNames, loadCounterNames } from './cards.mjs';
import { readRecords } from './log-reader.mjs';
import { buildReplays } from './replay.mjs';
import { archiveReplays, defaultDataDir, listReplays, getLatestReplay } from './history.mjs';
import { syncCoachCatalog } from './coach-catalog-sync.mjs';
import { getCoachSyncStatus, syncErrorMessage } from './coach-sync.mjs';

/** Shared with CLI: re-discover current/rotated logs on every invocation. */
export async function importReplayLogs({ dataDir = defaultDataDir(), logPath, logDir, cardDb, all = false } = {}) {
  const paths = await discoverLogs({ logPath, logDir });
  const { records, detailed } = await readRecords(paths);
  const database = await discoverCardDatabase({ cardDb });
  const names = await loadCardNames(database), counterNames = await loadCounterNames(database);
  const { replays } = records.length ? await buildReplays(records, names, { counterNames }) : { replays: [] };
  const importable = replays.filter(r => (all || r.match.is_jump_in) && r.games.some(g => g.steps?.length));
  if (!database) for (const replay of importable) replay.warnings.push('No local card database found; names use Arena IDs.');
  const archive = importable.length ? await archiveReplays(importable, { dataDir }) : { archived: 0, preserved: 0 };
  return { paths, detailed, hasGameRecords: records.some(r => r.greToClientEvent), database, archive };
}

/** Fixed Viewer action: import + the exact CLI canonical publisher, without
 * changing the user's current replay, opening another tab or parsing stdout. */
export async function syncReplayHistory({ dataDir = defaultDataDir(), onProgress, ...options } = {}) {
  const before = new Set((await listReplays({ dataDir, limit: null })).map(match => match.id));
  onProgress?.({ phase: 'scanning' });
  const imported = await importReplayLogs({ ...options, dataDir });
  const catalog = await listReplays({ dataDir, limit: null });
  const added = catalog.filter(match => !before.has(match.id)).length;
  const latest = await getLatestReplay({ dataDir });
  const status = await getCoachSyncStatus({ dataDir, verify: false });
  if (!status.enabled) return { status: 'failed', error: 'GitHub Coach 同步尚未配置。请先运行 mtga-gpt-replay sync --repo owner/name。',
    new_matches: added, local_matches: catalog.length, already_published: 0, missing: null, published: 0, failed: 0, skipped: 0, github_matches: null, latest: null, failures: [] };
  onProgress?.({ phase: 'comparing' });
  let total = 0;
  const result = await syncCoachCatalog({ ...options, dataDir, cardDb: imported.database, refreshMatchIds: latest ? [latest.match.id] : [],
    onScan: report => { total = report.missing; onProgress?.({ phase: 'generating', completed: 0, total }); },
    onQueued: value => onProgress?.({ phase: 'generating', completed: value.completed, total: value.total }),
    onPublishing: () => onProgress?.({ phase: 'publishing', completed: total, total }),
  });
  const partial = result.failed.length > 0 && (result.published > 0 || result.github_total !== null);
  return { status: result.sync_error ? 'failed' : partial ? 'partial' : result.failed.length ? 'failed' : 'succeeded',
    new_matches: added, local_matches: result.local, already_published: result.already_published,
    missing: result.missing, published: result.published, failed: result.failed.length, skipped: result.skipped.length,
    github_matches: result.github_total, latest: result.latest, updated: result.updated,
    error: result.sync_error ?? (result.failed.length ? '部分回放未完成同步，请查看详情。' : null),
    failures: result.failed, index_source: result.index_source };
}

export function replaySyncError(error) {
  return syncErrorMessage(error);
}
