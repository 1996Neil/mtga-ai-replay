import test from 'node:test';
import assert from 'node:assert/strict';
import type { DraftDeckCard } from '../src/lib/draftDecks.ts';
import type { DraftRun } from '../src/types/game.ts';
import { deckCardCount, deckRows, deckManaColumns, deckDifferenceCount, parseDraftDeckResponse, draftDeckInputKey, draftDeckSelectionFinished } from '../src/lib/draftDecks.ts';

const card = (id: number, category: DraftDeckCard['category'], cost: number | null, quantity = 1): DraftDeckCard =>
  ({ arena_id: id, name: 'Synthetic ' + id, key: 'arena:' + id, category, mana_value: cost, quantity, mana_cost: null, type_line: '' });
test('deck layout has only creature and other rows, preserves all quantities and orders costs left to right', () => {
  const cards = [card(1, 'land', 0, 17), card(2, 'instant', 1), card(3, 'creature', 5), card(4, 'creature', 2, 2), card(5, 'planeswalker', 3), card(6, 'artifact', null)];
  assert.deepEqual(deckRows(cards).map(row => [row.category, row.count]), [['creature', 3], ['other', 20]]);
  assert.equal(deckRows(cards).flatMap(row => row.cards).length, cards.length);
  assert.deepEqual(deckManaColumns(cards), [0, 1, 2, 3, 5, null]);
  assert.equal(deckCardCount(cards), 23);
  assert.equal(deckDifferenceCount({ added: [card(1, 'land', 0, 2)], removed: [card(2, 'creature', 2)] }), 2);
});
test('deckbuilding becomes available after selecting three complete packs before event play finishes', () => {
  const run = { status: 'in_progress', picks: [1, 2, 3].map(pack => ({
    pack_number: pack, pick_number: 1, candidates: [{ arena_id: pack, name: 'Synthetic' }],
    selected: { arena_id: pack, name: 'Synthetic' }, pool_before: [], pool_after: [],
    complete: true, missing: [], picked_at: null,
  })) } as unknown as DraftRun;
  assert.equal(draftDeckSelectionFinished(run), true);
  assert.equal(draftDeckSelectionFinished({ ...run, picks: run.picks.slice(0, 2) }), false);
  assert.equal(draftDeckSelectionFinished({ ...run, picks: run.picks.map((pick, i) => ({ ...pick, complete: i !== 1 })) }), false);
});
test('a response cannot cross accounts or runs, and a stale recommendation is hidden while actual versions remain', () => {
  const run = { run_id: 'b'.repeat(32), event_id: 'Synthetic', picks: [], matches: [] } as unknown as DraftRun;
  const account = 'a'.repeat(64), cards = [card(1, 'land', 0, 40)];
  const response = { run_id: run.run_id, account_key: account, status: 'ready', finished: true, recommendation_status: 'ready',
    recommendation: { title: 'Synthetic', plan: 'Synthetic', choices: [], cards }, versions: [] };
  assert.equal(parseDraftDeckResponse(response, run, account).recommendation?.cards[0].quantity, 40);
  assert.throws(() => parseDraftDeckResponse(response, run, 'c'.repeat(64)));
  assert.throws(() => parseDraftDeckResponse({ ...response, run_id: 'd'.repeat(32) }, run, account));
  assert.equal(parseDraftDeckResponse({ ...response, recommendation_status: 'stale' }, run, account).recommendation, null);
  assert.throws(() => parseDraftDeckResponse({ ...response, recommendation: { ...response.recommendation, cards: [card(1, 'land', 0, 39)] } }, run, account));
  assert.notEqual(draftDeckInputKey(run, account), draftDeckInputKey({ ...run, matches: [{ id: 'new' }] } as DraftRun, account));
  const observed = { ...run, picks: [{ pack_number: 1, pick_number: 1, selected: { arena_id: 1, name: 'A' },
    candidates: [{ arena_id: 1, name: 'A' }], pool_before: [], pool_after: [{ arena_id: 1, name: 'A' }], complete: true, missing: [], picked_at: null }] };
  const repaired = structuredClone(observed); repaired.picks[0].pool_before.push({ arena_id: 2, name: 'B' });
  assert.notEqual(draftDeckInputKey(observed, account), draftDeckInputKey(repaired, account));
  assert.notEqual(draftDeckInputKey(observed, account), draftDeckInputKey({ ...observed, event_id: 'another-event' }, account));
});
