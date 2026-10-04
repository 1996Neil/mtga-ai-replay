import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecords } from '../src/log-reader.mjs';
import { buildReplays, isJumpIn, selectReplays } from '../src/replay.mjs';
import { PerspectiveState } from '../src/perspective.mjs';

// Every account, card identity, and game below is synthetic. No private log fixture.
const names = new Map([
  [1001, 'Forest'], [1002, 'Lightning Bolt'], [1003, 'My Creature A'],
  [1004, 'My Creature B'], [1005, 'My Spell A'], [1006, 'My Spell B'],
  [1007, 'Mulligan Bottom'], [1008, 'Drawn Card'], [2001, 'Secret Opponent Card'],
  [2002, 'Public Opponent Bear'], [2003, 'Future Revealed Card'], [2004, 'Postgame Secret'],
]);

const zone = (zoneId, type, ownerSeatId, objectInstanceIds = []) => ({ zoneId, type: `ZoneType_${type}`, ownerSeatId, objectInstanceIds });
const object = (instanceId, grpId, ownerSeatId, zoneId, fields = {}) => ({
  instanceId, grpId, ownerSeatId, controllerSeatId: ownerSeatId, zoneId,
  type: 'GameObjectType_Card', visibility: 'Visibility_Public', ...fields,
});
const annotation = (id, category, affectedIds, from, to) => ({
  id, type: ['AnnotationType_ZoneTransfer'], affectedIds,
  details: [{ key: 'category', valueString: [category] }, { key: 'zone_src', valueInt32: [from] }, { key: 'zone_dest', valueInt32: [to] }],
});
const targeting = (id, source, target) => ({ id, type: ['AnnotationType_TargetSpec'], affectorId: source, affectedIds: [target], details: [] });
function start(id = 'synthetic-match', event = 'Jump_In_2024', timestamp = '1790870000000') {
  return { timestamp, matchGameRoomStateChangedEvent: { stateType: 'MatchGameRoomStateType_Playing', gameRoomInfo: {
    gameRoomConfig: { matchId: id, reservedPlayers: [
      { systemSeatId: 1, teamId: 1, userId: 'synthetic-opponent', playerName: 'Synthetic Opponent', platformId: 'Mac', eventId: event },
      { systemSeatId: 2, teamId: 2, userId: 'synthetic-me', playerName: 'Synthetic Me', platformId: 'Mac', eventId: event },
    ] },
  } } };
}
function gre(id, fields, queued = false) {
  return { greToClientEvent: { greToClientMessages: [{
    type: queued ? 'GREMessageType_QueuedGameStateMessage' : 'GREMessageType_GameStateMessage',
    systemSeatIds: [2], msgId: id,
    gameStateMessage: { type: 'GameStateType_Diff', gameStateId: id, ...fields },
  }] } };
}
function initial(extra = []) {
  return gre(1, {
    type: 'GameStateType_Full', gameInfo: { gameNumber: 1, stage: 'GameStage_Play' },
    turnInfo: { turnNumber: 0, activePlayer: 2, phase: 'Phase_Begin' },
    players: [{ systemSeatNumber: 1, lifeTotal: 20, mulliganCount: 0, turnNumber: 0 }, { systemSeatNumber: 2, lifeTotal: 20, mulliganCount: 0, turnNumber: 0 }],
    zones: [zone(20, 'Battlefield', 0, [202]), zone(21, 'Stack', 0), zone(31, 'Hand', 1, [201]),
      zone(32, 'Hand', 2, [101, 102, 103, 104, 105, 106, 107]), zone(33, 'Library', 1), zone(34, 'Library', 2),
      zone(35, 'Graveyard', 1), zone(36, 'Graveyard', 2), zone(37, 'Exile', 1)],
    gameObjects: [
      ...Array.from({ length: 7 }, (_, i) => object(101 + i, 1001 + i, 2, 32, { visibility: 'Visibility_Private', viewers: [2] })),
      object(201, 2001, 1, 31, { visibility: 'Visibility_Private', viewers: [1] }),
      object(202, 2002, 1, 20), ...extra,
    ],
  });
}
const turnOne = () => gre(3, { turnInfo: { turnNumber: 1, activePlayer: 2, phase: 'Phase_Begin', step: 'Step_Draw' } });
function finish(id = 'synthetic-match', gameStateId = 20, extra = {}) {
  return [gre(gameStateId, { gameInfo: { gameNumber: 1, stage: 'GameStage_GameOver', results: [
    { scope: 'MatchScope_Game', winningTeamId: 2, reason: 'ResultReason_Life' },
  ] }, players: [{ systemSeatNumber: 1, lifeTotal: 0, turnNumber: 1 }, { systemSeatNumber: 2, lifeTotal: 6, turnNumber: 1 }], ...extra }),
  { matchGameRoomStateChangedEvent: { stateType: 'MatchGameRoomStateType_MatchCompleted', gameRoomInfo: {
    finalMatchResult: { matchId: id, resultList: [
      { scope: 'MatchScope_Game', winningTeamId: 2, reason: 'ResultReason_Life' },
      { scope: 'MatchScope_Match', winningTeamId: 2, reason: 'ResultReason_Life' },
    ] },
  } } }];
}
const events = (replay) => replay.games.flatMap((game) => game.turns.flatMap((turn) => turn.events));

test('Player.log framing reads multiline JSON and deduplicates identical UTC events', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mtga-replay-framing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const match = start();
  match.matchGameRoomStateChangedEvent.gameRoomInfo.gameRoomConfig.reservedPlayers[1].playerName = 'Name with { braces } and "quotes"';
  const player = join(dir, 'Player.log'), utc = join(dir, 'UTC_Log - 10-02-2026 00.00.00.log');
  await writeFile(player, `ordinary Unity startup\nDETAILED LOGS: ENABLED\n[UnityCrossThreadLogger]Incoming ${JSON.stringify(match, null, 2)}\n${JSON.stringify(initial())}\n{"truncated":`);
  await writeFile(utc, `${JSON.stringify(match)}\n${JSON.stringify(initial())}\n${JSON.stringify(turnOne())}\n`);
  const result = await readRecords([player, utc]);
  assert.equal(result.detailed, true);
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records[0], match);
  assert.equal(result.records[2].greToClientEvent.greToClientMessages[0].gameStateMessage.gameStateId, 3);
});

test('real parser integration reconstructs Jump In, kept hand, draw, queued land, cast, target and result from seat 2', async () => {
  const opening = initial();
  // A broadcast's [1, 2] recipient list must not override ConnectResp's own seat.
  opening.greToClientEvent.greToClientMessages[0].systemSeatIds = [1, 2];
  const connect = { greToClientEvent: { greToClientMessages: [{ type: 'GREMessageType_ConnectResp', systemSeatIds: [2], connectResp: {} }] } };
  const records = [start(), connect, opening, gre(2, {
    zones: [zone(32, 'Hand', 2, [101, 102, 103, 104, 105, 106]), zone(34, 'Library', 2, [107])],
    gameObjects: [{ instanceId: 107, zoneId: 34, visibility: 'Visibility_Hidden' }],
    players: [{ systemSeatNumber: 2, mulliganCount: 1 }],
  }), turnOne(), gre(4, {
    gameObjects: [object(108, 1008, 2, 32, { visibility: 'Visibility_Private', viewers: [2] })],
    zones: [zone(32, 'Hand', 2, [101, 102, 103, 104, 105, 106, 108])],
    annotations: [annotation(1, 'Draw', [108], 34, 32)],
  }), gre(5, {
    turnInfo: { phase: 'Phase_Main1' }, gameObjects: [object(101, 1001, 2, 20)],
    zones: [zone(20, 'Battlefield', 0, [101, 202]), zone(32, 'Hand', 2, [102, 103, 104, 105, 106, 108])],
    annotations: [annotation(2, 'PlayLand', [101], 32, 20)],
  }, true), gre(6, {
    gameObjects: [object(102, 1002, 2, 21)], zones: [zone(21, 'Stack', 0, [102]), zone(32, 'Hand', 2, [103, 104, 105, 106, 108])],
    annotations: [annotation(3, 'CastSpell', [102], 32, 21)], persistentAnnotations: [targeting(4, 102, 202)],
  }), ...finish()];
  const { replays, stats } = await buildReplays(records, names);
  assert.equal(replays.length, 1);
  const replay = replays[0], game = replay.games[0], actions = events(replay);
  assert.equal(replay.match.event_id, 'Jump_In_2024');
  assert.equal(replay.match.is_jump_in, true);
  assert.equal(replay.match.player, 'Synthetic Me');
  assert.equal(replay.match.opponent, 'Synthetic Opponent');
  assert.equal(replay.match.on_play, true);
  assert.equal(replay.match.result, 'Win');
  assert.equal(game.mulligans.me, 1);
  assert.equal(game.starting_hand.length, 6);
  assert.equal(game.starting_hand.some((card) => card.name === 'Mulligan Bottom'), false);
  assert.equal(game.decision_points[0].initial_hand.length, 7);
  assert.equal(actions.find((action) => action.type === 'draw').card.name, 'Drawn Card');
  assert.equal(actions.find((action) => action.type === 'land').card.name, 'Forest');
  assert.equal(actions.find((action) => action.type === 'cast').card.name, 'Lightning Bolt');
  assert.equal(actions.find((action) => action.type === 'cast').parser_verified, true);
  assert.equal(actions.find((action) => action.type === 'target').targets[0].name, 'Public Opponent Bear');
  assert.deepEqual(game.result.life, { me: 6, opponent: 0 });
  assert.equal(game.result.reason, 'life');
  assert.equal(game.result.outcome, 'Win');
  assert.equal(game.evidence.own_draws_parsed, 1);
  assert.ok(game.evidence.board_snapshots_parsed > 0);
  assert.equal(stats.matchesCompleted, 1);
});

test('latest and last 5 select newest Jump In while all includes the newer ranked game', () => {
  const replays = Array.from({ length: 7 }, (_, i) => ({ match: {
    id: `match-${i}`, started_at: new Date(Date.UTC(2026, 9, 1, i)).toISOString(), is_jump_in: i !== 6,
  } }));
  assert.equal(selectReplays(replays)[0].match.id, 'match-5');
  assert.deepEqual(selectReplays(replays, { count: 5 }).map((replay) => replay.match.id), ['match-5', 'match-4', 'match-3', 'match-2', 'match-1']);
  assert.equal(selectReplays(replays, { jumpIn: false })[0].match.id, 'match-6');
  assert.equal(isJumpIn('Jump_In_2024'), true);
  assert.equal(isJumpIn('JumpIn'), true);
  assert.equal(isJumpIn('QuickDraft_2024'), false);
  assert.equal(isJumpIn('Jumpstart'), false);
});

test('injected opponent hidden grpIds never reach replay or upstream action identity resolution', async () => {
  const records = [start(), initial(), turnOne(), gre(4, {
    annotations: [annotation(1, 'Draw', [201], 33, 31), annotation(2, 'CastSpell', [201], 31, 21)],
    persistentAnnotations: [targeting(3, 201, 202)],
  }), ...finish()];
  const { replays } = await buildReplays(records, names);
  const output = JSON.stringify(replays);
  assert.equal(output.includes('Secret Opponent Card'), false);
  assert.equal(output.includes('2001'), false);
  const draw = events(replays[0]).find((event) => event.type === 'draw');
  assert.equal(draw.actor, 'opponent');
  assert.equal(draw.card, undefined);
  assert.equal(draw.amount, 1);
  const cast = events(replays[0]).find((event) => event.type === 'cast');
  assert.equal(cast.card, undefined);
  assert.equal(cast.parser_verified, undefined);
});

test('visibility distinguishes own hand, legitimately revealed opponent cards and private/face-down identities', () => {
  const state = new PerspectiveState(2);
  state.apply({ type: 'GameStateType_Full', zones: [zone(20, 'Battlefield', 0), zone(31, 'Hand', 1), zone(32, 'Hand', 2), zone(33, 'Library', 1), zone(37, 'Exile', 1)], gameObjects: [
    object(1, 1001, 2, 32, { visibility: 'Visibility_Private', viewers: [2] }),
    object(2, 2001, 1, 31, { visibility: 'Visibility_Private', viewers: [1] }),
    object(3, 2002, 1, 31, { visibility: 'Visibility_Private', viewers: [2] }),
    object(4, 2003, 1, 20, { isFaceDown: true }),
    object(5, 2004, 1, 33, { visibility: undefined }),
    object(6, 2001, 1, 37, { visibility: 'Visibility_Private', viewers: [1] }),
  ] });
  assert.equal(state.card(1, names).visibility, 'player_known');
  assert.equal(state.card(2, names), null);
  assert.equal(state.card(3, names).name, 'Public Opponent Bear');
  for (const id of [4, 5, 6]) assert.equal(state.card(id, names), null);
  const safeObjects = state.safeMessage({ gameStateMessage: {} }).gameStateMessage.gameObjects;
  for (const id of [2, 4, 5, 6]) assert.equal(safeObjects.find((card) => card.instanceId === id).grpId, 0);
});

test('GameOver same-message opponent reveal is withheld while final life still exports', async () => {
  const records = [start(), initial([object(204, 2004, 1, 31, { visibility: 'Visibility_Private', viewers: [1] })]), turnOne(), ...finish('synthetic-match', 20, {
    gameObjects: [object(204, 2004, 1, 31)],
    annotations: [{ id: 1, type: ['AnnotationType_RevealedCardCreated'], affectedIds: [204] }],
  })];
  const { replays } = await buildReplays(records, names);
  assert.equal(JSON.stringify(replays).includes('Postgame Secret'), false);
  assert.equal(JSON.stringify(replays).includes('2004'), false);
  assert.deepEqual(replays[0].games[0].result.life, { me: 6, opponent: 0 });
});

test('terminal lethal damage retains its previously public source but never newly revealed target identities', async () => {
  const records = [start(), initial([object(204, 2004, 1, 31, { visibility: 'Visibility_Private', viewers: [1] })]), turnOne(), gre(4, {
    gameObjects: [object(103, 1003, 2, 20)], zones: [zone(20, 'Battlefield', 0, [103, 202]), zone(32, 'Hand', 2, [101, 102, 104, 105, 106, 107])],
    turnInfo: { phase: 'Phase_Combat', step: 'Step_CombatDamage' },
  }), ...finish('synthetic-match', 20, {
    gameObjects: [object(204, 2004, 1, 31)],
    annotations: [
      { id: 1, type: ['AnnotationType_DamageDealt'], affectorId: 103, affectedIds: [1], details: [{ key: 'damage', valueInt32: [20] }] },
      { id: 2, type: ['AnnotationType_DamageDealt'], affectorId: 103, affectedIds: [204], details: [{ key: 'damage', valueInt32: [1] }] },
      { id: 3, type: ['AnnotationType_RevealedCardCreated'], affectedIds: [204] },
    ],
  })];
  const { replays } = await buildReplays(records, names);
  const damage = events(replays[0]).filter((event) => event.type === 'damage');
  assert.equal(damage.length, 2);
  assert.equal(damage[0].card.name, 'My Creature A');
  assert.equal(damage[0].card.visibility, 'public');
  assert.equal(damage[0].amount, 20);
  assert.deepEqual(damage[0].targets, [{ player: 'opponent' }]);
  assert.deepEqual(damage[1].targets, [{ hidden: true }]);
  assert.equal(JSON.stringify(replays).includes('Postgame Secret'), false);
  assert.equal(JSON.stringify(replays).includes('2004'), false);
  assert.equal(events(replays[0]).some((event) => event.type === 'reveal'), false);
  assert.deepEqual(replays[0].games[0].result.life, { me: 6, opponent: 0 });
});

test('MatchCompleted freezes identities without GameOver while preserving known trailing damage', async () => {
  const completion = finish()[1]; // Deliberately omit the GameOver GRE record.
  const records = [start(), initial([object(204, 2004, 1, 31, { visibility: 'Visibility_Private', viewers: [1] })]), turnOne(), gre(4, {
    gameObjects: [object(103, 1003, 2, 20)], zones: [zone(20, 'Battlefield', 0, [103, 202]), zone(32, 'Hand', 2, [101, 102, 104, 105, 106, 107])],
    turnInfo: { phase: 'Phase_Combat', step: 'Step_CombatDamage' },
  }), completion, gre(21, {
    gameObjects: [object(204, 2004, 1, 31)],
    annotations: [
      { id: 1, type: ['AnnotationType_DamageDealt'], affectorId: 103, affectedIds: [1], details: [{ key: 'damage', valueInt32: [20] }] },
      { id: 2, type: ['AnnotationType_RevealedCardCreated'], affectedIds: [204] },
    ],
  })];
  const { replays } = await buildReplays(records, names);
  assert.equal(replays.length, 1);
  assert.equal(replays[0].match.result, 'Win');
  assert.equal(replays[0].games[0].result.outcome, 'Win');
  const damage = events(replays[0]).filter((event) => event.type === 'damage');
  assert.equal(damage.length, 1);
  assert.equal(damage[0].card.name, 'My Creature A');
  assert.equal(damage[0].amount, 20);
  assert.deepEqual(damage[0].targets, [{ player: 'opponent' }]);
  assert.equal(events(replays[0]).some((event) => event.type === 'reveal'), false);
  assert.equal(JSON.stringify(replays).includes('Postgame Secret'), false);
  assert.equal(JSON.stringify(replays).includes('2004'), false);
});

test('public token creation exports once even when subsequent state repeats the token object', async () => {
  const tokenNames = new Map([...names, [3001, 'Synthetic Soldier Token']]);
  const token = object(301, 3001, 2, 20, { type: 'GameObjectType_Token', power: { value: 1 }, toughness: { value: 1 } });
  const tokenState = { gameObjects: [token], zones: [zone(20, 'Battlefield', 0, [202, 301])] };
  const { replays } = await buildReplays([start(), initial(), turnOne(), gre(4, tokenState), gre(5, tokenState), ...finish()], tokenNames);
  const tokens = events(replays[0]).filter((event) => event.type === 'token');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].actor, 'me');
  assert.equal(tokens[0].card.name, 'Synthetic Soldier Token');
  assert.equal(tokens[0].card.visibility, 'public');
});

test('diffDeletedInstanceIds forget identity before a later target', async () => {
  const records = [start(), initial(), turnOne(), gre(4, { diffDeletedInstanceIds: [202], zones: [zone(20, 'Battlefield', 0)] }), gre(5, {
    gameObjects: [object(102, 1002, 2, 21)], zones: [zone(21, 'Stack', 0, [102])],
    annotations: [annotation(1, 'CastSpell', [102], 32, 21)], persistentAnnotations: [targeting(2, 102, 202)],
  }), ...finish()];
  const { replays } = await buildReplays(records, names);
  const target = events(replays[0]).find((event) => event.type === 'target');
  assert.deepEqual(target.targets, [{ hidden: true }]);
});

test('future public target reveal never changes the earlier hidden target or cast', async () => {
  const records = [start(), initial([object(203, 2003, 1, 31, { visibility: 'Visibility_Private', viewers: [1] })]), turnOne(), gre(4, {
    gameObjects: [object(102, 1002, 2, 21)], zones: [zone(21, 'Stack', 0, [102])],
    annotations: [annotation(1, 'CastSpell', [102], 32, 21)], persistentAnnotations: [targeting(2, 102, 203)],
  }), gre(5, { gameObjects: [object(203, 2003, 1, 31)], annotations: [
    { id: 3, type: ['AnnotationType_RevealedCardCreated'], affectedIds: [203] },
  ] }), ...finish()];
  const { replays } = await buildReplays(records, names);
  const actions = events(replays[0]), target = actions.find((event) => event.type === 'target'), reveal = actions.find((event) => event.type === 'reveal');
  assert.deepEqual(target.targets, [{ hidden: true }]);
  assert.equal(reveal.card.name, 'Future Revealed Card');
  assert.ok(target.sequence < reveal.sequence);
  assert.equal(JSON.stringify(actions.filter((event) => event.sequence < reveal.sequence)).includes('Future Revealed Card'), false);
});

test('authoritative zone membership hides a returned opponent card even without an object zoneId delta', () => {
  const state = new PerspectiveState(2);
  state.apply({ type: 'GameStateType_Full', zones: [zone(20, 'Battlefield', 0, [202]), zone(31, 'Hand', 1)], gameObjects: [
    object(202, 2002, 1, 20, { visibility: undefined }),
  ] });
  assert.equal(state.card(202, names).visibility, 'public');
  state.apply({ type: 'GameStateType_Diff', zones: [zone(20, 'Battlefield', 0), zone(31, 'Hand', 1, [202])] });
  assert.equal(state.card(202, names), null);
  assert.equal(state.safeMessage({ gameStateMessage: {} }).gameStateMessage.gameObjects[0].grpId, 0);
});
