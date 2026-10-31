import test from 'node:test';
import assert from 'node:assert/strict';
import type { DraftPick, DraftRun } from '../src/types/game.ts';
import { countedDraftPool, draftPickIndex, draftPickKey, draftPickWarning, draftPoolIsPartial, orderedDraftPicks, visibleDraftRuns, draftBindingLabel, selectedCardManaValue, selectedCardColumns } from '../src/lib/draftReplay.ts';

const a = { arena_id: 1, name: 'A' }, b = { arena_id: 2, name: 'B' };
test('selected cards sort printed front-face mana costs left to right and retain duplicate copies', () => {
  assert.equal(selectedCardManaValue('{2}{U}'), 3);
  assert.equal(selectedCardManaValue('{X}{G}'), 1);
  assert.equal(selectedCardManaValue('{2/W}{W/P}'), 3);
  assert.equal(selectedCardManaValue('{1}{U} // {5}{U}'), 2);
  assert.equal(selectedCardManaValue(''), 0);
  assert.equal(selectedCardManaValue(undefined), null);
  assert.equal(selectedCardManaValue('unknown'), null);
  const c = { arena_id: 3, name: 'C' }, d = { arena_id: 4, name: 'D' };
  const source = [a, b, a, c, d], metadata = new Map([[1, { mana_cost: '{3}{U}' }], [2, { mana_cost: '{U}' }], [3, { mana_cost: '' }]]);
  const columns = selectedCardColumns(source, metadata);
  assert.deepEqual(columns.map(column => column.cost), [0, 1, 4, null]);
  assert.equal(columns[2].cards[0].count, 2);
  assert.equal(columns.flatMap(column => column.cards).reduce((sum, card) => sum + card.count, 0), source.length);
  assert.deepEqual(source.map(card => card.arena_id), [1, 2, 1, 3, 4]);
});
test('matched relationship, account conflict and unverified totals have separate labels', () => {
  const run = { capture_source: '17lands-local-log', binding: 'matched_pool', binding_account_status: 'matched',
    replay_wins: 7, replay_losses: 2, score_verified: true } as DraftRun;
  assert.equal(draftBindingLabel(run), '已关联 · 7胜 2负');
  assert.match(draftBindingLabel({ ...run, binding_account_status: 'conflict' }), /对战已关联.*账号待核对/);
  assert.match(draftBindingLabel({ ...run, score_verified: false }), /归档/);
  assert.match(draftBindingLabel({ ...run, binding: 'unresolved', binding_reason: 'ambiguous_courses' }), /多个赛事吻合/);
});
function pick(pack: number, number: number, changes: Partial<DraftPick> = {}): DraftPick {
  return { pack_number: pack, pick_number: number, picked_at: null, candidates: [a, b],
    selected: b, pool_before: [], pool_after: [b], complete: true, missing: [], ...changes };
}

test('merged sources hide zero-pick runs and sort by actual time with unknown times last', () => {
  const run = (id: string, time: string | null, picks = [pick(1, 1)]) =>
    ({ run_id: id, started_at: time, picks }) as DraftRun;
  const input = [
    run('legacy', '2026-10-14T13:38:14Z'),
    run('no-picks', '2026-10-31T00:00:00Z', []),
    run('unknown', null), run('invalid-time', 'invalid'),
    run('offset', '2026-10-30T09:07:44+08:00'),
    run('utc', '2026-10-30T01:15:00Z'),
    run('invalid-hand', '2026-10-31T01:00:00Z', [pick(0, 0)]),
  ];
  const original = input.slice();
  assert.deepEqual(visibleDraftRuns(input).map(run => run.run_id),
    ['utc', 'offset', 'legacy', 'invalid-time', 'unknown']);
  assert.deepEqual(input, original);
});

test('navigation sorts actual observations without filling missing hands or changing source order', () => {
  const input = [pick(2, 1), pick(1, 3), pick(1, 1), pick(0, 4)];
  const ordered = orderedDraftPicks(input);
  assert.deepEqual(ordered.map(draftPickKey), ['1-1', '1-3', '2-1']);
  assert.deepEqual(input.map(draftPickKey), ['2-1', '1-3', '1-1', '0-4']);
  assert.equal(draftPickIndex(ordered, '1-3'), 1);
  // A poll inserting an earlier record preserves the selected pack/pick identity.
  assert.equal(draftPickIndex(orderedDraftPicks([...input, pick(1, 2)]), '1-3'), 2);
  assert.equal(draftPickIndex([], '1-1'), 0);
});

test('pool display preserves duplicate quantities and never invents extra cards', () => {
  const input = [b, a, b, b];
  assert.deepEqual(countedDraftPool(input), [{ ...b, count: 3 }, { ...a, count: 1 }]);
  assert.equal(input.length, 4);
  assert.deepEqual(countedDraftPool([]), []);
});

test('missing candidates, mismatched selections and incomplete pools remain explicit', () => {
  assert.equal(draftPickWarning(pick(1, 1)), null);
  assert.match(draftPickWarning(pick(1, 3, { candidates: [], complete: false, missing: ['prior_pick', 'candidate_pack'] }))!, /缺少候选包.*记录不完整.*此前有漏手/);
  assert.match(draftPickWarning(pick(1, 1, { selected: { arena_id: 9, name: 'Outside pack' } }))!, /未出现在候选包/);
  assert.match(draftPickWarning(pick(1, 1, { selected: null }))!, /缺少实际选择/);
  assert.match(draftPickWarning(pick(1, 1, { complete: false, missing: ['conflicting_observations'] }))!, /来源记录互相冲突/);
});

test('later locally complete picks never erase an earlier gap in the pool', () => {
  const picks = [pick(1, 1), pick(1, 3, { complete: false }), pick(1, 4)];
  assert.equal(draftPoolIsPartial(picks, 0), false);
  assert.equal(draftPoolIsPartial(picks, 2), true);
  assert.match(draftPickWarning(picks[2], draftPoolIsPartial(picks, 2))!, /此前的记录不完整/);
  assert.equal(draftPoolIsPartial([pick(1, 2)], 0), true);
  assert.equal(draftPoolIsPartial([pick(1, 1), pick(1, 3)], 1), true);
  assert.equal(draftPoolIsPartial([pick(1, 1), pick(1, 2)], 1), false);
});
