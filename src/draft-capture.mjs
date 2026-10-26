import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Tracker sessions are provisional capture segments, NEVER Course/match bindings.
 * Preserve all observations in SQLite; this display projection can be rebuilt. */
export function projectDraftCaptures(observations, { cardNames = new Map(), gaps = 0 } = {}) {
  const segments = [], activeByEvent = new Map();
  const card = arena_id => ({ arena_id, name: cardNames.get(arena_id) ?? `Arena card ${arena_id}` });
  for (const observation of observations) {
    const { observation_id, account_key, event_id, kind, pack_number, pick_number, card_ids, logged_at } = observation;
    const identity = `${account_key ?? 'unassigned'}:${event_id}`;
    let segment = activeByEvent.get(identity);
    const first = kind === 'pack' && pack_number === 1 && pick_number === 1;
    const signature = JSON.stringify(card_ids);
    // Repeated P1P1 notifications before progression remain the same segment.
    // A repeated initial pack after progression starts another unverified segment.
    if (!segment || (first && (segment.initial !== signature || segment.progressed))) {
      segment = { id: observation_id.slice(0, 32), account_key: account_key ?? null, event_id, started_at: logged_at, initial: first ? signature : null,
        progressed: false, picks: new Map() };
      segments.push(segment); activeByEvent.set(identity, segment);
    }
    if (pack_number !== 1 || pick_number !== 1) segment.progressed = true;
    const key = `${pack_number}:${pick_number}`;
    const pick = segment.picks.get(key) ?? { pack_number, pick_number, packs: new Map(), selections: new Map(),
      observation_ids: [], logged_at: null };
    pick.observation_ids.push(observation_id);
    (kind === 'pack' ? pick.packs : pick.selections).set(signature, card_ids);
    if (kind === 'pick') pick.logged_at ??= logged_at;
    segment.picks.set(key, pick);
  }
  return segments.map(segment => {
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
    return { run_id: segment.id, account_key: segment.account_key, event_id: segment.event_id, event: segment.event_id,
      started_at: segment.started_at, current_module: 'DraftCapture', status: 'incomplete',
      capture_source: '17lands-local-log', binding: 'unresolved', history_complete: false,
      course_wins: null, course_losses: null, replay_wins: 0, replay_losses: 0, score_verified: false,
      colors: [], colors_complete: false, card_pool: [], matches: [], picks };
  }).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || a.run_id.localeCompare(b.run_id));
}

export async function readDraftCapture({ dataDir }) {
  const path = join(dataDir, 'draft-capture.sqlite3');
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid draft capture store.'); }
  catch (error) { if (error.code === 'ENOENT') return { observations: [], gaps: 0, accounts: [], active_account: null }; throw error; }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const observations = db.prepare('SELECT observation_id,body FROM observations ORDER BY seq').all()
      .map(row => ({ observation_id: row.observation_id, ...JSON.parse(row.body) }));
    const gaps = db.prepare('SELECT COUNT(*) AS n FROM gaps').get().n;
    const accounts = db.prepare('SELECT account_key,label FROM accounts ORDER BY label,account_key').all();
    const active_account = db.prepare("SELECT value FROM meta WHERE key='active_account'").get()?.value ?? null;
    db.exec('COMMIT');
    return { observations, gaps, accounts, active_account };
  } finally { db.close(); }
}

export async function listCapturedDraftRuns(options) {
  const { observations, gaps } = await readDraftCapture(options);
  let confirmed = [];
  try {
    const receipt = JSON.parse(await readFile(join(options.dataDir, 'draft-sync/published.json'), 'utf8'));
    if (receipt.verified && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(receipt.revision)) {
      const ids = new Set(receipt.observation_ids);
      confirmed = observations.filter(item => ids.has(item.observation_id));
    }
  } catch { /* Unpublished observations remain only in the transmission queue. */ }
  return projectDraftCaptures(confirmed, { ...options, gaps });
}
