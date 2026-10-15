import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCard, normalizeReplay, normalizeState, normalizeHistory, coachContext } from '../src/lib/canonicalAdapter.ts';
import { useReplayStore } from '../src/store/replayStore.ts';

function fixture() {
  const moose = { name: 'Galewind Moose', arena_id: 5, instance_id: 100, visibility: 'player_known', card_types: ['Creature'], power: 6, toughness: 6 };
  const stoneglider = { name: 'Soaring Stoneglider', arena_id: 6, instance_id: 200, visibility: 'public', card_types: ['Creature'], power: 2, toughness: 3, is_attacking: true };
  const player = (name: string, hand: any[], field: any[]) => ({ name, life: 9, hand, handSize: hand.length, battlefield: field, graveyard: [], exile: [], librarySize: 20 });
  const before = { turn: 18, phase: 'Phase_Combat', step: 'Step_DeclareAttack', activePlayer: 'opponent', priorityPlayer: 'me', players: { me: player('Me', [moose], []), opponent: { ...player('Opponent', [{ name: 'Future Secret', arena_id: 999, visibility: 'hidden' }], [stoneglider]), handSize: 4 } }, stack: [] };
  const after = structuredClone(before); after.players.me.hand = []; after.players.me.handSize = 0;
  after.players.me.battlefield = [{ ...moose, visibility: 'public', is_blocking: true, blocked_attacker_ids: [200], counters: [{ type: 2, name: '+1/+1', count: 1 }] }];
  return { match: { id: 'match-1', player: 'Me', opponent: 'Opponent', event: 'Jump In', result: 'Win' }, coachNotes: [{ anchor: 'T18-A2', text: 'Review the flash play.', game_number: 1 }], games: [{ game_number: 1, states: { S0: before, S1: after }, steps: [
    { anchor: 'T18-A1', turn: 18, action: 1, state_id: 'S0', event: { type: 'attack', actor: 'opponent', card: stoneglider } },
    { anchor: 'T18-A2', turn: 18, action: 2, state_id: 'S1', before_state_id: 'S0', event: { type: 'cast', actor: 'me', card: moose }, coachNotes: [{ anchor: 'T18-A2', text: 'Review the flash play.' }] },
    { anchor: 'T18-A3', turn: 18, action: 3, state_id: 'S1', before_state_id: 'S0', event: { type: 'block', actor: 'me', card: moose, targets: [stoneglider] } },
  ] }] };
}

test('pooled canonical states preserve own-hand before/after and shared Arena frame boundary', () => {
  const raw = fixture(), before = structuredClone(raw), match = normalizeReplay(raw)[0];
  assert.equal(match.steps[0].gameState.handByOwner[1][0].name, 'Galewind Moose');
  assert.deepEqual(match.steps[1].gameState.handByOwner[1], []);
  assert.equal(match.steps[1].beforeGameState?.handByOwner[1][0].name, 'Galewind Moose');
  assert.equal(match.steps[1].groupedFrame, true);
  assert.equal(match.steps[2].gameState.battlefieldByOwner[1][0].isBlocking, true);
  assert.deepEqual(match.steps[2].gameState.battlefieldByOwner[1][0].blockedAttackerIds, [200]);
  assert.equal(match.steps[2].gameState.battlefieldByOwner[1][0].counters['+1/+1'], 1);
  assert.deepEqual(raw, before);
});

test('opponent hidden hand is count-only and hidden public-zone placeholders cannot load images', () => {
  const state = normalizeState(fixture().games[0].states.S0);
  assert.deepEqual(state.handByOwner[2], []);
  assert.equal(state.players[1].handSize, 4);
  assert.equal([...state.gameObjects.values()].some(card => card.grpId === 999), false);
  const hidden = normalizeCard({ hidden: true, name: 'Hidden Secret', arena_id: 888 }, 2, 204);
  assert.equal(hidden.grpId, 0); assert.equal(hidden.name, undefined); assert.deepEqual(hidden.cardTypes, []);
});

test('stack abilities retain known target names, source, and canonical counter names', () => {
  const card = normalizeCard({ name: 'Interjection — ability', arena_id: 8, instance_id: 400, is_ability: true,
    ability_source: { name: 'Interjection', arena_id: 8 }, targets: [{ name: 'Scarblade Scout', arena_id: 9, instance_id: 500, visibility: 'public' }, { name: 'Hidden Secret', arena_id: 999, visibility: 'hidden' }], counters: [{ type: 23, name: 'Charge', count: 2 }] }, 2, 300);
  assert.equal(card.objectType, 'GameObjectType_Ability');
  assert.equal(card.targets?.[0].name, 'Scarblade Scout');
  assert.deepEqual(card.targets?.[1], { hidden: true });
  assert.equal(card.abilitySource?.name, 'Interjection');
  assert.equal(card.counters.Charge, 2);
});

test('top-level coach notes merge onto stable anchors without duplicates and context excludes future/hidden data', () => {
  const match = normalizeReplay(fixture())[0];
  assert.equal(match.steps[1].coachNotes.length, 1);
  assert.equal(match.steps[1].coachNotes[0].anchor, 'T18-A2');
  const context = coachContext(match, match.steps[1], true);
  assert.equal(context.anchor, 'T18-A2');
  assert.equal(context.state_boundary, 'before_gre_message');
  assert.equal(context.state.players.me.hand[0].name, 'Galewind Moose');
  assert.deepEqual(context.state.players.opponent.hand, []);
  assert.doesNotMatch(JSON.stringify(context), /Future Secret|999/);
});

test('store anchor navigation and true turn controls stay bounded', () => {
  const match = normalizeReplay(fixture())[0];
  match.steps.push({ ...match.steps[2], anchor: 'T19-A1', turnNumber: 19 });
  const store = useReplayStore.getState(); store.setMatches([match]);
  assert.equal(store.goToAnchor('t18-a2'), true);
  assert.equal(useReplayStore.getState().currentStepIndex, 1);
  store.nextTurn(); assert.equal(useReplayStore.getState().currentStep()?.anchor, 'T19-A1');
  store.previousTurn(); assert.equal(useReplayStore.getState().currentStep()?.anchor, 'T18-A1');
  store.stepBackward(); assert.equal(useReplayStore.getState().currentStepIndex, 0);
  assert.equal(store.goToAnchor('T99-A99'), false);
});

test('before Coach Context omits a newly revealed opponent spell and every future effect field', () => {
  const raw = fixture();
  raw.games[0].steps[1].event = { type: 'cast', actor: 'opponent', card: { name: 'Future Revealed Spell', arena_id: 887766, instance_id: 8765, visibility: 'public' }, targets: [{ name: 'Future Revealed Target', arena_id: 776655, visibility: 'public' }], amount: 8, details: 'Future Revealed Spell deals 8 damage', life: { me: 1, opponent: 9 } };
  const match = normalizeReplay(raw)[0];
  const before = coachContext(match, match.steps[1], true);
  assert.deepEqual(before.event, { type: 'cast', actor: 'opponent' });
  assert.doesNotMatch(JSON.stringify(before), /Future Revealed|887766|776655|8765|deals 8 damage/);
  const after = coachContext(match, match.steps[1], false);
  assert.equal(after.event.card.name, 'Future Revealed Spell');
  assert.equal(after.event.targets[0].name, 'Future Revealed Target');
});

test('requested Before without a before snapshot is honestly exported as After', () => {
  const match = normalizeReplay(fixture())[0], first = match.steps[0];
  assert.equal(first.beforeGameState, undefined);
  const context = coachContext(match, first, true);
  assert.equal(context.state_boundary, 'after_gre_message');
  assert.equal(context.event.card.name, 'Soaring Stoneglider');
});

test('history mode labels never default to Jump In and use event identifiers before stale labels', () => {
  const entries = normalizeHistory([{ id: 'ranked', event_id: 'Ladder', event: 'Jump In' }, { id: 'unknown' },
    { id: 'jump', event_id: 'Jump_In_2024' }, { id: 'standard', event_id: 'Traditional_Standard_Ladder' }]);
  assert.deepEqual(entries.map(e => e.event), ['排位（赛制未知）', '未知模式', 'Jump In', '传统标准排位']);
});
