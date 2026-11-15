import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { validAccountKey } from './account-scope.mjs';
const observationCache = new Map();
const noCardNames = new Map(), projectionCaches = new WeakMap();
const SESSION_GAP_MS = 30 * 60 * 1000;

function segmentPickMap(run) {
  const minimumPack = Math.min(...(run.picks ?? []).map(pick => pick.pack_number).filter(Number.isInteger));
  const minimumPick = Math.min(...(run.picks ?? []).map(pick => pick.pick_number).filter(Number.isInteger));
  const packOffset = Number.isFinite(minimumPack) && minimumPack >= 2 ? -1 : 0;
  const pickOffset = Number.isFinite(minimumPick) && minimumPick >= 2 ? -1 : 0;
  return new Map((run.picks ?? []).map(pick => {
    const normalized = packOffset || pickOffset
      ? { ...pick, pack_number: pick.pack_number + packOffset, pick_number: pick.pick_number + pickOffset }
      : pick;
    return [`${normalized.pack_number}:${normalized.pick_number}`, normalized];
  }));
}

function mergeResumedSegments(runs) {
  const output = [];
  for (const run of runs.slice().sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || a.run_id.localeCompare(b.run_id))) {
    const current = segmentPickMap(run);
    let merged = false;
    for (let i = 0; i < output.length; i += 1) {
      const prior = output[i];
      if (prior.account_key !== run.account_key || prior.event_id !== run.event_id) continue;
      const priorStarted = Date.parse(prior.started_at ?? ''), currentStarted = Date.parse(run.started_at ?? '');
      if (Number.isFinite(priorStarted) && Number.isFinite(currentStarted) &&
        Math.abs(priorStarted - currentStarted) > 10 * 60 * 1000) continue;
      const priorMap = segmentPickMap(prior);
      const shared = [...current.keys()].filter(key => priorMap.has(key)).length;
      if (shared < 8) continue;
      const quality = value => [
        (value.picks ?? []).filter(pick => pick.selected).length,
        (value.picks ?? []).reduce((sum, pick) => sum + (pick.candidates?.length ?? 0), 0),
        value.picks?.length ?? 0,
      ];
      const currentQuality = quality(run), priorQuality = quality(prior);
      const better = currentQuality[0] > priorQuality[0] ||
        currentQuality[0] === priorQuality[0] && currentQuality[1] > priorQuality[1] ||
        currentQuality[0] === priorQuality[0] && currentQuality[1] === priorQuality[1] && currentQuality[2] > priorQuality[2];
      const chosen = better ? run : prior;
      const normalizedPicks = chosen === run ? [...current.values()] : [...priorMap.values()];
      output[i] = { ...chosen, picks: normalizedPicks.sort((a, b) => a.pack_number - b.pack_number || a.pick_number - b.pick_number),
        capture_run_ids: [...new Set([...(prior.capture_run_ids ?? [prior.run_id]), ...(run.capture_run_ids ?? [run.run_id])])] };
      merged = true;
      break;
    }
    if (!merged) output.push({ ...run, capture_run_ids: [run.run_id] });
  }
  return output.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || a.run_id.localeCompare(b.run_id));
}
export async function draftLogRevision(logDir = join(homedir(), '.seventeenlands')) {
  let names;
  try { names = (await readdir(logDir)).filter(name => /^seventeenlands\.log(?:\.|$)/.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
  return JSON.stringify(await Promise.all(names.map(async name => {
    try {
      const info = await lstat(join(logDir, name), { bigint: true });
      return [name, info.isFile() && !info.isSymbolicLink(), String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs)];
    } catch (error) { if (error.code === 'ENOENT') return [name, 'rotated']; throw error; }
  })));
}

/** Tracker sessions are provisional capture segments, NEVER Course/match bindings.
 * Preserve all observations in SQLite; this display projection can be rebuilt. */
export function projectDraftCaptures(observations, { cardNames = noCardNames, gaps = 0, onProject, collapseResumed = false } = {}) {
  let cache = projectionCaches.get(cardNames);
  if (!cache) { cache = new Map(); projectionCaches.set(cardNames, cache); }
  const segments = [], activeByEvent = new Map();
  const card = arena_id => ({ arena_id, name: cardNames.get(arena_id) ?? `Arena card ${arena_id}` });
  for (const observation of observations) {
    const { observation_id, account_key, event_id, kind, pack_number, pick_number, card_ids, logged_at } = observation;
    const identity = `${account_key ?? 'unassigned'}:${event_id}`;
    let segment = activeByEvent.get(identity);
    const first = kind === 'pack' && pack_number === 1 && pick_number === 1;
    const signature = JSON.stringify(card_ids);
    const previousTime = segment?.last_logged_at ? Date.parse(segment.last_logged_at) : NaN;
    const currentTime = logged_at ? Date.parse(logged_at) : NaN;
    const resumedAfterGap = Number.isFinite(previousTime) && Number.isFinite(currentTime) &&
      currentTime - previousTime > SESSION_GAP_MS;
    // Repeated P1P1 notifications before progression remain the same segment.
    // A repeated initial pack after progression starts another unverified segment.
    if (!segment || resumedAfterGap || (first && (segment.initial !== signature || segment.progressed))) {
      segment = { id: observation_id.slice(0, 32), account_key: account_key ?? null, event_id, started_at: logged_at, initial: first ? signature : null,
        progressed: false, picks: new Map() };
      segments.push(segment); activeByEvent.set(identity, segment);
    }
    segment.last_logged_at = logged_at;
    if (pack_number !== 1 || pick_number !== 1) segment.progressed = true;
    const key = `${pack_number}:${pick_number}`;
    const pick = segment.picks.get(key) ?? { pack_number, pick_number, packs: new Map(), selections: new Map(),
      observation_ids: [], logged_at: null };
    pick.observation_ids.push(observation_id);
    (kind === 'pack' ? pick.packs : pick.selections).set(signature, card_ids);
    if (kind === 'pick') pick.logged_at ??= logged_at;
    segment.picks.set(key, pick);
  }
  const projected = segments.map(segment => {
    const signature = JSON.stringify([gaps, segment.account_key, segment.event_id, segment.started_at,
      [...segment.picks.values()].map(pick => [pick.pack_number, pick.pick_number, pick.logged_at, [...pick.packs], [...pick.selections], pick.observation_ids])]);
    const cachedProjection = cache.get(segment.id);
    if (cachedProjection?.signature === signature) { onProject?.({ built: 0, reused: 1 }); return cachedProjection.value; }
    let pool = [], prefixExact = gaps === 0, previous = null, packSize = null;
    const picks = [...segment.picks.values()].sort((a, b) => a.pack_number - b.pack_number || a.pick_number - b.pick_number).map(item => {
      const candidates = item.packs.size === 1 ? [...item.packs.values()][0] : [];
      const selections = item.selections.size === 1 ? [...item.selections.values()][0] : [];
      const selected = selections.length === 1 ? selections[0] : null;
      const contiguous = previous ? item.pack_number === previous.pack_number && item.pick_number === previous.pick_number + 1 ||
        item.pack_number === previous.pack_number + 1 && item.pick_number === 1 && previous.pick_number === packSize :
        item.pack_number === 1 && item.pick_number === 1;
      if (item.pick_number === 1) packSize = candidates.length || null;
      const missing = [
        ...(!contiguous ? ['prior_pick'] : []), ...(!candidates.length ? ['candidate_pack'] : []),
        ...(item.packs.size > 1 || item.selections.size > 1 ? ['conflicting_observations'] : []),
        ...(!selections.length ? ['selected_card'] : []), ...(selections.length > 1 ? ['unsupported_multi_pick'] : []),
        ...(selected && !candidates.includes(selected) ? ['selection_not_in_pack'] : []),
        ...(gaps ? ['capture_gap'] : []),
      ];
      prefixExact &&= !missing.length;
      const before = pool.map(card);
      // Only explicit selections enter the observed pool; no final-pool backfill.
      pool = [...pool, ...selections];
      previous = item;
      return { pack_number: item.pack_number, pick_number: item.pick_number, picked_at: item.logged_at,
        candidates: candidates.map(card), selected: selected ? card(selected) : null,
        selected_ids: selections, pool_before: before, pool_after: pool.map(card),
        pool_exact: prefixExact, complete: prefixExact, missing: [...new Set([...missing, ...(!prefixExact ? ['history_unverified'] : [])])],
        observation_ids: item.observation_ids };
    });
    const value = { run_id: segment.id, account_key: segment.account_key, event_id: segment.event_id, event: segment.event_id,
      started_at: segment.started_at, current_module: 'DraftCapture', status: 'incomplete',
      capture_source: '17lands-local-log', binding: 'unresolved', history_complete: false,
      course_wins: null, course_losses: null, replay_wins: 0, replay_losses: 0, score_verified: false,
      colors: [], colors_complete: false, card_pool: [], matches: [], picks };
    if (cache.size >= 128 && !cache.has(segment.id)) cache.delete(cache.keys().next().value);
    cache.set(segment.id, { signature, value }); onProject?.({ built: 1, reused: 0 });
    return value;
  }).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || a.run_id.localeCompare(b.run_id));
  return collapseResumed ? mergeResumedSegments(projected) : projected;
}

export async function readDraftCapture({ dataDir, metadataOnly = false, onRead }) {
  const path = join(dataDir, 'draft-capture.sqlite3');
  let identity;
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid draft capture store.'); identity = `${info.dev}:${info.ino}`; }
  catch (error) { if (error.code === 'ENOENT') return { observations: [], gaps: 0, accounts: [], active_account: null }; throw error; }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    let observations = [], rows = [], incremental = false;
    if (!metadataOnly) {
      const revisionValue = db.prepare("SELECT value FROM meta WHERE key='observation_revision'").get()?.value;
      const revision = /^\d+$/.test(revisionValue ?? '') ? Number(revisionValue) : null;
      const last = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM observations').get().seq;
      const previous = observationCache.get(path);
      if (revision !== null && previous?.identity === identity && revision === previous.revision && last === previous.sequence) {
        observations = previous.observations;
        incremental = true;
      } else if (revision !== null && previous?.identity === identity && previous.revision !== null &&
        last > previous.sequence && revision > previous.revision) {
        rows = db.prepare('SELECT seq,observation_id,body FROM observations WHERE seq>? ORDER BY seq').all(previous.sequence);
        // Updates/deletions also bump the counter. Only a pure append can reuse
        // old facts; a repair or replacement must re-read that altered source.
        if (revision - previous.revision === rows.length) {
          observations = [...previous.observations, ...rows.map(row => ({ observation_id: row.observation_id, ...JSON.parse(row.body) }))];
          incremental = true;
        }
      }
      if (!incremental) {
        rows = db.prepare('SELECT observation_id,body FROM observations ORDER BY seq').all();
        observations = rows.map(row => ({ observation_id: row.observation_id, ...JSON.parse(row.body) }));
      }
      if (observationCache.size >= 4 && !observationCache.has(path)) observationCache.delete(observationCache.keys().next().value);
      observationCache.set(path, { identity, revision, sequence: last, observations });
    }
    const gaps = metadataOnly ? 0 : db.prepare('SELECT COUNT(*) AS n FROM gaps').get().n;
    const accounts = db.prepare('SELECT account_key,label FROM accounts ORDER BY label,account_key').all();
    const active_account = db.prepare("SELECT value FROM meta WHERE key='active_account'").get()?.value ?? null;
    db.exec('COMMIT');
    onRead?.({ observation_rows: rows.length, metadata_only: metadataOnly, incremental });
    return { observations, gaps, accounts, active_account };
  } finally { db.close(); }
}

export async function listCapturedDraftRuns(options) {
  const { observations, gaps } = await readDraftCapture(options);
  if (options.includeUnpublished === true)
    return projectDraftCaptures(observations, { ...options, gaps, collapseResumed: true });
  let confirmed = [];
  try {
    const receipt = JSON.parse(await readFile(join(options.dataDir, 'draft-sync/published.json'), 'utf8'));
    if (receipt.verified && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(receipt.revision)) {
      const ids = new Set(receipt.observation_ids);
      confirmed = observations.filter(item => ids.has(item.observation_id));
    }
  } catch { /* Unpublished observations remain only in the transmission queue. */ }
  return projectDraftCaptures(confirmed, { ...options, gaps, collapseResumed: true });
}

/** Local-only unknown-owner projection. It is intentionally outside Git
 * publication, but must remain visible in the unassigned Viewer account. */
export async function listUnknownDraftRuns(options) {
  const { observations, gaps } = await readDraftCapture(options);
  let confirmed = new Set();
  try {
    const receipt = JSON.parse(await readFile(join(options.dataDir, 'draft-sync/published.json'), 'utf8'));
    if (receipt.verified && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(receipt.revision))
      confirmed = new Set(receipt.observation_ids);
  } catch { /* No verified publication yet. */ }
  const unknown = observations.filter(item => !validAccountKey(item.account_key) && !confirmed.has(item.observation_id));
  return projectDraftCaptures(unknown, { ...options, gaps, collapseResumed: true });
}
