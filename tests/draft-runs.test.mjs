import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDraftRunIndex, listDraftRuns, saveDraftRunIndex } from '../src/draft-runs.mjs';
import { buildDraftPickIndex } from '../src/draft-picks.mjs';
import { createRecordFramer } from '../src/log-reader.mjs';
import { DatabaseSync } from 'node:sqlite';

function recordsFor(courses, matchId) {
  return [
    ...courses.map(course => ({ Course: course })),
    { matchGameRoomStateChangedEvent: { gameRoomInfo: { gameRoomConfig: {
      matchId, reservedPlayers: [{ systemSeatId: 1, eventId: 'QuickDraft_FRA' }],
    } } } },
    { greToClientEvent: { greToClientMessages: [{ type: 'GREMessageType_ConnectResp', systemSeatIds: [1] }] } },
  ];
}
function course(id, wins = 1, losses = 0) {
  return { CourseId: id, InternalEventName: 'QuickDraft_FRA', CurrentModule: 'Play', CurrentWins: wins, CurrentLosses: losses,
    CourseDeck: { MainDeck: [] }, CardPool: [] };
}

test('groups repeated draft event names by CourseId and validates recorded match score', () => {
  const history = [
    { id: 'match-a', event_id: 'QuickDraft', started_at: '2026-10-10T01:00:00Z', result: 'Win', game_count: 1 },
    { id: 'match-b', event_id: 'QuickDraft', started_at: '2026-10-10T02:00:00Z', result: 'Win', game_count: 1 },
  ];
  const runs = buildDraftRunIndex([
    ...recordsFor([course('course-a')], 'match-a'),
    ...recordsFor([course('course-b', 0, 1)], 'match-b'),
  ], history);
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].run_id, runs[1].run_id);
  assert.deepEqual(runs.map(run => run.matches[0].id).sort(), ['match-a', 'match-b']);
  assert.equal(runs.find(run => run.matches[0].id === 'match-a').score_verified, true);
  const mismatch = runs.find(run => run.matches[0].id === 'match-b');
  assert.equal(mismatch.score_verified, false);
  assert.equal(mismatch.status, 'incomplete');
});

test('log framer accepts only explicit draft packet and pick records', () => {
  const framer = createRecordFramer();
  assert.equal(framer.feed('{"DraftStatus":"PickNext","DraftPack":[10],"PackNumber":0,"PickNumber":0}').length, 1);
  framer.reset();
  assert.equal(framer.feed('{"CardId":10,"PackNumber":0,"PickNumber":0}').length, 1);
  framer.reset();
  assert.equal(framer.feed('{"ordinary":"record"}').length, 0);
});

test('draft pick capture requires a linked course and explicit packet, selection, indexes, and time', () => {
  const courseRecord = { Course: course('course-a') };
  const linkedRun = buildDraftRunIndex(recordsFor([course('course-a')], 'match-a'), [
    { id: 'match-a', event_id: 'QuickDraft', result: 'Win', game_count: 1 },
  ])[0].run_id;
  const records = [courseRecord,
    { DraftStatus: 'PickNext', DraftPack: [10, 11, 12], PackNumber: 0, PickNumber: 0,
      CourseId: 'course-a', Timestamp: '2026-10-10T00:00:00Z' },
    { CardId: 11, PackNumber: 0, PickNumber: 0, CourseId: 'course-a', Timestamp: '2026-10-10T00:00:00Z' },
  ];
  const [pick] = buildDraftPickIndex(records, { cardNames: new Map([[10, 'A'], [11, 'B'], [12, 'C']]) });
  assert.equal(pick.run_id, linkedRun);
  assert.deepEqual(pick.candidates.map(card => card.name), ['A', 'B', 'C']);
  assert.equal(pick.selected.name, 'B');
  assert.deepEqual(pick.pool_before, []);
  assert.deepEqual(pick.pool_after.map(card => card.arena_id), [11]);
  assert.equal(pick.complete, true);
  const unlinked = buildDraftPickIndex([{ DraftId: 'no-course-link', DraftPack: [1], PackNumber: 0, PickNumber: 0 }]);
  assert.deepEqual(unlinked, []);
});

test('does not attach a match when one snapshot has duplicate course IDs for its event', () => {
  const records = [{ Courses: [course('course-a'), course('course-b')] }, ...recordsFor([], 'match-a')];
  const runs = buildDraftRunIndex(records, [
    { id: 'match-a', event_id: 'QuickDraft', result: 'Win', game_count: 1 },
  ]);
  assert.deepEqual(runs, []);
});

test('three archived losses do not prove a missing course win counter is zero or that no win is missing', () => {
  const current = {...course('synthetic-unknown-wins',0,3),CurrentModule:'Complete'};
  delete current.CurrentWins;
  const history = Array.from({length:3},(_,i)=>({id:`synthetic-loss-${i}`,event_id:'QuickDraft_FRA',result:'Loss',game_count:1}));
  const build = () => buildDraftRunIndex(history.flatMap(match=>recordsFor([current],match.id)),history)[0];
  let run = build();
  assert.equal(run.replay_wins,0); assert.equal(run.replay_losses,3);
  assert.equal(run.course_wins,null); assert.equal(run.score_verified,false);
  // A fourth, unarchived win is consistent with the available evidence.
  current.CurrentWins = 1; run = build();
  assert.equal(run.course_wins,1); assert.equal(run.score_verified,false);
  current.CurrentWins = 0; run = build();
  assert.equal(run.score_verified,true,'only an explicit matching course counter confirms the full score');
});

test('sidecar persists locally and keeps a targeted backup before later updates', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'draft-run-index-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const run = { run_id: 'safe-id', event_id: 'QuickDraft_FRA', event: 'Quick Draft', started_at: '2026-10-10T00:00:00Z',
    current_module: 'Play', course_wins: 1, course_losses: 0, replay_wins: 1, replay_losses: 0,
    score_verified: true, status: 'in_progress', colors: ['W'], colors_complete: true, card_pool: [],
    matches: [{ id: 'match-a', started_at: '2026-10-10T00:00:00Z', result: 'Win', game_count: 1 }] };
  const pick = { run_id: 'safe-id', pack_number: 1, pick_number: 1, picked_at: '2026-10-10T00:00:00Z',
    candidates: [{ arena_id: 8, name: 'Card' }], selected: { arena_id: 8, name: 'Card' },
    pool_before: [], pool_after: [{ arena_id: 8, name: 'Card' }], complete: true, missing: [] };
  const first = await saveDraftRunIndex([run], { dataDir, picks: [pick] });
  assert.equal(first.backup, null);
  const stored = (await listDraftRuns({ dataDir }))[0];
  assert.equal(stored.matches[0].id, 'match-a'); assert.equal(stored.picks[0].selected.arena_id, 8);
  const second = await saveDraftRunIndex([run], { dataDir, picks: [pick] });
  assert.ok(second.backup);
  await stat(second.backup);
  const replayed = (await listDraftRuns({ dataDir }))[0];
  assert.equal(replayed.picks.length, 1, 're-reading a rotated/restarted log is idempotent');
  const broken = { ...pick, candidates: [] }; broken.candidates.push(broken);
  await assert.rejects(saveDraftRunIndex([{ ...run, replay_wins: 9 }], { dataDir, picks: [broken] }));
  assert.equal((await listDraftRuns({ dataDir }))[0].replay_wins, 1, 'failed save rolls back the whole transaction');
});

test('partial log imports retain members and read-time totals stay consistent without rewriting stored rows', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'draft-partial-log-'));
  t.after(() => rm(dataDir, {recursive:true,force:true}));
  const run = {run_id:'synthetic-run',event_id:'QuickDraft_FRA',event:'Quick Draft',started_at:null,
    current_module:'Complete',course_wins:1,course_losses:1,replay_wins:1,replay_losses:1,
    score_verified:true,status:'completed',colors:[],colors_complete:false,card_pool:[],
    matches:[{id:'synthetic-win',started_at:null,result:'Win',game_count:1},
      {id:'synthetic-loss',started_at:null,result:'Loss',game_count:1}]};
  await saveDraftRunIndex([run],{dataDir});
  await saveDraftRunIndex([{...run,matches:run.matches.slice(0,1),replay_losses:0,score_verified:false}],{dataDir});
  const db = new DatabaseSync(join(dataDir,'draft-runs.sqlite3'),{readOnly:true});
  t.after(() => db.close());
  const snapshot = () => JSON.stringify([db.prepare('SELECT * FROM draft_runs').all(),db.prepare('SELECT * FROM draft_run_matches').all()]);
  const before = snapshot(), [stored] = await listDraftRuns({dataDir});
  assert.equal(stored.matches.length,2);
  assert.equal(stored.replay_wins,1); assert.equal(stored.replay_losses,1);
  assert.equal(stored.score_verified,true); assert.equal(stored.status,'completed');
  assert.equal(snapshot(),before,'read projection must not repair stored rows');
  await saveDraftRunIndex([{...run,course_wins:2,matches:run.matches.slice(0,1)}],{dataDir});
  assert.equal((await listDraftRuns({dataDir}))[0].score_verified,false);
  await saveDraftRunIndex([{...run,matches:[{...run.matches[1],result:'Unknown'}]}],{dataDir});
  const [unknown] = await listDraftRuns({dataDir});
  assert.equal(unknown.matches.length,2); assert.equal(unknown.replay_losses,0); assert.equal(unknown.score_verified,false);
});
