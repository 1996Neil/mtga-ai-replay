import { discoverLogs } from './discovery.mjs';
import { discoverCardDatabase, loadCardNames, loadCardLandColors, loadCounterNames } from './cards.mjs';
import { readRecords } from './log-reader.mjs';
import { buildReplays } from './replay.mjs';
import { buildDraftRunIndex, saveDraftRunIndex } from './draft-runs.mjs';
import { buildDraftPickIndex } from './draft-picks.mjs';
import { archiveReplays, defaultDataDir, listReplays, getReplay, isReplayExcluded } from './history.mjs';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { syncCoachCatalog } from './coach-catalog-sync.mjs';
import { getCoachSyncStatus, syncErrorMessage } from './coach-sync.mjs';
import { importInputFingerprint, archiveFingerprint, readSyncCache, writeSyncCache, syncRulesFingerprint, syncDigest } from './sync-cache.mjs';
import { createSyncProgress } from './sync-progress.mjs';

/** Shared with CLI: re-discover current/rotated logs on every invocation. */
export async function importReplayLogs({ dataDir = defaultDataDir(), logPath, logDir, cardDb, all = true, gitFirst = false } = {}) {
  const archiveDir = gitFirst ? join(dataDir, 'replay-outbox') : dataDir;
  const paths = await discoverLogs({ logPath, logDir });
  const database = await discoverCardDatabase({ cardDb });
  const cached = await readSyncCache(dataDir, 'replay-import-cache.json');
  async function quickIdentity(includeArchive = true) {
    const files = [...paths, ...(database ? [database, database + '-wal'] : []),
      ...(includeArchive ? [join(dataDir, 'replays.sqlite3'), join(dataDir, 'replays.sqlite3-wal'),
        join(archiveDir, 'replays.sqlite3'), join(archiveDir, 'replays.sqlite3-wal')] : [])];
    const values = await Promise.all(files.map(async path => {
      try {
        const info = await stat(path, { bigint: true });
        if (path.endsWith('-wal') && info.size === 0n) return [path, 'no-wal'];
        return [path, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
      } catch (error) { if (error.code === 'ENOENT') return [path, path.endsWith('-wal') ? 'no-wal' : 'missing']; throw error; }
    }));
    const rules = await syncRulesFingerprint();
    return rules ? syncDigest([values, rules, all]) : null;
  }
  const quick = gitFirst ? await quickIdentity() : null;
  const quickInputs = gitFirst ? await quickIdentity(false) : null;
  if (quick && cached?.gitFirst && cached.quick === quick) {
    return { paths, database, detailed: cached.detailed, hasGameRecords: cached.hasGameRecords,
      archive: { archived: 0, preserved: 0 }, cached: true };
  }
  const input = gitFirst ? quickInputs : await importInputFingerprint(paths, database, all);
  if (input && cached?.input === input && typeof cached.detailed === 'boolean' && typeof cached.hasGameRecords === 'boolean' &&
      cached.archive === (gitFirst ? quick : await archiveFingerprint(archiveDir)) && Boolean(cached.gitFirst) === gitFirst) {
    return { paths, database, detailed: cached.detailed, hasGameRecords: cached.hasGameRecords, archive: { archived: 0, preserved: 0 }, cached: true };
  }
  const { records, detailed } = await readRecords(paths);
  const names = await loadCardNames(database), counterNames = await loadCounterNames(database);
  const { replays } = records.length ? await buildReplays(records, names, { counterNames }) : { replays: [] };
  let importable = replays.filter(r => (all || r.match.is_jump_in) && r.games.some(g => g.steps?.length));
  if (!database) for (const replay of importable) replay.warnings.push('No local card database found; names use Arena IDs.');
  if (gitFirst) {
    const visible = new Map((await listReplays({ dataDir, limit: null })).map(match => [match.id, match]));
    const allowed = [];
    for (const replay of importable) {
      if (!replay.match.account_key || await isReplayExcluded(replay.match.id, { dataDir })) continue;
      const prior = visible.get(replay.match.id);
      if (prior) {
        const previous = await getReplay(replay.match.id, { dataDir });
        const { coachNotes: oldNotes, ...oldFacts } = previous ?? {};
        const { coachNotes: newNotes, ...newFacts } = replay;
        if (JSON.stringify(oldFacts) === JSON.stringify(newFacts)) continue;
      }
      allowed.push(replay);
    }
    importable = allowed;
  }
  const archive = importable.length ? await archiveReplays(importable, { dataDir: archiveDir }) : { archived: 0, preserved: 0 };
  let draftRunIndex = null;
  if (records.length && !gitFirst) {
    const history = await listReplays({ dataDir, limit: null });
    const draftRuns = buildDraftRunIndex(records, history, { cardNames: names, cardLandColors: await loadCardLandColors(database) });
    const draftPicks = buildDraftPickIndex(records, { cardNames: names });
    draftRunIndex = await saveDraftRunIndex(draftRuns, { dataDir, picks: draftPicks });
  }
  const hasGameRecords = records.some(r => r.greToClientEvent);
  if (input && input === (gitFirst ? await quickIdentity(false) : await importInputFingerprint(paths, database, all))) {
    const fingerprint = gitFirst ? await quickIdentity() : await archiveFingerprint(archiveDir);
    if (fingerprint) await writeSyncCache(dataDir, 'replay-import-cache.json', { input, archive: fingerprint, detailed, hasGameRecords, gitFirst,
      ...(gitFirst && quickInputs === await quickIdentity(false) ? { quick: await quickIdentity() } : {}) });
  }
  return { paths, detailed, hasGameRecords, database, archive, draftRunIndex, cached: false };
}

/** Explicit Viewer upload: publish the current archive through the exact CLI
 * canonical publisher. Local log discovery/import runs independently. */
export async function syncReplayHistory({ dataDir = defaultDataDir(), onProgress, ...options } = {}) {
  const progress = createSyncProgress(onProgress), emit = value => progress.emit(value);
  emit({ phase: 'scanning' });
  const catalog = await listReplays({ dataDir, limit: null });
  const status = await getCoachSyncStatus({ dataDir, verify: false });
  if (!status.enabled) return { status: 'failed', error: 'GitHub Coach 同步尚未配置。请先运行 mtga-gpt-replay sync --repo owner/name。',
    new_matches: 0, local_matches: catalog.length, already_published: 0, missing: null, published: 0, failed: 0, skipped: 0, github_matches: null, latest: null, failures: [] };
  emit({ phase: 'comparing' });
  let total = 0;
  const result = await syncCoachCatalog({ ...options, dataDir, fastSync: options.fastSync ?? true, refreshMatchIds: options.refreshMatchIds ?? [],
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
