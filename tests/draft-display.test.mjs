import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDraftDisplayRuns } from '../src/draft-display.mjs';
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const member = (id, account = A) => ({ id, account_key: account, result: 'Win',
  started_at: '2026-10-30T01:00:00Z', binding_evidence: 'course_context_and_main_deck' });
const course = (matches = [member('new')]) => ({ run_id: '1'.repeat(32), event_id: 'QuickDraft_FRA', account_key: A,
  card_pool: [{ arena_id: 1 }, { arena_id: 2 }], picks: [], matches, current_module: 'Complete', course_wins: 2, course_losses: 0 });
const capture = () => ({ ...course(), run_id: '2'.repeat(32), bound_run_id: '1'.repeat(32), capture_source: '17lands-local-log',
  binding: 'matched_pool', binding_account_status: 'matched', binding_method: 'exact_card_pool',
  matches: [member('old')], picks: [{ pack_number: 1, pick_number: 1 }], replay_wins: 1, replay_losses: 0 });

test('new verified members extend published captures without removing published members or picks', () => {
  const original = capture(), copy = structuredClone(original);
  const result = mergeDraftDisplayRuns([course()], [original], new Map([['old', A], ['new', A]]));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].matches.map(match => match.id).sort(), ['new', 'old']);
  assert.equal(result[0].replay_wins, 2); assert.equal(result[0].score_verified, true);
  assert.deepEqual(original, copy); assert.equal(result[0].picks, original.picks);
});

test('course-only matches remain visible when a published capture cannot be extended', () => {
  for (const mutate of [run => { run.binding = 'unresolved'; },
    run => { run.card_pool = [{ arena_id: 9 }]; },
    run => { run.account_key = B; run.binding_account_status = 'conflict'; }]) {
    const saved = capture(); mutate(saved);
    const result = mergeDraftDisplayRuns([course()], [saved], new Map([['old', A], ['new', A]]));
    assert.ok(result.some(run => run.matches.some(match => match.id === 'new') && run.account_key === A));
    assert.equal(saved.matches.length, 1);
  }
});

test('matching course id cannot import wrong-account or unverified members into a capture', () => {
  const saved = capture(), wrong = course([member('foreign', B), { ...member('unverified'), binding_evidence: undefined }]);
  const result = mergeDraftDisplayRuns([wrong], [saved], new Map([['old', A], ['foreign', B], ['unverified', A]]));
  assert.deepEqual(result.find(run => run.capture_source).matches.map(match => match.id), ['old']);
  const foreign = result.find(run => run.matches.some(match => match.id === 'foreign'));
  assert.equal(foreign.account_key, B);
  assert.ok(foreign.matches.every(match => match.id === 'foreign'));
});

test('same-course residual matches are retained instead of suppressed by an attached capture', () => {
  const saved = capture(), source = course([member('old'), member('new')]);
  source.card_pool = [{ arena_id: 7 }];
  const result = mergeDraftDisplayRuns([source], [saved], new Map([['old', A], ['new', A]]));
  assert.equal(result.filter(run => run.matches.some(match => match.id === 'old')).length, 1);
  assert.ok(result.some(run => run.matches.some(match => match.id === 'new')));
});
