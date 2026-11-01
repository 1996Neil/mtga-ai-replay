import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { completeDraftPool, bindDraftCaptures, recentDraftCourses, mergeDraftCourse, verifyDraftCourseMatches } from '../src/draft-binding.mjs';
import { archiveReplays } from '../src/history.mjs';
import { startReplayServer } from '../src/server.mjs';
import { linkText, linkDigest } from '../src/draft-link-contract.mjs';
import { saveDraftRunIndex } from '../src/draft-runs.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), event = 'QuickDraft_SYNTHETIC';
const card = arena_id => ({ arena_id, name: `Synthetic ${arena_id}` });
function capture(id = 'capture-one', account_key = A) {
  const pool = [], picks = [];
  for (const [pack, candidates] of [[1, [10, 11]], [2, [10, 21]], [3, [30, 31]]]) {
    for (let i = 0; i < candidates.length; i++) {
      const before = pool.map(card); pool.push(candidates[i]);
      picks.push({ pack_number: pack, pick_number: i + 1, candidates: candidates.slice(i).map(card), selected: card(candidates[i]),
        pool_before: before, pool_after: pool.map(card), complete: true, missing: [] });
    }
  }
  return { run_id: id, account_key, event_id: event, event, capture_source: '17lands-local-log', binding: 'unresolved',
    started_at: '2026-10-30T12:00:00+08:00', matches: [], picks, card_pool: [] };
}
function course(id = 'course-one', account_key = A) {
  return { run_id: id, account_key, event_id: event, event, card_pool: [10, 11, 10, 21, 30, 31].map(card),
    matches: [{ id: 'match-one', result: 'Win', started_at: '2026-10-30T03:00:00Z', game_count: 1 }],
    replay_wins: 1, replay_losses: 0, course_wins: 1, course_losses: 0, score_verified: true,
    status: 'completed', current_module: 'Complete' };
}
function expandedCapture() {
  const run = capture(), pool = [], picks = [];
  for (const pack of [1, 2, 3]) {
    const cards = Array.from({ length: 14 }, (_, i) => 1000 + pack * 100 + i);
    for (let i = 0; i < cards.length; i++) {
      const before = pool.map(card); pool.push(cards[i]);
      picks.push({ pack_number: pack, pick_number: i + 1, candidates: cards.slice(i).map(card), selected: card(cards[i]),
        pool_before: before, pool_after: pool.map(card), complete: true, missing: [] });
    }
  }
  return { ...run, picks };
}

test('stale course context cannot attach an unrelated match without a unique corroborating full main deck', () => {
  const pool = completeDraftPool(expandedCapture()).map(card), c = { ...course(), card_pool: pool };
  const deck = [...pool.slice(0, 23).map(card => ({ ...card, quantity: 1 })), { arena_id: 99999, name: 'Forest', quantity: 17 }];
  const good = verifyDraftCourseMatches([c], new Map([['match-one', deck]]), new Map([['match-one', B]]));
  assert.equal(good[0].matches.length, 1); assert.equal(good[0].matches[0].account_key, B);
  const wrong = structuredClone(deck); wrong[0].arena_id = 999;
  assert.equal(verifyDraftCourseMatches([c], new Map([['match-one', wrong]]))[0].matches.length, 0);
  assert.equal(verifyDraftCourseMatches([c], new Map())[0].matches.length, 0);
  assert.equal(verifyDraftCourseMatches([c], new Map([['match-one', deck.slice(0, 10)]]))[0].matches.length, 0);
  const other = { ...c, run_id: 'different-course', matches: [] };
  assert.equal(verifyDraftCourseMatches([c, other], new Map([['match-one', deck]]))[0].matches.length, 0,
    'same deck fits two recorded course pools; missing members cannot create false uniqueness');
});

test('complete selected multiset binds a unique course independently of receipt time', () => {
  const input = capture(), original = structuredClone(input);
  const [bound] = bindDraftCaptures([input], [course()]);
  assert.equal(bound.binding, 'matched_pool'); assert.equal(bound.bound_run_id, 'course-one');
  assert.equal(bound.binding_card_count, 6); assert.equal(bound.replay_wins, 1);
  assert.equal(bound.matches[0].id, 'match-one'); assert.equal(bound.binding_account_status, 'matched');
  assert.deepEqual(input, original); assert.equal(bound.started_at, input.started_at);
});

test('duplicate counts, complete observations and uniqueness are required, not just same color/event or deck subset', () => {
  const changed = course(); changed.card_pool = [10, 11, 11, 21, 30, 31].map(card);
  assert.equal(bindDraftCaptures([capture()], [changed])[0].binding_reason, 'missing_course');
  assert.equal(bindDraftCaptures([capture()], [course(), course('second')])[0].binding_reason, 'ambiguous_courses');
  const broken = capture(); broken.picks.splice(1, 1);
  assert.equal(completeDraftPool(broken), null);
  assert.equal(bindDraftCaptures([broken], [course()])[0].binding_reason, 'incomplete_picks');
  const unsupported = capture(); unsupported.picks[2].complete = false;
  assert.equal(completeDraftPool(unsupported), null);
  const missingMatch = course(); missingMatch.matches = [];
  assert.equal(bindDraftCaptures([capture()], [missingMatch])[0].binding_reason, 'missing_matches');
});

test('record relationship is retained across conflicting/unknown accounts without changing ownership', () => {
  const [conflict] = bindDraftCaptures([capture()], [course('course-one', B)]);
  assert.equal(conflict.binding, 'matched_pool'); assert.equal(conflict.binding_account_status, 'conflict');
  assert.equal(conflict.account_key, A); assert.equal(conflict.binding_account_key, B);
  const [unknown] = bindDraftCaptures([capture('unknown', null)], [course()]);
  assert.equal(unknown.binding, 'matched_pool'); assert.equal(unknown.binding_account_status, 'unknown');
  assert.equal(unknown.account_key, null);
});

test('replayed capture segments collapse within one bound course/account without multiplying matches', () => {
  const older = capture('older'); older.started_at = '2026-10-29T10:00:00+08:00';
  const bound = bindDraftCaptures([older, capture('newer'), capture('other-account', B)], [course()]);
  assert.equal(bound.length, 2);
  const sameAccount = bound.find(run => run.account_key === A);
  assert.equal(sameAccount.run_id, 'newer');
  assert.deepEqual(sameAccount.capture_run_ids, ['newer', 'older']);
  assert.equal(sameAccount.matches.length, 1);
});

test('partial course refresh retains already archived members and recomputes score', () => {
  const previous = course(); previous.matches[0].result = 'Loss';
  const next = course(); next.matches = [{ id: 'later', result: 'Win', started_at: '2026-10-30T04:00:00Z' }];
  next.course_losses = 1;
  const merged = mergeDraftCourse(previous, next);
  assert.equal(merged.matches.length, 2);
  assert.deepEqual([merged.replay_wins, merged.replay_losses, merged.score_verified], [1, 1, true]);
});

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'draft-binding-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const viewerDir = join(dataDir, 'viewer'); await mkdir(viewerDir); await writeFile(join(viewerDir, 'index.html'), 'Synthetic');
  const db = new DatabaseSync(join(dataDir, 'replay-ingest.sqlite3'));
  db.exec('CREATE TABLE records(sequence INTEGER PRIMARY KEY,match_id TEXT,json TEXT);');
  const add = db.prepare('INSERT INTO records(match_id,json) VALUES (?,?)');
  add.run(null, JSON.stringify({ Course: { CourseId: 'synthetic-course', InternalEventName: event, CurrentModule: 'Complete',
    CurrentWins: 1, CurrentLosses: 0, CardPool: completeDraftPool(expandedCapture()) } }));
  add.run('match-one', JSON.stringify({ matchGameRoomStateChangedEvent: { gameRoomInfo: { gameRoomConfig: {
    matchId: 'match-one', reservedPlayers: [{ systemSeatId: 1, eventId: event }] } } } }));
  add.run(null, JSON.stringify({ greToClientEvent: { greToClientMessages: [{ type: 'GREMessageType_ConnectResp', systemSeatIds: [1] }] } }));
  db.close();
  return { dataDir, viewerDir };
}

test('ingestion evidence reconstructs recent course missing from old sidecar and caches unchanged reads', async t => {
  const options = await fixture(t), cache = {};
  const history = [{ id: 'match-one', event_id: event, account_key: A, started_at: '2026-10-30T03:00:00Z', result: 'Win' }];
  const courses = await recentDraftCourses(history, { ...options, cache });
  assert.equal(courses.length, 1); assert.equal(courses[0].card_pool.length, 42);
  assert.equal(courses[0].matches[0].id, 'match-one');
  assert.equal(await recentDraftCourses(history, { ...options, cache }), courses);
});

test('HTTP exposes matched course, score and match links without rewriting capture records', async t => {
  const options = await fixture(t);
  await archiveReplays([{ match: { id: 'match-one', event_id: event, account_key: A, started_at: '2026-10-30T03:00:00Z', result: 'Win' },
    games: [], deck: [...completeDraftPool(expandedCapture()).slice(0, 23).map(id => ({ ...card(id), quantity: 1 })),
      { arena_id: 99999, name: 'Forest', quantity: 17 }] }], options);
  const db = new DatabaseSync(join(options.dataDir, 'draft-capture.sqlite3'));
  db.exec('CREATE TABLE observations(seq INTEGER PRIMARY KEY,observation_id TEXT,body TEXT); CREATE TABLE gaps(gap_id TEXT,reason TEXT); CREATE TABLE accounts(account_key TEXT,label TEXT); CREATE TABLE meta(key TEXT,value TEXT);');
  const ids = []; let n = 0;
  for (const pick of expandedCapture().picks) for (const kind of ['pack', 'pick']) {
    const id = (++n).toString(16).padStart(64, '0'); ids.push(id);
    db.prepare('INSERT INTO observations(observation_id,body) VALUES (?,?)').run(id, JSON.stringify({
      account_key: A, kind, event_id: event, pack_number: pick.pack_number, pick_number: pick.pick_number,
      card_ids: (kind === 'pack' ? pick.candidates : [pick.selected]).map(card => card.arena_id),
      logged_at: '2026-10-30T12:00:00+08:00' }));
  }
  db.close();
  await mkdir(join(options.dataDir, 'draft-sync'));
  await writeFile(join(options.dataDir, 'draft-sync/published.json'), JSON.stringify({ verified: true, revision: 'a'.repeat(40), observation_ids: ids }));
  const server = await startReplayServer({ ...options, observeLocalLogs: false, displayNamesZh: new Map(), cardNames: new Map([[10, 'Synthetic']]) });
  t.after(() => server.close());
  const result = await fetch(server.url + 'api/draft-runs?account=' + A).then(r => r.json());
  assert.equal(result.length, 1); assert.equal(result[0].binding, 'matched_pool');
  assert.equal(result[0].matches[0].id, 'match-one'); assert.equal(result[0].replay_wins, 1);
  assert.equal(result[0].account_key, A);
  const empty = await fetch(server.url + 'api/draft-runs?account=' + B).then(r => r.json());
  assert.deepEqual(empty, []);
});

test('an older published snapshot cannot hide new local courses or their later matches', async t => {
  const options = await fixture(t), deck = [...completeDraftPool(expandedCapture()).slice(0, 23).map(id => ({ ...card(id), quantity: 1 })),
    { arena_id: 99999, name: 'Forest', quantity: 17 }];
  const replay = (id, time) => ({ match: { id, event_id: event, account_key: A, started_at: time, result: 'Win' }, games: [], deck });
  await archiveReplays([replay('match-one', '2026-10-30T03:00:00Z')], options);
  await mkdir(join(options.dataDir, 'draft-sync'));
  const index = { schema: 'MTGA_DRAFT_ACCOUNTS_V2', accounts: [] }, content_hash = linkDigest(linkText(index)), revision = 'a'.repeat(40);
  await writeFile(join(options.dataDir, 'draft-sync/published-bindings.json'), JSON.stringify({
    schema: 'MTGA_PUBLISHED_DRAFT_BINDINGS_V1', revision, content_hash, index, documents: {} }));
  await writeFile(join(options.dataDir, 'draft-sync/published.json'), JSON.stringify({
    verified: true, revision, content_hash, observation_ids: [] }));
  const server = await startReplayServer({ ...options, writeInfo: false, observeLocalLogs: false,
    enableReplaySync: false, enableCollection: false, displayNamesZh: new Map(), cardNames: new Map([[10, 'Synthetic']]) });
  t.after(() => server.close());
  const read = account => fetch(server.url + 'api/draft-runs?account=' + account).then(r => r.json());
  const first = await read(A);
  assert.equal(first.length, 1); assert.deepEqual(first[0].matches.map(m => m.id), ['match-one']);
  assert.deepEqual(first[0].picks, []);
  assert.deepEqual(await read(B), []);
  const warm = server.workCounters();
  for (let i = 0; i < 3; i++) await read(A);
  assert.deepEqual(server.workCounters(), warm, 'idle reads reuse the composed catalog');
  const db = new DatabaseSync(join(options.dataDir, 'replay-ingest.sqlite3'));
  db.prepare('INSERT INTO records(match_id,json) VALUES (?,?)').run('match-two', JSON.stringify({
    matchGameRoomStateChangedEvent: { gameRoomInfo: { gameRoomConfig: {
      matchId: 'match-two', reservedPlayers: [{ systemSeatId: 1, eventId: event }] } } } }));
  db.prepare('INSERT INTO records(match_id,json) VALUES (?,?)').run(null, JSON.stringify({
    greToClientEvent: { greToClientMessages: [{ type: 'GREMessageType_ConnectResp', systemSeatIds: [1] }] } }));
  db.close();
  await archiveReplays([replay('match-two', '2026-10-30T04:00:00Z')], options);
  const next = await read(A);
  assert.equal(next.length, 1);
  assert.deepEqual(next[0].matches.map(m => m.id), ['match-one', 'match-two']);
  assert.equal(server.workCounters().draft_loads, warm.draft_loads + 1);
  await read(A);
  assert.equal(server.workCounters().draft_loads, warm.draft_loads + 1, 'retry does not recompose an unchanged course');
});

test('a pool retained outside recent logs still prevents an ambiguous new match link', async t => {
  const options = await fixture(t);
  const pool = completeDraftPool(expandedCapture()).map(card);
  await saveDraftRunIndex([{ ...course('f'.repeat(32)), started_at: '2026-10-29T00:00:00Z',
    colors: [], colors_complete: false, card_pool: pool, matches: [] }], options);
  await archiveReplays([{ match: { id: 'match-one', event_id: event, account_key: A,
    started_at: '2026-10-30T03:00:00Z', result: 'Win' }, games: [],
    deck: [...pool.slice(0, 23).map(card => ({ ...card, quantity: 1 })), { arena_id: 99999, name: 'Forest', quantity: 17 }] }], options);
  const server = await startReplayServer({ ...options, observeLocalLogs: false, writeInfo: false,
    enableReplaySync: false, enableCollection: false, displayNamesZh: new Map(), cardNames: new Map([[10, 'Synthetic']]) });
  t.after(() => server.close());
  const runs = await fetch(server.url + 'api/draft-runs?account=' + A).then(response => response.json());
  assert.ok(!runs.some(run => run.matches.some(match => match.id === 'match-one')),
    'a second saved pool makes the recent course insufficient to prove the assignment');
  assert.equal((await fetch(server.url + 'api/matches?account=' + A).then(response => response.json())).length, 1);
});
