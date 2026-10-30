import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, stat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isTutorialMatch } from './replay-policy.mjs';
import { readReplaySettings, replayInRetention } from './replay-settings.mjs';

export const defaultDataDir = (home = homedir()) => join(home, '.local', 'share', 'mtga-gpt-replay');
const dbPath = (dataDir) => join(dataDir, 'replays.sqlite3');

async function openDatabase(dataDir, write = false) {
  if (write) await mkdir(dataDir, { recursive: true, mode: 0o700 });
  else {
    try { await stat(dbPath(dataDir)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const database = new DatabaseSync(dbPath(dataDir), { readOnly: !write });
  database.exec('PRAGMA busy_timeout=5000');
  if (write) {
    database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS replays (
        match_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, summary_json TEXT NOT NULL,
        replay_json TEXT NOT NULL, archived_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS replay_chronology ON replays(started_at DESC);
      CREATE TABLE IF NOT EXISTS coach_notes (match_id TEXT PRIMARY KEY, notes_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cards (arena_id INTEGER PRIMARY KEY, name TEXT NOT NULL, metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS excluded_replays (match_id TEXT PRIMARY KEY, reason TEXT NOT NULL, excluded_at TEXT NOT NULL);
    `);
    // Reapplying identical permissions still changes ctime on macOS. Two
    // observers sharing this archive would keep invalidating each other.
    if (((await stat(dbPath(dataDir))).mode & 0o7777) !== 0o600) await chmod(dbPath(dataDir), 0o600);
  }
  return database;
}

// The parser is the visibility boundary. Archive explicit hidden/postgame markers
// defensively as anonymous placeholders, including future nested board snapshots.
function safeArchive(value) {
  if (Array.isArray(value)) return value.map(safeArchive);
  if (!value || typeof value !== 'object') return value;
  if (value.hidden === true || /hidden|post.?game/i.test(value.visibility ?? '')) return { hidden: true };
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, safeArchive(child)]));
}

function summary(replay) {
  const games = replay.games ?? [];
  return { ...replay.match, game_count: games.length,
    turn_count: games.reduce((n, game) => n + (game.turns?.length ?? 0), 0),
    step_count: games.reduce((n, game) => n + (game.replay_steps?.length ?? game.steps?.length ?? game.turns?.reduce((m, turn) => m + (turn.events?.length ?? 0), 0) ?? 0), 0),
  };
}

function collectCards(value, cards = new Map()) {
  if (!value || typeof value !== 'object' || value.hidden) return cards;
  const arenaId = value.arena_id ?? value.arenaId;
  if (Number.isInteger(arenaId) && arenaId > 0 && typeof value.name === 'string' && value.name) {
    cards.set(arenaId, { arena_id: arenaId, name: value.name,
      ...(value.mana_cost ? { mana_cost: value.mana_cost } : {}),
      ...(value.type_line ? { type_line: value.type_line } : {}),
      ...(value.power != null ? { power: value.power } : {}), ...(value.toughness != null ? { toughness: value.toughness } : {}),
    });
  }
  for (const child of Object.values(value)) if (child && typeof child === 'object') collectCards(child, cards);
  return cards;
}

function replayCoverage(replay) {
  const games = replay.games ?? [];
  let turns = 0, openingGames = 0, frames = 0, steps = 0, events = 0, finalLife = 0;
  for (const game of games) {
    const snapshots = Object.values(game.states ?? {});
    const gameSteps = game.steps ?? game.replay_steps ?? [];
    const observedTurns = new Set([...game.turns ?? [], ...snapshots, ...gameSteps]
      .map(value => value.turn_number ?? value.turn).filter(Number.isInteger));
    turns += observedTurns.size;
    openingGames += game.starting_hand?.length ? 1 : 0;
    frames += snapshots.length || gameSteps.filter(step => step.state).length;
    steps += gameSteps.length;
    events += (game.turns ?? []).reduce((count, turn) => count + (turn.events?.length ?? 0), 0);
    finalLife += Object.values(game.result?.life ?? {}).filter(value => typeof value === 'number').length;
  }
  return [games.length, turns, openingGames, frames, steps, events, finalLife];
}

function schemaParts(replay) { return String(replay.schema_version ?? '0').split('.').map(value => parseInt(value, 10) || 0); }
function compareParts(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

// Automatic imports may append evidence, never reinterpret an observed fact.
// Complex fragment reconciliation belongs in a separately reviewed operation.
function extendsKnown(candidate, previous) {
  if (previous === null || previous === undefined || previous === 'unknown') return true;
  if (Array.isArray(previous)) return Array.isArray(candidate) && candidate.length === previous.length &&
    previous.every((value, index) => extendsKnown(candidate[index], value));
  if (previous && typeof previous === 'object') return candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
    Object.entries(previous).every(([key, value]) => extendsKnown(candidate[key], value));
  return candidate === previous;
}
function extendsTimeline(candidate = [], previous = [], key) {
  if (!Array.isArray(candidate) || candidate.length < previous.length) return false;
  const keys = candidate.map(value => value?.[key]);
  const defined = keys.filter(value => value !== undefined);
  if (new Set(defined).size !== defined.length) return false;
  return previous.every((value, index) => keys[index] === value[key] && extendsKnown(candidate[index], value));
}
function gameExtends(candidate, previous) {
  const { states: oldStates, steps: oldSteps, replay_steps: oldReplaySteps, turns: oldTurns, result: oldResult, ...oldFacts } = previous;
  if (!extendsKnown(candidate, oldFacts) || !extendsKnown(candidate.states, oldStates) || !extendsKnown(candidate.result, oldResult)) return false;
  if (!extendsTimeline(candidate.steps, oldSteps, 'anchor') || !extendsTimeline(candidate.replay_steps, oldReplaySteps, 'anchor')) return false;
  if (!Array.isArray(candidate.turns ?? []) || (candidate.turns ?? []).length < (oldTurns ?? []).length) return false;
  const numbers = (candidate.turns ?? []).map(turn => turn.turn_number);
  if (new Set(numbers).size !== numbers.length) return false;
  return (oldTurns ?? []).every((turn, index) => {
    const next = candidate.turns[index], { events, ...facts } = turn;
    return extendsKnown(next, facts) && extendsTimeline(next?.events, events, 'sequence');
  });
}
function canReplace(candidate, existing) {
  if (compareParts(schemaParts(candidate), schemaParts(existing)) < 0) return false;
  const { games: oldGames = [], schema_version, ...oldFacts } = existing;
  if (!extendsKnown(candidate, oldFacts)) return false;
  const games = candidate.games ?? [], byNumber = new Map(games.map(game => [game.game_number, game]));
  if (byNumber.size !== games.length || games.some(game => !Number.isSafeInteger(game.game_number) || game.game_number < 1)) return false;
  let richer = games.length > oldGames.length;
  for (const previous of oldGames) {
    const next = byNumber.get(previous.game_number);
    if (!next || !gameExtends(next, previous)) return false;
    const before = replayCoverage({ games: [previous] }), after = replayCoverage({ games: [next] });
    if (after.some((count, index) => count < before[index])) return false;
    richer ||= after.some((count, index) => count > before[index]) ||
      (!previous.result?.outcome && Boolean(next.result?.outcome));
  }
  return richer;
}

/** Persist safe replay snapshots by stable match ID, independent of any analytics tables. */
export async function archiveReplays(replays, { dataDir = defaultDataDir(), replaceRevision } = {}) {
  const policyDir = dataDir.endsWith('/replay-outbox') ? join(dataDir, '..') : dataDir;
  const settings = await readReplaySettings(policyDir);
  const database = await openDatabase(dataDir, true);
  let archived = 0;
  let preserved = 0, conflicts = 0;
  const revisions = {};
  try {
    const upsert = database.prepare(`INSERT INTO replays VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id) DO UPDATE SET started_at=excluded.started_at,
      summary_json=excluded.summary_json, replay_json=excluded.replay_json, updated_at=excluded.updated_at`);
    const cardUpsert = database.prepare(`INSERT INTO cards VALUES (?, ?, ?)
      ON CONFLICT(arena_id) DO UPDATE SET name=excluded.name, metadata_json=excluded.metadata_json`);
    const previousReplay = database.prepare('SELECT replay_json, summary_json FROM replays WHERE match_id = ?');
    const excluded = database.prepare('SELECT 1 FROM excluded_replays WHERE match_id = ?');
    database.exec('BEGIN IMMEDIATE');
    for (const input of replays) {
      if (!input?.match?.id || typeof input.match.id !== 'string' || !input.match.started_at) throw new Error('Replay needs a stable match.id and started_at.');
      if (isTutorialMatch(input.match) || excluded.get(input.match.id) || !replayInRetention(input.match, settings)) { preserved++; continue; }
      const replay = safeArchive(input), now = new Date().toISOString();
      const replayJson = JSON.stringify(replay);
      const previous = previousReplay.get(replay.match.id);
      if (previous?.replay_json === replayJson) {
        revisions[replay.match.id] = historyEntry({ ...previous,
          notes_json: database.prepare('SELECT notes_json FROM coach_notes WHERE match_id=?').get(replay.match.id)?.notes_json }).replay_revision;
        preserved++; continue;
      }
      const replaceRemoteCopy = replaceRevision && previous &&
        historyEntry({ ...previous, notes_json: database.prepare('SELECT notes_json FROM coach_notes WHERE match_id=?').get(replay.match.id)?.notes_json }).replay_revision === replaceRevision;
      if (previous && !replaceRemoteCopy && !canReplace(replay, JSON.parse(previous.replay_json))) { preserved++; conflicts++; continue; }
      const summaryJson = JSON.stringify({ ...summary(replay), replay_revision: createHash('sha256').update(replayJson).digest('hex') });
      upsert.run(replay.match.id, replay.match.started_at, summaryJson, replayJson, now, now);
      revisions[replay.match.id] = historyEntry({ summary_json: summaryJson,
        notes_json: database.prepare('SELECT notes_json FROM coach_notes WHERE match_id=?').get(replay.match.id)?.notes_json }).replay_revision;
      for (const [id, card] of collectCards(replay)) cardUpsert.run(id, card.name, JSON.stringify(card));
      archived++;
    }
    database.exec('COMMIT');
    return { archived, preserved, conflicts, revisions, total: database.prepare('SELECT COUNT(*) AS total FROM replays').get().total, dbPath: dbPath(dataDir) };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* No transaction was started. */ }
    throw error;
  } finally { database.close(); }
}

/** Explicit local deletion persists an ID tombstone so retained logs cannot restore it. */
export async function excludeArchivedReplays(matchIds, { dataDir = defaultDataDir(), reason = 'user_deleted' } = {}) {
  if (!Array.isArray(matchIds) || matchIds.some(id => typeof id !== 'string' || !id)) throw new Error('Expected explicit match IDs.');
  if (!['user_deleted', 'tutorial'].includes(reason)) throw new Error('Invalid replay exclusion reason.');
  const database = await openDatabase(dataDir, true);
  try {
    database.exec('BEGIN IMMEDIATE');
    const mark = database.prepare('INSERT INTO excluded_replays VALUES (?, ?, ?) ON CONFLICT(match_id) DO NOTHING');
    const remove = database.prepare('DELETE FROM replays WHERE match_id = ?');
    const notes = database.prepare('DELETE FROM coach_notes WHERE match_id = ?');
    let deleted = 0;
    for (const id of new Set(matchIds)) {
      mark.run(id, reason, new Date().toISOString());
      deleted += Number(remove.run(id).changes); notes.run(id);
    }
    database.exec('COMMIT');
    return { deleted };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  finally { database.close(); }
}

export async function isReplayExcluded(matchId, { dataDir = defaultDataDir() } = {}) {
  if (typeof matchId !== 'string' || !matchId) return false;
  const database = await openDatabase(dataDir);
  if (!database) return false;
  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='excluded_replays'").get()) return false;
    return Boolean(database.prepare('SELECT 1 FROM excluded_replays WHERE match_id=?').get(matchId));
  } finally { database.close(); }
}

/** Acknowledge the exact published snapshot; retain a newer queued version. */
export async function acknowledgeReplayOutbox(replays, { dataDir }) {
  const database = await openDatabase(dataDir, true);
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const replay of replays) {
      const row = database.prepare('SELECT replay_json FROM replays WHERE match_id=?').get(replay.match.id);
      if (!row) continue;
      const { coachNotes: a, ...left } = JSON.parse(row.replay_json);
      const { coachNotes: b, ...right } = replay;
      if (JSON.stringify(left) === JSON.stringify(right)) database.prepare('DELETE FROM replays WHERE match_id=?').run(replay.match.id);
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  finally { database.close(); }
}

function historyEntry(row) {
  // Notes are stored separately to survive reimport. Their bytes also change
  // the Viewer revision, so automatic refresh cannot leave visible notes stale.
  const replay_revision = createHash('sha256').update(row.summary_json).update('\0').update(row.notes_json ?? '[]').digest('hex');
  return { ...JSON.parse(row.summary_json), updated_at: row.updated_at, replay_revision };
}

export async function listReplays({ dataDir = defaultDataDir(), limit = 100 } = {}) {
  const database = await openDatabase(dataDir);
  if (!database) return [];
  try {
    // Explicit null enumerates the whole canonical catalog for batch sync.
    // Viewer and ordinary callers retain their existing bounded list behavior.
    if (limit === null) return database.prepare('SELECT r.summary_json, r.updated_at, n.notes_json FROM replays r LEFT JOIN coach_notes n ON n.match_id = r.match_id ORDER BY r.started_at DESC, r.match_id DESC').all().map(historyEntry);
    const count = Math.max(1, Math.min(1000, Number.isInteger(limit) ? limit : 100));
    return database.prepare('SELECT r.summary_json, r.updated_at, n.notes_json FROM replays r LEFT JOIN coach_notes n ON n.match_id = r.match_id ORDER BY r.started_at DESC, r.match_id DESC LIMIT ?').all(count).map(historyEntry);
  } finally { database.close(); }
}

export async function getReplay(matchId, { dataDir = defaultDataDir() } = {}) {
  const database = await openDatabase(dataDir);
  if (!database) return null;
  try {
    const row = database.prepare('SELECT replay_json FROM replays WHERE match_id = ?').get(matchId);
    if (!row) return null;
    const replay = JSON.parse(row.replay_json);
    const notes = database.prepare('SELECT notes_json FROM coach_notes WHERE match_id = ?').get(matchId);
    replay.coachNotes = notes ? JSON.parse(notes.notes_json) : replay.coachNotes ?? [];
    return replay;
  } finally { database.close(); }
}

/** Read only the requested registered decks, not large replay snapshots. */
export async function listReplayDecks(matchIds, { dataDir = defaultDataDir(), cache = new Map() } = {}) {
  const database = await openDatabase(dataDir), decks = new Map();
  if (!database) return decks;
  try {
    const query = database.prepare("SELECT json_extract(replay_json, '$.deck') AS deck FROM replays WHERE match_id=?");
    const revision = database.prepare('SELECT updated_at FROM replays WHERE match_id=?');
    for (const id of new Set(matchIds)) {
      const key = dbPath(dataDir) + '\0' + id, updatedAt = revision.get(id)?.updated_at;
      if (!updatedAt) { cache.delete(key); continue; }
      const prior = cache.get(key);
      if (prior?.updatedAt === updatedAt) { decks.set(id, prior.deck); continue; }
      const raw = query.get(id)?.deck;
      if (typeof raw === 'string') { const deck = JSON.parse(raw); if (Array.isArray(deck)) {
        decks.set(id, deck); cache.set(key, { updatedAt, deck });
      } }
    }
    return decks;
  } finally { database.close(); }
}

export async function getLatestReplay(options = {}) {
  const [latest] = await listReplays({ ...options, limit: 1 });
  return latest ? getReplay(latest.id, options) : null;
}

export async function getArchivedCard(arenaId, { dataDir = defaultDataDir() } = {}) {
  const database = await openDatabase(dataDir);
  if (!database) return null;
  try {
    const row = database.prepare('SELECT metadata_json FROM cards WHERE arena_id = ?').get(arenaId);
    return row ? JSON.parse(row.metadata_json) : null;
  } finally { database.close(); }
}

/** Coach notes are separate from reparsed replay data so later imports cannot erase them. */
export async function saveCoachNotes(matchId, notes, { dataDir = defaultDataDir() } = {}) {
  if (!Array.isArray(notes)) throw new Error('Coach notes must be an array.');
  const database = await openDatabase(dataDir, true);
  try {
    if (!database.prepare('SELECT 1 FROM replays WHERE match_id = ?').get(matchId)) throw new Error('Unknown archived match.');
    database.prepare('INSERT INTO coach_notes VALUES (?, ?) ON CONFLICT(match_id) DO UPDATE SET notes_json=excluded.notes_json').run(matchId, JSON.stringify(notes));
  } finally { database.close(); }
}
