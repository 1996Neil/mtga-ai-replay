import { createHash } from 'node:crypto';
import { copyFile, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describeMatchMode } from './match-mode.mjs';
import { indexMatchMetadata } from './match-metadata.mjs';

const DB_NAME = 'draft-runs.sqlite3';
const SCHEMA_VERSION = '2';
const isDraft = value => /draft|limited/i.test(String(value ?? ''));
const safeText = (value, limit = 120) => typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
const cardId = value => {
  const raw = value && typeof value === 'object' ? value.cardId ?? value.grpId ?? value.arena_id : value;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const runId = (eventId, courseId) => createHash('sha256').update(eventId + '\0' + courseId).digest('hex').slice(0, 32);

export function deckLandColors(deck, cardLandColors = new Map()) {
  if (!Array.isArray(deck) || !deck.length) return { colors: [], colors_complete: false };
  const colors = new Set();
  let lands = 0;
  for (const item of deck) {
    const quantity = Number(item?.quantity ?? item?.Quantity ?? 1);
    if (quantity === 0) continue;
    const id = cardId(item), source = cardLandColors.get(id);
    if (!id || !Number.isSafeInteger(quantity) || quantity < 0 || source === undefined) return { colors: [], colors_complete: false };
    if (source === null) continue; // Hybrid spells never contribute deck colors.
    if (!Array.isArray(source) || source.some(color => !['W', 'U', 'B', 'R', 'G'].includes(color))) return { colors: [], colors_complete: false };
    lands += quantity;
    for (const color of source) colors.add(color);
  }
  return { colors: [...colors].sort((a, b) => 'WUBRG'.indexOf(a) - 'WUBRG'.indexOf(b)), colors_complete: lands > 0 };
}

/** Correct old derived summaries at read time without changing any saved rows.
 * A run uses its latest archived main deck, never its unplayed draft pool. */
export function withDraftRunLandColors(runs, decksByMatch, cardLandColors) {
  return runs.map(run => {
    const latest = [...run.matches].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || b.id.localeCompare(a.id))[0];
    return { ...run, ...deckLandColors(decksByMatch.get(latest?.id), cardLandColors) };
  });
}

function courseSnapshot(course, cardNames, cardLandColors) {
  const mainDeck = Array.isArray(course.CourseDeck?.MainDeck) ? course.CourseDeck.MainDeck : [];
  const pool = Array.isArray(course.CardPool) ? course.CardPool.map(cardId).filter(Boolean) : [];
  const deck = mainDeck.map(item => ({ arena_id: cardId(item), quantity: Number(item?.quantity ?? item?.Quantity ?? 1) }))
    .filter(item => item.arena_id && Number.isSafeInteger(item.quantity) && item.quantity > 0);
  const landColors = deckLandColors(deck, cardLandColors);
  return {
    event_id: safeText(course.InternalEventName, 120),
    course_key: String(course.CourseId).slice(0, 160),
    current_module: safeText(String(course.CurrentModule ?? ''), 100),
    course_wins: Number.isSafeInteger(course.CurrentWins) && course.CurrentWins >= 0 ? course.CurrentWins : null,
    course_losses: Number.isSafeInteger(course.CurrentLosses) && course.CurrentLosses >= 0 ? course.CurrentLosses : null,
    ...landColors,
    card_pool: pool.map(id => ({ arena_id: id, name: cardNames.get(id) ?? 'Arena card ' + id })),
  };
}

export function buildDraftRunIndex(records, history, { cardNames = new Map(), cardLandColors = new Map() } = {}) {
  const archived = new Map(history.map(item => [String(item.id ?? item.match_id), item]));
  const metadata = indexMatchMetadata(records);

  const latestByEvent = new Map(), coursesByKey = new Map(), links = new Map();
  for (const record of records) {
    const courseValues = Array.isArray(record.Courses) ? record.Courses : record.Course ? [record.Course] : [];
    const snapshotEvents = new Map();
    for (const course of courseValues) {
      if (!course || course.CourseId == null || !safeText(course.InternalEventName)) continue;
      const eventId = safeText(course.InternalEventName);
      const snapshot = courseSnapshot(course, cardNames, cardLandColors);
      const prior = snapshotEvents.get(eventId);
      if (prior && prior.course_key !== snapshot.course_key) snapshotEvents.set(eventId, { ambiguous: true });
      else snapshotEvents.set(eventId, snapshot);
      const key = eventId + '\0' + snapshot.course_key;
      const existing = coursesByKey.get(key) ?? {};
      coursesByKey.set(key, { ...existing, ...snapshot,
        course_wins: snapshot.course_wins ?? existing.course_wins ?? null,
        course_losses: snapshot.course_losses ?? existing.course_losses ?? null,
        current_module: snapshot.current_module ?? existing.current_module ?? null,
        card_pool: snapshot.card_pool.length ? snapshot.card_pool : existing.card_pool ?? [],
        colors: snapshot.colors_complete ? snapshot.colors : existing.colors ?? [],
        colors_complete: snapshot.colors_complete || existing.colors_complete === true });
    }
    for (const [eventId, snapshot] of snapshotEvents) latestByEvent.set(eventId, snapshot);
    const config = record.matchGameRoomStateChangedEvent?.gameRoomInfo?.gameRoomConfig;
    if (!config?.matchId) continue;
    const matchId = String(config.matchId), match = archived.get(matchId);
    if (!match || !isDraft(match.event_id ?? match.event)) continue;
    const localSeat = metadata.get(matchId)?.localSeat;
    const player = (config.reservedPlayers ?? []).find(value => value.systemSeatId === localSeat);
    const eventId = safeText(player?.eventId), course = eventId ? latestByEvent.get(eventId) : null;
    if (!course || course.ambiguous) continue;
    const key = eventId + '\0' + course.course_key;
    const linksForMatch = links.get(matchId) ?? new Set();
    linksForMatch.add(key); links.set(matchId, linksForMatch);
  }

  const grouped = new Map();
  for (const [matchId, keys] of links) {
    if (keys.size !== 1) continue;
    const key = [...keys][0], course = coursesByKey.get(key), match = archived.get(matchId);
    if (!course || !match) continue;
    const group = grouped.get(key) ?? { course, matches: [] };
    group.matches.push({ id: matchId, started_at: match.started_at, result: match.result ?? null, game_count: match.game_count ?? null });
    if (!group.course.started_at || String(match.started_at).localeCompare(group.course.started_at) < 0) group.course.started_at = match.started_at;
    grouped.set(key, group);
  }
  return [...grouped.values()].map(({ course, matches }) => {
    matches.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)) || a.id.localeCompare(b.id));
    const wins = matches.filter(match => match.result === 'Win').length;
    const losses = matches.filter(match => match.result === 'Loss').length;
    const known = matches.every(match => ['Win', 'Loss', 'Draw'].includes(match.result));
    const scoreVerified = known && Number.isSafeInteger(course.course_wins) && Number.isSafeInteger(course.course_losses) &&
      wins === course.course_wins && losses === course.course_losses;
    const module = String(course.current_module ?? '').toLowerCase();
    const moduleStatus = /complete|finish|claim|reward|end/.test(module) ? 'completed' :
      /draft|play|match|active/.test(module) ? 'in_progress' : 'incomplete';
    return {
      run_id: runId(course.event_id, course.course_key), event_id: course.event_id,
      event: describeMatchMode({ event_id: course.event_id }).event,
      started_at: course.started_at ?? matches[0]?.started_at ?? null,
      current_module: course.current_module, course_wins: course.course_wins, course_losses: course.course_losses,
      replay_wins: wins, replay_losses: losses, score_verified: scoreVerified,
      status: !scoreVerified || moduleStatus === 'incomplete' ? 'incomplete' : moduleStatus,
      colors: course.colors, colors_complete: course.colors_complete, card_pool: course.card_pool, matches,
    };
  }).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || a.run_id.localeCompare(b.run_id));
}

async function ensureSidecar(path) {
  try { await stat(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const handle = await open(path, 'wx', 0o600); await handle.close();
  }
}

export async function saveDraftRunIndex(runs, { dataDir, picks = [] }) {
  const path = join(dataDir, DB_NAME), backup = path + '.backup';
  let existed = true;
  try { await stat(path); } catch (error) { if (error.code === 'ENOENT') existed = false; else throw error; }
  if (existed) {
    const prior = new DatabaseSync(path);
    try { prior.exec('PRAGMA journal_mode=DELETE'); } finally { prior.close(); }
    await copyFile(path, backup);
  }
  await ensureSidecar(path);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    db.exec(`CREATE TABLE IF NOT EXISTS draft_run_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS draft_runs (
        run_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, event TEXT NOT NULL, started_at TEXT,
        current_module TEXT, course_wins INTEGER, course_losses INTEGER, replay_wins INTEGER NOT NULL,
        replay_losses INTEGER NOT NULL, score_verified INTEGER NOT NULL, status TEXT NOT NULL,
        colors_json TEXT NOT NULL, colors_complete INTEGER NOT NULL, card_pool_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS draft_run_matches (
        match_id TEXT PRIMARY KEY, run_id TEXT, started_at TEXT, result TEXT, game_count INTEGER,
        link_status TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES draft_runs(run_id)
      );
      CREATE INDEX IF NOT EXISTS draft_run_matches_by_run ON draft_run_matches(run_id, started_at);
      CREATE TABLE IF NOT EXISTS draft_run_picks (
        run_id TEXT NOT NULL, pack_number INTEGER NOT NULL, pick_number INTEGER NOT NULL, picked_at TEXT,
        candidates_json TEXT NOT NULL, selected_json TEXT, pool_before_json TEXT NOT NULL, pool_after_json TEXT NOT NULL,
        complete INTEGER NOT NULL, missing_json TEXT NOT NULL, PRIMARY KEY(run_id, pack_number, pick_number),
        FOREIGN KEY(run_id) REFERENCES draft_runs(run_id)
      );
      INSERT INTO draft_run_meta(key, value) VALUES ('schema_version', '2')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
    const upsert = db.prepare(`INSERT INTO draft_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET event_id=excluded.event_id, event=excluded.event,
      started_at=CASE WHEN draft_runs.started_at IS NULL THEN excluded.started_at
        WHEN excluded.started_at IS NULL THEN draft_runs.started_at
        ELSE MIN(draft_runs.started_at, excluded.started_at) END,
      current_module=COALESCE(excluded.current_module, draft_runs.current_module),
      course_wins=COALESCE(excluded.course_wins, draft_runs.course_wins),
      course_losses=COALESCE(excluded.course_losses, draft_runs.course_losses),
      replay_wins=excluded.replay_wins, replay_losses=excluded.replay_losses,
      score_verified=excluded.score_verified, status=excluded.status,
      colors_json=CASE WHEN excluded.colors_complete=1 THEN excluded.colors_json ELSE draft_runs.colors_json END,
      colors_complete=MAX(draft_runs.colors_complete, excluded.colors_complete),
      card_pool_json=CASE WHEN json_array_length(excluded.card_pool_json)>0 THEN excluded.card_pool_json ELSE draft_runs.card_pool_json END`);
    const member = db.prepare(`INSERT INTO draft_run_matches VALUES (?, ?, ?, ?, ?, 'linked')
      ON CONFLICT(match_id) DO UPDATE SET
      run_id=CASE WHEN draft_run_matches.run_id=excluded.run_id THEN excluded.run_id ELSE NULL END,
      started_at=excluded.started_at, result=excluded.result, game_count=excluded.game_count,
      link_status=CASE WHEN draft_run_matches.run_id=excluded.run_id THEN 'linked' ELSE 'ambiguous' END`);
    for (const run of runs) {
      upsert.run(run.run_id, run.event_id, run.event, run.started_at, run.current_module,
        run.course_wins, run.course_losses, run.replay_wins, run.replay_losses, run.score_verified ? 1 : 0,
        run.status, JSON.stringify(run.colors), run.colors_complete ? 1 : 0, JSON.stringify(run.card_pool));
      for (const match of run.matches) member.run(match.id, run.run_id, match.started_at, match.result, match.game_count);
    }
    const runIds = new Set(runs.map(run => run.run_id));
    const pick = db.prepare(`INSERT INTO draft_run_picks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, pack_number, pick_number) DO UPDATE SET
      picked_at=COALESCE(excluded.picked_at, draft_run_picks.picked_at),
      candidates_json=CASE WHEN json_array_length(excluded.candidates_json)>0 THEN excluded.candidates_json ELSE draft_run_picks.candidates_json END,
      selected_json=COALESCE(excluded.selected_json, draft_run_picks.selected_json),
      pool_before_json=CASE WHEN json_array_length(excluded.pool_before_json)>0 OR excluded.pack_number=1 AND excluded.pick_number=1 THEN excluded.pool_before_json ELSE draft_run_picks.pool_before_json END,
      pool_after_json=CASE WHEN json_array_length(excluded.pool_after_json)>0 THEN excluded.pool_after_json ELSE draft_run_picks.pool_after_json END,
      complete=MAX(draft_run_picks.complete, excluded.complete),
      missing_json=CASE WHEN excluded.complete=1 THEN '[]' ELSE excluded.missing_json END`);
    for (const item of picks) {
      if (!runIds.has(item.run_id)) continue;
      pick.run(item.run_id, item.pack_number, item.pick_number, item.picked_at, JSON.stringify(item.candidates),
        item.selected ? JSON.stringify(item.selected) : null, JSON.stringify(item.pool_before), JSON.stringify(item.pool_after),
        item.complete ? 1 : 0, JSON.stringify(item.missing));
    }
    db.exec('COMMIT');
    return { runs: runs.length, matches: runs.reduce((count, run) => count + run.matches.length, 0), backup: existed ? backup : null };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}

export async function listDraftRuns({ dataDir }) {
  const path = join(dataDir, DB_NAME);
  try { await stat(path); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = db.prepare("SELECT value FROM draft_run_meta WHERE key='schema_version'").get()?.value;
    if (version !== SCHEMA_VERSION) return [];
    const runs = db.prepare('SELECT * FROM draft_runs ORDER BY started_at DESC, run_id').all();
    const members = db.prepare("SELECT match_id, run_id, started_at, result, game_count FROM draft_run_matches WHERE link_status='linked' AND run_id IS NOT NULL ORDER BY started_at, match_id").all();
    const picks = db.prepare('SELECT * FROM draft_run_picks ORDER BY run_id, pack_number, pick_number').all();
    const byRun = new Map();
    for (const member of members) {
      const values = byRun.get(member.run_id) ?? [];
      values.push({ id: member.match_id, started_at: member.started_at, result: member.result, game_count: member.game_count });
      byRun.set(member.run_id, values);
    }
    const picksByRun = new Map();
    for (const pick of picks) {
      const values = picksByRun.get(pick.run_id) ?? [];
      values.push({ pack_number: pick.pack_number, pick_number: pick.pick_number, picked_at: pick.picked_at,
        candidates: JSON.parse(pick.candidates_json), selected: pick.selected_json ? JSON.parse(pick.selected_json) : null,
        pool_before: JSON.parse(pick.pool_before_json), pool_after: JSON.parse(pick.pool_after_json),
        complete: pick.complete === 1, missing: JSON.parse(pick.missing_json) });
      picksByRun.set(pick.run_id, values);
    }
    return runs.map(run => {
      // A rotated log can update only part of a run. Kept members are the
      // complete local archive; never display the partial import's counters.
      const matches = byRun.get(run.run_id) ?? [];
      const wins = matches.filter(match => match.result === 'Win').length;
      const losses = matches.filter(match => match.result === 'Loss').length;
      const verified = matches.length > 0 && matches.every(match => ['Win', 'Loss', 'Draw'].includes(match.result)) &&
        Number.isSafeInteger(run.course_wins) && Number.isSafeInteger(run.course_losses) &&
        wins === run.course_wins && losses === run.course_losses;
      const module = String(run.current_module ?? '').toLowerCase();
      const moduleStatus = /complete|finish|claim|reward|end/.test(module) ? 'completed' :
        /draft|play|match|active/.test(module) ? 'in_progress' : 'incomplete';
      return {
      run_id: run.run_id, event_id: run.event_id, event: run.event, started_at: run.started_at,
      current_module: run.current_module, course_wins: run.course_wins, course_losses: run.course_losses,
      replay_wins: wins, replay_losses: losses, score_verified: verified,
      status: verified ? moduleStatus : 'incomplete', colors: JSON.parse(run.colors_json), colors_complete: run.colors_complete === 1,
      card_pool: JSON.parse(run.card_pool_json), matches, picks: picksByRun.get(run.run_id) ?? [],
      };
    });
  } finally { db.close(); }
}
