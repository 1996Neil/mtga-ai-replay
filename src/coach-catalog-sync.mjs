import { createComputePool } from './compute-pool.mjs';
import { defaultDataDir, listReplays, getReplay } from './history.mjs';
import { buildCoachCards } from './coach-cards.mjs';
import { buildCoachBundle } from './coach-bundle.mjs';
import { discoverCardDatabase } from './cards.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSyncValidationSession } from './sync-security.mjs';
import { coachInputFingerprint, readSyncCache, writeSyncCache, syncDigest } from './sync-cache.mjs';
import { CoachSyncError, getCoachHistoryKey, getPublishedCoachIndex, enqueueCoachBundle, syncCoachBundles, syncErrorMessage } from './coach-sync.mjs';
import { readReplaySettings, replayInRetention } from './replay-settings.mjs';
import { loadInstalledChineseDisplayNames } from './display-names.mjs';

function generationReason(error) {
  if (error instanceof CoachSyncError || error?.code === 'MTGA_SYNC_SECURITY') return syncErrorMessage(error);
  // Unexpected exceptions can contain local paths or credentials; don't print them.
  return 'Coach Bundle generation failed; archived data could not be converted.';
}

/** The same single-match pipeline for missing archives and selected-match refresh. */
async function queueReplay(replay, options, published, receipts, pendingBundle) {
  if (!replay?.match?.id || !Number.isFinite(Date.parse(replay.match.started_at))) throw new CoachSyncError('SYNC_REPLAY', 'Archived match has no valid identity or start time.');
  if (!replay.games?.some(game => (game.steps ?? game.replay_steps)?.length)) throw new CoachSyncError('SYNC_REPLAY', 'Archived match has no detailed game steps.');
  const fastSnapshot = options.fastSync ? syncDigest(replay) : null;
  const fingerprint = options.fastSync ? null : await coachInputFingerprint(replay, options), previous = receipts[replay.match.id];
  const expectedBundle = pendingBundle ?? published;
  const remoteConfirmsPending = Boolean(pendingBundle && published?.content_hash === pendingBundle.content_hash &&
    published.history_key === pendingBundle.history_key);
  if (fastSnapshot && previous?.fast_snapshot === fastSnapshot && previous.content_hash === expectedBundle?.content_hash &&
      previous.history_key === expectedBundle?.history_key) {
    return { queued: false, generation_cached: true, content_hash: expectedBundle.content_hash, history_key: expectedBundle.history_key };
  }
  if (fingerprint && previous?.fingerprint === fingerprint.hash && previous.content_hash === expectedBundle?.content_hash &&
      previous.history_key === expectedBundle?.history_key && (remoteConfirmsPending || previous.valid_until === null ||
        (Number.isFinite(previous.valid_until) && previous.valid_until > Date.now()))) {
    return { queued: false, generation_cached: true, content_hash: expectedBundle.content_hash, history_key: expectedBundle.history_key };
  }
  options.onProgress?.({ phase: 'cards' });
  const observed = new Map(); let validUntil = null, databaseReadComplete = false;
  const cards = await buildCoachCards(replay, { ...options,
    onDatabaseRead: complete => { databaseReadComplete = complete; }, onMetadata: (id, metadata) => {
    observed.set(id, syncDigest(metadata));
    const retry = metadata.retry_after ?? (!metadata.source ? Date.now() + 60_000 : null);
    if (retry !== null) validUntil = Math.min(validUntil ?? Infinity, retry);
  } });
  options.onProgress?.({ phase: 'generating' });
  const historyKey = await getCoachHistoryKey(replay.match.id, options);
  const bundleOptions = { cards, multipart: true, ...(options.generatedAt ? {generatedAt:options.generatedAt} : {}), ...(historyKey ? { historyKey } : {}) };
  const bundle = options.computePool ? await options.computePool.run('bundle', {replay,options:bundleOptions}) : await buildCoachBundle(replay,bundleOptions);
  const queued = await enqueueCoachBundle(bundle, options);
  if (fastSnapshot) {
    receipts[replay.match.id] = { fast_snapshot: fastSnapshot, content_hash: bundle.contentHash, history_key: bundle.historyKey };
    return { ...queued, summary: bundle.summary, content_hash: bundle.contentHash, history_key: bundle.historyKey };
  }
  const after = await coachInputFingerprint(replay, options);
  let stable = databaseReadComplete && fingerprint && after && fingerprint.core === after.core;
  const dependencies = new Set(after?.metadataIds ?? []);
  for (const [id, hash] of observed) {
    if (!dependencies.has(id)) stable = false;
    try { if (syncDigest(JSON.parse(await readFile(join(options.dataDir, 'cards', `${id}.json`), 'utf8'))) !== hash) stable = false; }
    catch { stable = false; }
  }
  if (stable) receipts[replay.match.id] = { fingerprint: after.hash, content_hash: bundle.contentHash, history_key: bundle.historyKey, valid_until: validUntil };
  else delete receipts[replay.match.id];
  return { ...queued, summary: bundle.summary, content_hash: bundle.contentHash, history_key: bundle.historyKey };
}

/** Backfill every match in Viewer's canonical catalog, regardless of the match
 * selected for local export. Per-match generation failures never abort peers. */
export async function syncCoachCatalog(options = {}) {
  const count=options.workerCount??2;
  const displayNamesZh = options.displayNamesZh ?? await loadInstalledChineseDisplayNames();
  const pool = count ? createComputePool({size:count}) : null;
  try { return await runCatalog({...options, displayNamesZh, computePool:pool}); } finally { await pool?.close(); }
}
async function runCatalog(options) {
  // Remote-index preflight always checks history before receipts or generation.
  // Only per-bundle publication defers repeated scans to its final pinned SHA.
  const settings = { ...options, dataDir: options.dataDir ?? defaultDataDir(), validationSession: createSyncValidationSession(),
    deferFullHistoryValidation: true };
  const archived = await listReplays({ dataDir: settings.dataDir, limit: null });
  const staged = options.archiveDataDir ? (await listReplays({ dataDir: options.archiveDataDir, limit: null }))
    .filter(match => !options.stagedReplays || options.stagedReplays.has(match.id)) : [];
  const stagedIds = new Set(staged.map(match => match.id));
  const policy = await readReplaySettings(settings.dataDir);
  const local = [...archived.filter(match => !stagedIds.has(match.id)), ...staged].filter(match => replayInRetention(match, policy));
  const report = { local: local.length, already_published: 0, github_before: 0, missing: 0,
    published: 0, updated: 0, failed: [], skipped: [], successes: [], github_total: null, latest: null, committed: 0 };
  let snapshot;
  try { snapshot = options.publishedSnapshot ?? await getPublishedCoachIndex(settings); }
  catch (error) {
    if (!['GITHUB_UNAVAILABLE', 'GIT_FAILED'].includes(error.code)) throw error;
    // Offline runs still generate durable pending bundles as before. Do not use
    // stale receipts to claim a successful upload or a confirmed remote count.
    report.scan_error = syncErrorMessage(error);
    snapshot = await getPublishedCoachIndex({ ...settings, refresh: false });
  }
  report.index_source = snapshot.source;
  const published = new Map(snapshot.index.matches.map(match => [match.match_id, match]));
  report.github_before = published.size;
  report.already_published = local.filter(match => published.has(match.id)).length;
  report.missing = local.length - report.already_published;
  // Pending matches also need regeneration against a remotely established key
  // after recovery or publication from another machine. Never rename parts.
  const refresh = new Set([...(options.refreshMatchIds ?? []), ...stagedIds, ...snapshot.pending.map(item => item.match_id)]), attempted = [];
  const pendingBundles = new Map(snapshot.pending.map(item => [item.match_id, item]));
  const candidates = local.filter(match => !published.has(match.id) || refresh.has(match.id));
  report.candidates = candidates.length;
  options.onScan?.(report);
  if (candidates.length) settings.cardDb = options.cardDb ?? await discoverCardDatabase();
  const cache = await readSyncCache(settings.dataDir, 'replay-coach-generation-cache.json');
  const receipts = Object.assign(Object.create(null), cache?.matches && typeof cache.matches === 'object' && !Array.isArray(cache.matches) ? cache.matches : {});
  let completed = 0;
  for (const match of [...local].reverse()) {
    if (published.has(match.id) && !refresh.has(match.id)) continue;
    const identity = { match_id: match.id, started_at: match.started_at, result: match.result };
    try {
      const replay = options.stagedReplays?.get(match.id) ??
        await getReplay(match.id, { dataDir: stagedIds.has(match.id) ? options.archiveDataDir : settings.dataDir });
      const result = await queueReplay(replay, settings, published.get(match.id), receipts, pendingBundles.get(match.id));
      attempted.push({ ...identity, queued: result.queued, content_hash: result.content_hash, history_key: result.history_key });
    } catch (error) {
      const failure = { ...identity, reason: generationReason(error) };
      report.failed.push(failure); options.onFailure?.(failure);
    }
    options.onQueued?.({ completed: ++completed, total: candidates.length });
  }
  await writeSyncCache(settings.dataDir, 'replay-coach-generation-cache.json', { matches: receipts });
  try {
    options.onPublishing?.();
    const result = await syncCoachBundles(settings);
    Object.assign(report, { repository: result.repository, committed: result.committed ?? 0, pending: result.pending });
    if (result.disabled || (report.scan_error && !result.index)) {
      report.sync_error = report.scan_error ?? 'Private replay sync is disabled.';
    } else {
      const finalIndex = result.index ?? snapshot.index;
      const final = new Map(finalIndex.matches.map(match => [match.match_id, match]));
      report.confirmed = attempted.filter(item => final.get(item.match_id)?.content_hash === item.content_hash &&
        final.get(item.match_id)?.history_key === item.history_key).map(item => ({ ...item }));
      report.github_total = final.size;
      report.snapshot = { ...snapshot, index: finalIndex, commit: result.index ? result.last_synced?.commit : snapshot.commit };
      report.latest = [...final.values()].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || a.match_id.localeCompare(b.match_id))[0] ?? null;
      for (const match of attempted) {
        if (!final.has(match.match_id)) continue;
        if (!published.has(match.match_id)) {
          report.published++; report.successes.push(match); options.onPublished?.(match);
        } else if (match.queued && published.get(match.match_id).content_hash !== final.get(match.match_id).content_hash) report.updated++;
      }
    }
  } catch (error) { report.sync_error = syncErrorMessage(error); }
  if (report.sync_error) for (const match of attempted) {
    if (published.has(match.match_id) && !match.queued) continue;
    const failure = { match_id: match.match_id, started_at: match.started_at, result: match.result, reason: report.sync_error };
    report.failed.push(failure); options.onFailure?.(failure);
  }
  return report;
}

export function printCatalogSync(report, log = console.log, warn = console.warn) {
  log(`Local matches: ${report.local}\nAlready published: ${report.already_published}${report.index_source === 'cached' ? ' (cached; remote unverified)' : ''}\nMissing: ${report.missing}`);
  for (const match of report.successes) log(`✓ ${localTime(match.started_at)} ${match.result}`);
  for (const match of report.failed) warn(`Failed: ${localTime(match.started_at)} ${match.match_id}: ${match.reason}`);
  log(`Published: ${report.published}\nFailed: ${report.failed.length}\nSkipped: ${report.skipped.length}`);
  if (report.updated) log(`Updated existing matches: ${report.updated}`);
  if (report.sync_error) {
    warn(`GitHub Coach sync pending: ${report.sync_error}`);
    warn('Local replay is ready. Retry: mtga-gpt-replay sync');
  } else {
    log(`GitHub matches: ${report.github_total}\nLatest: ${report.latest ? `${localTime(report.latest.started_at)} ${report.latest.result}` : 'none'}`);
    if (!report.missing && !report.updated && !report.failed.length) log('Everything is up to date.');
  }
}
function localTime(value) {
  if (!Number.isFinite(Date.parse(value))) return 'Unknown time';
  return new Date(value).toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
