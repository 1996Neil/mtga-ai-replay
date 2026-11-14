import { discoverLogs } from './discovery.mjs';
import { discoverCardDatabase, loadCardNames, loadCardLandColors, loadCounterNames } from './cards.mjs';
import { readRecords } from './log-reader.mjs';
import { buildReplays } from './replay.mjs';
import { buildDraftRunIndex, saveDraftRunIndex } from './draft-runs.mjs';
import { buildDraftPickIndex } from './draft-picks.mjs';
import { archiveReplays, defaultDataDir, listReplays, getLatestReplay } from './history.mjs';
import { syncCoachCatalog } from './coach-catalog-sync.mjs';
import { getCoachSyncStatus, syncErrorMessage } from './coach-sync.mjs';
import { importInputFingerprint, archiveFingerprint, readSyncCache, writeSyncCache } from './sync-cache.mjs';
import { createSyncProgress } from './sync-progress.mjs';

/** Shared with CLI: re-discover current/rotated logs on every invocation. */
export async function importReplayLogs({ dataDir = defaultDataDir(), logPath, logDir, cardDb, all = true } = {}) {
  const paths = await discoverLogs({ logPath, logDir });
  const database = await discoverCardDatabase({ cardDb });
  const input = await importInputFingerprint(paths, database, all);
  const cached = await readSyncCache(dataDir, 'replay-import-cache.json');
  if (input && cached?.input === input && typeof cached.detailed === 'boolean' && typeof cached.hasGameRecords === 'boolean' &&
      cached.archive === await archiveFingerprint(dataDir)) {
    return { paths, database, detailed: cached.detailed, hasGameRecords: cached.hasGameRecords, archive: { archived: 0, preserved: 0 }, cached: true };
  }
  const { records, detailed } = await readRecords(paths);
  const names = await loadCardNames(database), counterNames = await loadCounterNames(database);
  const { replays } = records.length ? await buildReplays(records, names, { counterNames }) : { replays: [] };
  const importable = replays.filter(r => (all || r.match.is_jump_in) && r.games.some(g => g.steps?.length));
  if (!database) for (const replay of importable) replay.warnings.push('No local card database found; names use Arena IDs.');
  const archive = importable.length ? await archiveReplays(importable, { dataDir }) : { archived: 0, preserved: 0 };
  let draftRunIndex = null;
  if (records.length) {
    const history = await listReplays({ dataDir, limit: null });
    const draftRuns = buildDraftRunIndex(records, history, { cardNames: names, cardLandColors: await loadCardLandColors(database) });
    const draftPicks = buildDraftPickIndex(records, { cardNames: names });
    draftRunIndex = await saveDraftRunIndex(draftRuns, { dataDir, picks: draftPicks });
  }
  const hasGameRecords = records.some(r => r.greToClientEvent);
  if (input && input === await importInputFingerprint(paths, database, all)) {
    const fingerprint = await archiveFingerprint(dataDir);
    if (fingerprint) await writeSyncCache(dataDir, 'replay-import-cache.json', { input, archive: fingerprint, detailed, hasGameRecords });
  }
  return { paths, detailed, hasGameRecords, database, archive, draftRunIndex, cached: false };
}

/** Explicit Viewer upload: publish the current archive through the exact CLI
 * canonical publisher. Local log discovery/import runs independently. */
export async function syncReplayHistory({ dataDir = defaultDataDir(), onProgress, ...options } = {}) {
  const progress = createSyncProgress(onProgress), emit = value => progress.emit(value);
  emit({ phase: 'scanning' });
  const catalog = await listReplays({ dataDir, limit: null });
  const latest = await getLatestReplay({ dataDir });
  const status = await getCoachSyncStatus({ dataDir, verify: false });
  if (!status.enabled) return { status: 'failed', error: 'GitHub Coach 同步尚未配置。请先运行 mtga-gpt-replay sync --repo owner/name。',
    new_matches: 0, local_matches: catalog.length, already_published: 0, missing: null, published: 0, failed: 0, skipped: 0, github_matches: null, latest: null, failures: [] };
  emit({ phase: 'comparing' });
  let total = 0;
  const result = await syncCoachCatalog({ ...options, dataDir, refreshMatchIds: latest ? [latest.match.id] : [],
    onProgress: emit,
    onScan: report => { total = report.candidates; emit({ phase: 'generating', completed: 0, total }); },
    onQueued: value => emit({ phase: 'generating', completed: value.completed, total: value.total }),
    onPublishing: () => emit({ phase: 'publishing', completed: total, total }),
  });
  const partial = result.failed.length > 0 && (result.published > 0 || result.github_total !== null);
  return { status: result.sync_error ? 'failed' : partial ? 'partial' : result.failed.length ? 'failed' : 'succeeded',
    new_matches: 0, local_matches: result.local, already_published: result.already_published,
    missing: result.missing, published: result.published, failed: result.failed.length, skipped: result.skipped.length,
    github_matches: result.github_total, latest: result.latest, updated: result.updated,
    error: result.sync_error ?? (result.failed.length ? '部分回放未完成同步，请查看详情。' : null),
    failures: result.failed, index_source: result.index_source, ...progress.finish() };
}

export function replaySyncError(error) {
  return syncErrorMessage(error);
}
