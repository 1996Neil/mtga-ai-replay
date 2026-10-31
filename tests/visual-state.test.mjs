import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveState } from '../src/perspective.mjs';
import { visualSnapshot } from '../src/visual-state.mjs';
import { buildReplays } from '../src/replay.mjs';

// Synthetic protocol observations only; never store real hand/account data here.
const names = new Map([[1001, 'My Creature'], [1002, 'My Spell'], [1003, 'My Aura'],
  [2001, 'Hidden Opponent Sentinel'], [2002, 'Future Reveal Sentinel'], [2003, 'Postgame Sentinel'], [2004, 'Face Down Sentinel']]);
const counters = new Map([[1, '+1/+1']]);
const zone = (zoneId, type, ownerSeatId, ids = []) => ({ zoneId, type: `ZoneType_${type}`, ownerSeatId, objectInstanceIds: ids });
const object = (instanceId, grpId, ownerSeatId, zoneId, fields = {}) => ({
  instanceId, grpId, ownerSeatId, controllerSeatId: ownerSeatId, zoneId,
  type: 'GameObjectType_Card', visibility: 'Visibility_Public', ...fields,
});
const annotation = (id, type, affectedIds, details = {}, affectorId) => ({ id, type: [`AnnotationType_${type}`], affectedIds, affectorId,
  details: Object.entries(details).map(([key, value]) => ({ key, [typeof value === 'number' ? 'valueInt32' : 'valueString']: [value] })),
});
const snap = state => visualSnapshot(state, names, { counterNames: counters });
function full(extra = {}) {
  return { type: 'GameStateType_Full', gameStateId: 1, gameInfo: { gameNumber: 1, stage: 'GameStage_Play' },
    players: [{ systemSeatNumber: 1, lifeTotal: 20 }, { systemSeatNumber: 2, lifeTotal: 20 }],
    turnInfo: { turnNumber: 0, activePlayer: 2, phase: 'Phase_Begin' },
    zones: [zone(20, 'Battlefield', 0, [101]), zone(21, 'Stack', 0), zone(31, 'Hand', 1, [201, 202, 203]),
      zone(32, 'Hand', 2, [102]), zone(33, 'Library', 1, [205]), zone(34, 'Library', 2),
      zone(35, 'Graveyard', 1), zone(36, 'Graveyard', 2), zone(37, 'Exile', 1, [204])],
    gameObjects: [object(101, 1001, 2, 20, { power: { value: 3 }, toughness: { value: 4 }, cardTypes: ['CardType_Creature'] }),
      object(102, 1002, 2, 32, { visibility: 'Visibility_Private', viewers: [2] }),
      object(201, 2001, 1, 31, { visibility: 'Visibility_Private', viewers: [1] }),
      object(202, 2002, 1, 31, { visibility: 'Visibility_Private', viewers: [1] }),
      object(203, 2003, 1, 31, { visibility: 'Visibility_Private', viewers: [1] }),
      object(204, 2004, 1, 37, { isFaceDown: true }),
      object(205, 2001, 1, 33, { visibility: 'Visibility_Hidden' })], ...extra };
}
function start() {
  return { timestamp: '1790870000000', matchGameRoomStateChangedEvent: { stateType: 'MatchGameRoomStateType_Playing', gameRoomInfo: {
    gameRoomConfig: { matchId: 'visual-synthetic', reservedPlayers: [
      { systemSeatId: 1, teamId: 1, userId: 'synthetic-opponent', playerName: 'Opponent', platformId: 'Other', eventId: 'Jump_In_2024' },
      { systemSeatId: 2, teamId: 2, userId: 'synthetic-me', playerName: 'Me', platformId: 'Mac', eventId: 'Jump_In_2024' },
    ] },
  } } };
}
const gre = (id, gsm) => ({ greToClientEvent: { greToClientMessages: [{ type: 'GREMessageType_GameStateMessage', systemSeatIds: [2], msgId: id,
  gameStateMessage: { type: 'GameStateType_Diff', gameStateId: id, ...gsm } }] } });
const terminal = (id, extra = {}) => gre(id, { gameInfo: { gameNumber: 1, stage: 'GameStage_GameOver', results: [
  { scope: 'MatchScope_Game', winningTeamId: 2, reason: 'ResultReason_Life' }], },
  players: [{ systemSeatNumber: 1, lifeTotal: 0 }, { systemSeatNumber: 2, lifeTotal: 6 }], ...extra });
const complete = () => ({ matchGameRoomStateChangedEvent: { stateType: 'MatchGameRoomStateType_MatchCompleted', gameRoomInfo: {
  finalMatchResult: { matchId: 'visual-synthetic', resultList: [{ scope: 'MatchScope_Game', winningTeamId: 2, reason: 'ResultReason_Life' },
    { scope: 'MatchScope_Match', winningTeamId: 2, reason: 'ResultReason_Life' }] },
} } });

test('damage, summoning sickness, colors and observed mana survive partial deltas and clear on complete zero-default observations', () => {
  const state = new PerspectiveState(2);
  state.apply(full({ players: [{ systemSeatNumber: 1, lifeTotal: 20, status: 'PlayerStatus_Playing' },
    { systemSeatNumber: 2, lifeTotal: 20, status: 'PlayerStatus_Playing', manaPool: [{ color: 'ManaColor_Green', count: 2, srcInstanceId: 101 }] }],
    gameObjects: [object(101, 1001, 2, 20, { damage: 3, hasSummoningSickness: true, color: ['CardColor_Green'], isCopy: true })] }));
  const before = snap(state), creature = before.players.me.battlefield[0];
  assert.equal(creature.damage_marked, 3); assert.equal(creature.has_summoning_sickness, true);
  assert.equal(creature.is_copy, true); assert.deepEqual(creature.colors, ['Green']);
  assert.deepEqual(before.players.me.mana_pool, [{ color: 'Green', amount: 2, source_instance_id: 101 }]);
  assert.equal(before.players.me.mana_pool_source, 'last_observed');
  state.apply({ type: 'GameStateType_Diff', gameObjects: [{ instanceId: 101, power: 4 }], players: [{ systemSeatNumber: 2, lifeTotal: 19 }] });
  assert.equal(snap(state).players.me.battlefield[0].damage_marked, 3);
  assert.equal(snap(state).players.me.mana_pool[0].amount, 2);
  state.apply({ type: 'GameStateType_Diff', gameObjects: [object(101, 1001, 2, 20)], players: [{ systemSeatNumber: 2, status: 'PlayerStatus_Playing' }] });
  const after = snap(state);
  assert.equal(after.players.me.battlefield[0].damage_marked, 0);
  assert.equal(after.players.me.battlefield[0].has_summoning_sickness, false);
  assert.equal(after.players.me.battlefield[0].is_copy, false);
  assert.deepEqual(after.players.me.mana_pool, []);
  assert.equal(creature.damage_marked, 3, 'later cleanup never rewrites an earlier board');
});

test('historical visual states never backfill future or postgame identities and omit opponent hand', async () => {
  const records = [start(), gre(1, full()), gre(2, { turnInfo: { turnNumber: 1, activePlayer: 2, phase: 'Phase_Main1' } }),
    gre(3, { gameObjects: [object(202, 2002, 1, 20)], zones: [zone(31, 'Hand', 1, [201, 203]), zone(20, 'Battlefield', 0, [101, 202])] }),
    terminal(4, { gameObjects: [object(203, 2003, 1, 20, { power: { value: 99 }, toughness: { value: 98 }, cardTypes: ['CardType_Creature'] })],
      zones: [zone(20, 'Battlefield', 0, [101, 202, 203])], persistentAnnotations: [annotation(100, 'Counter', [203], { counter_type: 1, count: 97 })] }),
    complete(), gre(5, { gameObjects: [object(201, 2001, 1, 20)], zones: [zone(20, 'Battlefield', 0, [101, 201, 202, 203])] })];
  const { replays } = await buildReplays(records, names, { counterNames: counters });
  const game = replays[0].games[0], states = Object.values(game.states);
  assert.equal(states.length, 4, 'postterminal GRE observations must not become new visual frames');
  for (const state of states) {
    assert.deepEqual(state.players.opponent.hand, []);
    const json = JSON.stringify(state);
    for (const secret of ['Hidden Opponent Sentinel', 'Postgame Sentinel', 'Face Down Sentinel', '2001', '2003', '2004']) assert.equal(json.includes(secret), false, secret);
    for (const unknown of state.players.opponent.battlefield.filter(card => card.visibility === 'hidden')) {
      for (const field of ['arena_id', 'power', 'toughness', 'card_types', 'counters']) assert.equal(field in unknown, false, `${field} reveals hidden metadata`);
    }
  }
  for (const state of states.slice(0, 2)) assert.equal(JSON.stringify(state).includes('Future Reveal Sentinel'), false);
  assert.equal(states[2].players.opponent.battlefield[0].name, 'Future Reveal Sentinel');
  assert.deepEqual(game.result.life, { me: 6, opponent: 0 });
});

test('complete empty-hand observations clear membership; minimal zone deltas preserve it', () => {
  const state = new PerspectiveState(2); state.apply(full());
  const before = snap(state);
  state.apply({ zones: [{ zoneId: 32 }] });
  assert.equal(snap(state).players.me.hand.length, 1);
  state.apply({ zones: [{ zoneId: 32, type: 'ZoneType_Hand', ownerSeatId: 2, visibility: 'Visibility_Private' }] });
  assert.deepEqual(snap(state).players.me.hand, []);
  assert.equal(snap(state).players.me.handSize, 0);
  assert.equal(before.players.me.hand[0].name, 'My Spell', 'previous snapshots are immutable values');
});

test('tapping, untapping, combat and P/T follow observed states without lingering combat flags', () => {
  const state = new PerspectiveState(2); state.apply(full({ turnInfo: { turnNumber: 1, activePlayer: 2, phase: 'Phase_Combat' } }));
  state.apply({ gameObjects: [object(101, 1001, 2, 20, { isTapped: true, attackState: 'AttackState_Attacking', attackInfo: { targetId: 1 },
    blockInfo: { attackerIds: [202] }, power: { value: 5 }, toughness: { value: 6 } })] });
  const combat = snap(state).players.me.battlefield[0];
  assert.equal(combat.is_tapped, true); assert.equal(combat.is_attacking, true); assert.equal(combat.is_blocking, true);
  assert.deepEqual(combat.blocked_attacker_ids, [202]); assert.equal(combat.power, 5); assert.equal(combat.toughness, 6);
  state.apply({ turnInfo: { step: 'Step_EndCombat' } });
  const ended = snap(state).players.me.battlefield[0];
  assert.equal(ended.is_attacking, false); assert.equal(ended.is_blocking, false); assert.deepEqual(ended.blocked_attacker_ids, []);
  assert.equal(ended.is_tapped, true);
  state.apply({ annotations: [annotation(1, 'TappedUntappedPermanent', [101], { tapped: 0 })] });
  assert.equal(snap(state).players.me.battlefield[0].is_tapped, false);
  state.apply({ gameObjects: [object(101, 1001, 2, 20, { isTapped: true, attackState: 'AttackState_Attacking', attackInfo: { targetId: 1 } })] });
  state.apply({ turnInfo: { turnNumber: 2, activePlayer: 1 } });
  assert.equal(snap(state).players.me.battlefield[0].is_attacking, false);
  state.apply({ gameObjects: [object(101, 1001, 2, 20)] });
  assert.equal(snap(state).players.me.battlefield[0].is_tapped, false, 'complete changed object omits protobuf false');
  assert.equal(combat.is_attacking, true, 'old snapshot must remain unchanged');
});

test('absolute counters do not double increments and aliases retain logical identity without battlefield duplicates', () => {
  const state = new PerspectiveState(2); state.apply(full());
  const logical = snap(state).players.me.battlefield[0].logical_id;
  state.apply({ annotations: [annotation(1, 'CounterAdded', [101], { counter_type: 1, transaction_amount: 2 })],
    persistentAnnotations: [annotation(2, 'Counter', [101], { counter_type: 1, count: 2 })] });
  assert.deepEqual(snap(state).players.me.battlefield[0].counters, [{ type: 1, name: '+1/+1', count: 2 }]);
  state.apply({ annotations: [annotation(3, 'CounterRemoved', [101], { counter_type: 1, transaction_amount: 1 })],
    persistentAnnotations: [annotation(2, 'Counter', [101], { counter_type: 1, count: 1 })] });
  assert.equal(snap(state).players.me.battlefield[0].counters[0].count, 1);
  state.apply({ annotations: [annotation(4, 'ObjectIdChanged', [], { orig_id: 101, new_id: 301 })],
    gameObjects: [object(301, 1001, 2, 20)], diffDeletedInstanceIds: [101],
    zones: [zone(20, 'Battlefield', 0, [301])],
    diffDeletedPersistentAnnotationIds: [2], persistentAnnotations: [annotation(5, 'Counter', [301], { counter_type: 1, count: 1 })] });
  const battlefield = snap(state).players.me.battlefield;
  assert.equal(battlefield.length, 1); assert.equal(battlefield[0].instance_id, 301);
  assert.equal(battlefield[0].logical_id, logical); assert.equal(battlefield[0].counters[0].count, 1);
});

test('counter delta without refreshed persistent count advances, and deleted counts clear live objects', () => {
  const state = new PerspectiveState(2); state.apply(full());
  state.apply({ persistentAnnotations: [annotation(10, 'Counter', [101], { counter_type: 1, count: 1 })] });
  assert.equal(snap(state).players.me.battlefield[0].counters[0].count, 1);
  state.apply({ annotations: [annotation(11, 'CounterAdded', [101], { counter_type: 1, transaction_amount: 1 })] });
  assert.equal(snap(state).players.me.battlefield[0].counters[0].count, 2, 'an old absolute must not overwrite a newer observed delta');
  state.apply({ diffDeletedPersistentAnnotationIds: [10] });
  assert.deepEqual(snap(state).players.me.battlefield[0].counters, [], 'deleting the persistent counter clears its cached count');
});

test('battlefield death aliases keep identity but discard counters deleted in that same GRE frame', () => {
  const state = new PerspectiveState(2); state.apply(full());
  state.apply({ persistentAnnotations: [annotation(10, 'Counter', [101], { counter_type: 1, count: 2 })] });
  const old = snap(state).players.me.battlefield[0];
  state.apply({ annotations: [annotation(11, 'ObjectIdChanged', [], { orig_id: 101, new_id: 301 }),
    annotation(12, 'ZoneTransfer', [301], { category: 'SBA_Damage', zone_src: 20, zone_dest: 36 })],
    gameObjects: [object(301, 1001, 2, 36)], diffDeletedInstanceIds: [101], diffDeletedPersistentAnnotationIds: [10],
    zones: [zone(20, 'Battlefield', 0), zone(36, 'Graveyard', 2, [301])] });
  const dead = snap(state).players.me.graveyard[0];
  assert.equal(dead.name, old.name); assert.equal(dead.logical_id, old.logical_id);
  assert.deepEqual(dead.counters, [], 'the new graveyard object must not retain the old permanent counters');
  assert.deepEqual(snap(state).players.me.battlefield, []);
  assert.equal(old.counters[0].count, 2, 'historic battlefield snapshot remains intact');
});

test('attachment and stack target projection uses public identities and removes deleted relationships', () => {
  const state = new PerspectiveState(2); state.apply(full());
  state.apply({ gameObjects: [object(103, 1003, 2, 20), object(102, 1002, 2, 21)],
    zones: [zone(20, 'Battlefield', 0, [101, 103]), zone(21, 'Stack', 0, [102]), zone(32, 'Hand', 2)],
    persistentAnnotations: [annotation(10, 'Attachment', [101], {}, 103), annotation(11, 'TargetSpec', [101, 201], {}, 102)] });
  const attached = snap(state);
  assert.deepEqual(attached.players.me.battlefield[0].attachments, [103]);
  assert.equal(attached.players.me.battlefield[1].attached_to, 101);
  assert.deepEqual(attached.stack[0].targets, [{ name: 'My Creature', arena_id: 1001, instance_id: 101, logical_id: 'C101', visibility: 'public' }, { hidden: true }]);
  assert.equal(JSON.stringify(attached).includes('Hidden Opponent Sentinel'), false);
  state.apply({ diffDeletedPersistentAnnotationIds: [10, 11] });
  assert.deepEqual(snap(state).players.me.battlefield[0].attachments, []);
  assert.deepEqual(snap(state).stack[0].targets, []);
});

test('ability stack sources and controllers use current legal GRE objects across both Arena seat assignments', () => {
  for (const localSeat of [1, 2]) {
    const state = new PerspectiveState(localSeat), opponentSeat = localSeat === 1 ? 2 : 1;
    state.apply({ type: 'GameStateType_Full', players: [{ systemSeatNumber: localSeat }, { systemSeatNumber: opponentSeat }],
      zones: [zone(20, 'Battlefield', 0, [101]), zone(21, 'Stack', 0, [301])],
      gameObjects: [object(101, 1001, localSeat, 20), object(301, 9001, localSeat, 21, { type: 'GameObjectType_Ability', parentId: 101 })] });
    const observed = snap(state).stack[0];
    assert.equal(observed.controller, 'me'); assert.equal(observed.owner, 'me');
    assert.equal(observed.name, 'My Creature — ability');
    assert.equal(observed.ability_source.name, 'My Creature'); assert.equal(observed.ability_source.instance_id, 101);
    assert.equal(observed.ability_source.logical_id, 'C101'); assert.equal(observed.ability_source.controller, 'me');
    state.apply({ gameObjects: [{ instanceId: 301, controllerSeatId: opponentSeat }] });
    assert.equal(snap(state).stack[0].controller, 'opponent'); assert.equal(snap(state).stack[0].owner, 'me');
    assert.equal(observed.controller, 'me', 'historic controller is not rewritten');
  }
});

test('a later public reveal never fills earlier hidden ability source identity or unknown controller', () => {
  const state = new PerspectiveState(2); state.apply(full());
  state.apply({ gameObjects: [object(301, 9001, 0, 21, { type: 'GameObjectType_Ability', parentId: 201, controllerSeatId: 0 })],
    zones: [zone(21, 'Stack', 0, [301])] });
  const hiddenSource = snap(state).stack[0];
  assert.equal(hiddenSource.name, 'Unknown ability'); assert.deepEqual(hiddenSource.ability_source, { hidden: true });
  assert.equal(hiddenSource.controller, null); assert.equal(hiddenSource.owner, null);
  assert.equal(hiddenSource.arena_id, undefined);
  state.apply({ gameObjects: [object(201, 2001, 1, 20)], zones: [zone(20, 'Battlefield', 0, [101, 201]), zone(31, 'Hand', 1, [202, 203])] });
  assert.equal(snap(state).stack[0].ability_source.name, 'Hidden Opponent Sentinel');
  assert.equal(JSON.stringify(hiddenSource).includes('Hidden Opponent Sentinel'), false);
  assert.deepEqual(hiddenSource.ability_source, { hidden: true });
});

test('action anchors reparse deterministically and every action links valid before/after observations', async () => {
  const records = [start(), gre(1, full()), gre(2, { turnInfo: { turnNumber: 1, activePlayer: 2, phase: 'Phase_Main1' } }),
    gre(3, { gameObjects: [object(102, 1002, 2, 21)], zones: [zone(32, 'Hand', 2), zone(21, 'Stack', 0, [102])],
      annotations: [annotation(1, 'ZoneTransfer', [102], { category: 'CastSpell', zone_src: 32, zone_dest: 21 }),
        annotation(2, 'TargetSpec', [101], {}, 102)] }), terminal(4), complete()];
  const first = (await buildReplays(structuredClone(records), names)).replays[0].games[0];
  const second = (await buildReplays(structuredClone(records), names)).replays[0].games[0];
  assert.deepEqual(first.steps.map(step => [step.anchor, step.state_id, step.before_state_id]), second.steps.map(step => [step.anchor, step.state_id, step.before_state_id]));
  assert.equal(new Set(first.steps.map(step => step.anchor)).size, first.steps.length);
  for (const step of first.steps) {
    assert.match(step.anchor, /^T\d+-A\d+$/); assert.ok(first.states[step.state_id]);
    if (step.before_state_id !== null) assert.ok(first.states[step.before_state_id]);
    assert.equal(step.state_boundary, 'after_gre_message'); assert.deepEqual(step.coachNotes, []);
  }
  assert.equal(first.steps[0].before_state_id, null, 'the first observation has no invented before snapshot');
  const grouped = first.steps.filter(step => first.states[step.state_id].gameStateId === 3);
  assert.ok(grouped.length >= 2); assert.ok(grouped.every(step => step.grouped_frame));
  assert.equal(new Set(grouped.map(step => step.state_id)).size, 1, 'same GRE message must not invent intermediate board states');
  assert.equal(first.states[grouped[0].state_id].players.me.hand.length, 0);
  assert.equal(first.states[grouped[0].state_id].stack[0].name, 'My Spell');
});
