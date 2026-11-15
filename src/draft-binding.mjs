import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDraftRunIndex } from './draft-runs.mjs';
import { validAccountKey } from './account-scope.mjs';

const fingerprint = ids => JSON.stringify([...ids.reduce((counts, id) =>
  counts.set(id, (counts.get(id) ?? 0) + 1), new Map())].sort((a, b) => a[0] - b[0]));
const positiveId = id => Number.isSafeInteger(id) && id > 0;
const isBasic = name => /^(?:Snow-Covered )?(?:Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(name ?? '');

/** Recorded Course context is a candidate link; independently verify its played
 * main deck and uniqueness before exposing it as a linked match. */
export function verifyDraftCourseMatches(courses, decks, ownership = new Map()) {
  const poolCounts = courses.map(course => {
    const counts = new Map();
    for (const card of course.card_pool) counts.set(card.arena_id, (counts.get(card.arena_id) ?? 0) + 1);
    return counts;
  });
  return courses.map((course, courseIndex) => {
    const matches = course.matches.flatMap(match => {
      const deck = decks.get(match.id), counts = new Map(); let total = 0;
      if (!Array.isArray(deck)) return [];
      for (const card of deck) {
        const quantity = card.quantity ?? card.Quantity ?? 1;
        if (!positiveId(card.arena_id) || !Number.isSafeInteger(quantity) || quantity <= 0) return [];
        total += quantity;
        if (!isBasic(card.name)) counts.set(card.arena_id, (counts.get(card.arena_id) ?? 0) + quantity);
      }
      if (total < 30 || counts.size < 8 || [...counts.values()].reduce((sum, n) => sum + n, 0) < 12) return [];
      const compatible = courses.map((other, i) => other.event_id === course.event_id &&
        [...counts].every(([id, count]) => (poolCounts[i].get(id) ?? 0) >= count) ? i : -1).filter(i => i >= 0);
      if (compatible.length !== 1 || compatible[0] !== courseIndex) return [];
      return [{ ...match, account_key: ownership.get(match.id) ?? null, binding_evidence: 'course_context_and_main_deck' }];
    });
    const wins = matches.filter(match => match.result === 'Win').length, losses = matches.filter(match => match.result === 'Loss').length;
    const scoreVerified = matches.length > 0 && matches.every(match => ['Win', 'Loss', 'Draw'].includes(match.result)) &&
      course.course_wins === wins && course.course_losses === losses;
    const keys = new Set(matches.map(match => match.account_key));
    return { ...course, matches, replay_wins: wins, replay_losses: losses, score_verified: scoreVerified,
      account_key: keys.size === 1 && validAccountKey([...keys][0]) ? [...keys][0] : null,
      rejected_match_count: course.matches.length - matches.length };
  });
}

/** Partial recent logs must not drop already archived members of the same course. */
export function mergeDraftCourse(previous, next) {
  if (!previous) return next;
  const matches = [...new Map([...previous.matches, ...next.matches].map(match => [match.id, match])).values()]
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at) || a.id.localeCompare(b.id));
  const wins = matches.filter(match => match.result === 'Win').length, losses = matches.filter(match => match.result === 'Loss').length;
  const courseWins = next.course_wins ?? previous.course_wins, courseLosses = next.course_losses ?? previous.course_losses;
  const scoreVerified = matches.length > 0 && matches.every(match => ['Win', 'Loss', 'Draw'].includes(match.result)) &&
    courseWins === wins && courseLosses === losses;
  const module = String(next.current_module ?? previous.current_module ?? '').toLowerCase();
  return { ...previous, ...next, matches, replay_wins: wins, replay_losses: losses,
    course_wins: courseWins, course_losses: courseLosses, score_verified: scoreVerified,
    card_pool: next.card_pool.length ? next.card_pool : previous.card_pool,
    status: !scoreVerified ? 'incomplete' : /complete|finish|claim|reward|end/.test(module) ? 'completed'
      : /draft|play|match|active/.test(module) ? 'in_progress' : 'incomplete' };
}

/** Only a complete observed three-pack draft can prove equality with a course pool. */
export function completeDraftPool(run) {
  const picks = [...run.picks].sort((a, b) => a.pack_number - b.pack_number || a.pick_number - b.pick_number);
  const pool = [];
  for (const pack of [1, 2, 3]) {
    const hands = picks.filter(pick => pick.pack_number === pack), size = hands[0]?.candidates.length;
    if (!size || hands.length !== size) return null;
    for (let i = 0; i < hands.length; i++) {
      const pick = hands[i];
      if (!pick.complete || pick.missing?.length || pick.pick_number !== i + 1 ||
        pick.candidates.length !== size - i || !positiveId(pick.selected?.arena_id) ||
        !pick.candidates.some(card => card.arena_id === pick.selected.arena_id)) return null;
      pool.push(pick.selected.arena_id);
    }
  }
  return picks.length === pool.length ? pool : null;
}

/** Relationship evidence never changes capture ownership, saved picks or match ownership. */
export function bindDraftCaptures(captures, courses) {
  const bound = captures.map(capture => {
    const pool = completeDraftPool(capture);
    if (!pool) return { ...capture, binding: 'unresolved', binding_reason: 'incomplete_picks' };
    const key = fingerprint(pool);
    const candidates = courses.filter(course => course.event_id === capture.event_id &&
      course.card_pool.length === pool.length && course.card_pool.every(card => positiveId(card.arena_id)) &&
      fingerprint(course.card_pool.map(card => card.arena_id)) === key);
    if (candidates.length !== 1) return { ...capture, binding: 'unresolved',
      binding_reason: candidates.length ? 'ambiguous_courses' : 'missing_course' };
    const course = candidates[0];
    if (!course.matches.length) return { ...capture, binding: 'unresolved', binding_reason: 'missing_matches' };
    const accountStatus = validAccountKey(capture.account_key) && validAccountKey(course.account_key)
      ? capture.account_key === course.account_key ? 'matched' : 'conflict' : 'unknown';
    return { ...course, ...capture,
      binding: 'matched_pool', binding_method: 'exact_card_pool', binding_reason: null,
      bound_run_id: course.run_id, binding_card_count: pool.length,
      binding_account_status: accountStatus, binding_account_key: course.account_key ?? null,
      current_module: course.current_module, status: course.status, score_verified: course.score_verified,
      course_wins: course.course_wins, course_losses: course.course_losses,
      replay_wins: course.replay_wins, replay_losses: course.replay_losses,
      matches: course.matches, card_pool: course.card_pool,
    };
  });
  // Tracker restarts can replay the exact same selection. Show the newest capture
  // once per bound course/account. For unresolved partial captures, use the
  // event/account plus the exact observed pick sequence; this collapses a
  // quit/reopen replay without merging a different pick sequence.
  const unique = new Map(), output = [];
  for (const run of bound.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || a.run_id.localeCompare(b.run_id))) {
    const selectionSignature = JSON.stringify((run.picks ?? []).map(pick =>
      [pick.pack_number, pick.pick_number, pick.selected?.arena_id ?? null,
        (pick.candidates ?? []).map(card => card.arena_id),
        Boolean(pick.complete), [...(pick.missing ?? [])].sort()]));
    const key = run.binding === 'matched_pool'
      ? `${run.account_key ?? 'unassigned'}:${run.bound_run_id}:${selectionSignature}`
      : `${run.account_key ?? 'unassigned'}:${run.event_id}:${selectionSignature}`;
    const previous = unique.get(key);
    if (previous) previous.capture_run_ids.push(run.run_id);
    else { const value = { ...run, capture_run_ids: [run.run_id] }; unique.set(key, value); output.push(value); }
  }
  return output;
}

/** Read the ingestion cache's course/config/connection records, never replay blobs
 * or original logs. A changed SQLite/WAL or history identity invalidates the cache. */
export async function recentDraftCourses(history, { dataDir, cache }) {
  const path = join(dataDir, 'replay-ingest.sqlite3'), parts = [];
  for (const file of [path, `${path}-wal`]) {
    try {
      const info = await lstat(file, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) throw Error('Invalid draft evidence store');
      parts.push([String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs)]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (file === path) return [];
      parts.push(null);
    }
  }
  const signature = createHash('sha256').update(JSON.stringify([parts, history.map(match =>
    [match.id, match.account_key, match.started_at, match.event_id ?? match.event, match.result, match.game_count])])).digest('hex');
  if (cache.signature === signature) return cache.courses;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const records = db.prepare(`SELECT json FROM records WHERE match_id IS NULL
      OR json_type(json,'$.matchGameRoomStateChangedEvent') IS NOT NULL
      OR json LIKE '%GREMessageType_ConnectResp%' ORDER BY sequence`).all().map(row => JSON.parse(row.json));
    const courses = buildDraftRunIndex(records, history);
    cache.signature = signature; cache.courses = courses;
    return courses;
  } finally { db.close(); }
}
