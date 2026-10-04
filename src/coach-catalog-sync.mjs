import { defaultDataDir, listReplays, getReplay } from './history.mjs';
import { buildCoachCards } from './coach-cards.mjs';
import { buildCoachBundle } from './coach-bundle.mjs';
import { CoachSyncError, getCoachHistoryKey, getPublishedCoachIndex, enqueueCoachBundle, syncCoachBundles, syncErrorMessage } from './coach-sync.mjs';

function generationReason(error) {
  if (error instanceof CoachSyncError || error?.code === 'MTGA_SYNC_SECURITY') return syncErrorMessage(error);
  // Unexpected exceptions can contain local paths or credentials; don't print them.
  return 'Coach Bundle generation failed; archived data could not be converted.';
}

/** The same single-match pipeline for missing archives and selected-match refresh. */
async function queueReplay(replay, options) {
  if (!replay?.match?.id || !Number.isFinite(Date.parse(replay.match.started_at))) throw new CoachSyncError('SYNC_REPLAY', 'Archived match has no valid identity or start time.');
  if (!replay.games?.some(game => (game.steps ?? game.replay_steps)?.length)) throw new CoachSyncError('SYNC_REPLAY', 'Archived match has no detailed game steps.');
  const cards = await buildCoachCards(replay, { dataDir: options.dataDir, cardDb: options.cardDb });
  const historyKey = await getCoachHistoryKey(replay.match.id, options);
  const bundle = await buildCoachBundle(replay, { cards, multipart: true, ...(historyKey ? { historyKey } : {}) });
  const queued = await enqueueCoachBundle(bundle, options);
  return { ...queued, summary: bundle.summary };
}

/** Backfill every match in Viewer's canonical catalog, regardless of the match
 * selected for local export. Per-match generation failures never abort peers. */
export async function syncCoachCatalog(options = {}) {
  const settings = { ...options, dataDir: options.dataDir ?? defaultDataDir() };
  const local = await listReplays({ dataDir: settings.dataDir, limit: null });
  const report = { local: local.length, already_published: 0, github_before: 0, missing: 0,
    published: 0, updated: 0, failed: [], skipped: [], successes: [], github_total: null, latest: null, committed: 0 };
  let snapshot;
  try { snapshot = await getPublishedCoachIndex(settings); }
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
  options.onScan?.(report);
  // Pending matches also need regeneration against a remotely established key
  // after recovery or publication from another machine. Never rename parts.
  const refresh = new Set([...(options.refreshMatchIds ?? []), ...snapshot.pending.map(item => item.match_id)]), attempted = [];
  const candidates = local.filter(match => !published.has(match.id) || refresh.has(match.id));
  let completed = 0;
  for (const match of [...local].reverse()) {
    if (published.has(match.id) && !refresh.has(match.id)) continue;
    const identity = { match_id: match.id, started_at: match.started_at, result: match.result };
    try {
      const replay = await getReplay(match.id, { dataDir: settings.dataDir });
      const result = await queueReplay(replay, settings);
      attempted.push({ ...identity, queued: result.queued });
    } catch (error) {
      const failure = { ...identity, reason: generationReason(error) };
      report.failed.push(failure); options.onFailure?.(failure);
    }
    options.onQueued?.({ completed: ++completed, total: candidates.length });
  }
  try {
    options.onPublishing?.();
    const result = await syncCoachBundles(settings);
    Object.assign(report, { repository: result.repository, committed: result.committed ?? 0, pending: result.pending });
    if (result.disabled || (report.scan_error && !result.index)) {
      report.sync_error = report.scan_error ?? 'Private replay sync is disabled.';
    } else {
      const finalIndex = result.index ?? snapshot.index;
      const final = new Map(finalIndex.matches.map(match => [match.match_id, match]));
      report.github_total = final.size;
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
