import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplays } from '../src/replay.mjs';
import { normalizeReplay, normalizeState } from '../viewer/src/lib/canonicalAdapter.ts';
import { combatPresentation, observedAttackTargets } from '../viewer/src/lib/combatPresentation.ts';
import { combatFocus } from '../viewer/src/lib/combatFocus.ts';
import { boardRelationships } from '../viewer/src/lib/relationships.ts';
import { withoutCombatDuplicates } from '../viewer/src/lib/relationshipLayers.ts';
import { describeEventZh } from '../viewer/src/lib/display.ts';
import { observationGroup } from '../viewer/src/lib/observationGroups.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveReplays, getReplay, saveCoachNotes, listReplaySummaries } from '../src/history.mjs';
import { preserveReplayAnchors, repairArchivedReplay } from '../src/replay-repair.mjs';

// Synthetic protocol sequence: choose, withdraw, confirm, damage + death in one observation.
const names = new Map([[1001, 'Synthetic Attacker'], [1002, 'Synthetic Scholar'], [1003, 'Synthetic Cadet'], [1004, 'Synthetic Walker']]);
const zone = (zoneId, type, ownerSeatId, objectInstanceIds = []) => ({ zoneId, type: `ZoneType_${type}`, ownerSeatId, objectInstanceIds });
const object = (instanceId, grpId, ownerSeatId, fields = {}) => ({ instanceId, grpId, ownerSeatId, controllerSeatId: ownerSeatId,
  zoneId: 20, type: 'GameObjectType_Card', visibility: 'Visibility_Public', cardTypes: ['CardType_Creature'], ...fields });
const gre = (id, fields) => ({ greToClientEvent: { greToClientMessages: [{
  type: 'GREMessageType_GameStateMessage', systemSeatIds: [1], msgId: id,
  gameStateMessage: { type: 'GameStateType_Diff', gameStateId: id, ...fields },
}] } });
const annotation = (id, type, affectorId, affectedIds, values = {}) => ({ id, type: [`AnnotationType_${type}`], affectorId, affectedIds,
  details: Object.entries(values).map(([key, value]) => ({ key, [typeof value === 'number' ? 'valueInt32' : 'valueString']: [value] })),
});
export function syntheticCombatRecords({ trample = false, deathCategory = 'SBA_Damage' } = {}) {
  return [
    { timestamp: '1790870000000', matchGameRoomStateChangedEvent: { stateType: 'MatchGameRoomStateType_Playing', gameRoomInfo: {
      gameRoomConfig: { matchId: 'synthetic-combat-contract', reservedPlayers: [
        { systemSeatId: 1, teamId: 1, userId: 'synthetic-me', playerName: 'Me', platformId: 'Mac', eventId: 'Jump_In_2024' },
        { systemSeatId: 2, teamId: 2, userId: 'synthetic-other', playerName: 'Other', platformId: 'Other', eventId: 'Jump_In_2024' },
      ] },
    } } },
    gre(1, { type: 'GameStateType_Full', gameInfo: { gameNumber: 1, stage: 'GameStage_Play' },
      turnInfo: { turnNumber: 0, phase: 'Phase_Beginning', activePlayer: 1 },
      players: [{ systemSeatNumber: 1, lifeTotal: 20 }, { systemSeatNumber: 2, lifeTotal: 20 }],
      zones: [zone(20, 'Battlefield', 0, [101, 102, 103, 104]), zone(21, 'Stack', 0),
        zone(31, 'Hand', 1), zone(32, 'Hand', 2), zone(33, 'Library', 1), zone(34, 'Library', 2),
        zone(35, 'Graveyard', 1), zone(36, 'Graveyard', 2)],
      gameObjects: [object(101, 1001, 2, { power: { value: 4 }, toughness: { value: 4 } }),
        object(102, 1002, 1), object(103, 1003, 1),
        object(104, 1004, 1, { cardTypes: ['CardType_Planeswalker'], counters: { 7: 2 } })],
    }),
    gre(2, { turnInfo: { turnNumber: 2, phase: 'Phase_Combat', step: 'Step_DeclareAttack', activePlayer: 2 } }),
    gre(3, { gameObjects: [object(101, 1001, 2, { attackState: 'AttackState_Declared', attackInfo: { targetId: trample ? 1 : 104 } })] }),
    gre(4, { gameObjects: [object(101, 1001, 2, { attackState: 'AttackState_Attacking', attackInfo: { targetId: trample ? 1 : 104 } })] }),
    gre(5, { turnInfo: { step: 'Step_DeclareBlock' }, gameObjects: [object(102, 1002, 1, { blockState: 'BlockState_Declared', blockInfo: { attackerIds: [101] } })] }),
    gre(6, { gameObjects: [object(102, 1002, 1)] }),
    gre(7, { gameObjects: [object(103, 1003, 1, { blockState: 'BlockState_Declared', blockInfo: { attackerIds: [101] } })] }),
    gre(8, { gameObjects: [
      object(101, 1001, 2, { attackState: 'AttackState_Attacking', attackInfo: { targetId: trample ? 1 : 104, orderedBlockers: [{ instanceId: 103 }] }, blockState: 'BlockState_Blocked' }),
      object(103, 1003, 1, { blockState: 'BlockState_Blocking', blockInfo: { attackerIds: [101] } }),
    ] }),
    gre(9, { turnInfo: { step: 'Step_CombatDamage' },
      zones: [zone(20, 'Battlefield', 0, [101, 102, 104]), zone(35, 'Graveyard', 1, [203])],
      gameObjects: [object(101, 1001, 2, { damage: 2, attackState: 'AttackState_Attacking',
        attackInfo: { targetId: trample ? 1 : 104 }, blockState: 'BlockState_Blocked' }),
      object(203, 1003, 1, { zoneId: 35 })],
      diffDeletedInstanceIds: [103],
      annotations: [
        annotation(1, 'DamageDealt', 101, [103], { damage: 4 }),
        annotation(2, 'DamageDealt', 103, [101], { damage: 2 }),
        ...(trample ? [annotation(5, 'DamageDealt', 101, [1], { damage: 1 })] : []),
        annotation(3, 'ObjectIdChanged', 103, [203], { orig_id: 103, new_id: 203 }),
        annotation(4, 'ZoneTransfer', undefined, [203], { category: deathCategory, zone_src: 20, zone_dest: 35 }),
      ],
    }),
    gre(10, { turnInfo: { step: 'Step_EndCombat' } }),
    gre(11, { gameInfo: { gameNumber: 1, stage: 'GameStage_GameOver',
      results: [{ scope: 'MatchScope_Game', winningTeamId: 1, reason: 'ResultReason_Concede' }] } }),
    { matchGameRoomStateChangedEvent: { stateType: 'MatchGameRoomStateType_MatchCompleted', gameRoomInfo: {
      finalMatchResult: { matchId: 'synthetic-combat-contract', resultList: [
        { scope: 'MatchScope_Game', winningTeamId: 1, reason: 'ResultReason_Concede' },
        { scope: 'MatchScope_Match', winningTeamId: 1, reason: 'ResultReason_Concede' },
      ] },
    } } },
  ];
}
const replay = async options => (await buildReplays(syntheticCombatRecords(options), names)).replays[0];
const at = (match, id, type) => match.steps.find(step => step.gameState.gameStateId === id && (!type || step.event?.type === type));

test('only committed combat actions enter the replay file while live state keeps tentative blockers', async () => {
  const raw = await replay(), match = normalizeReplay(raw)[0], events = raw.games[0].turns.flatMap(turn => turn.events);
  assert.equal(events.filter(e => e.type === 'block').length, 1);
  assert.equal(events.find(e => e.type === 'block').card.instance_id, 103);
  assert.equal(events.some(e => /selection|cancelled/.test(e.type)), false);
  assert.equal(match.steps.some(step => step.stateId === 'S6'), false);
  assert.doesNotMatch(events.map(event => describeEventZh(event)).join('\n'), /待确认|撤销/);
  assert.equal(match.steps.some(step => step.event?.type === 'game_over'), true);
});

test('tentative combat frame numbers cannot hide another match phase or terminal entry', async () => {
  const first = syntheticCombatRecords();
  const opening = structuredClone(first[0]);
  opening.matchGameRoomStateChangedEvent.gameRoomInfo.gameRoomConfig.matchId = 'synthetic-second-combat';
  const completion = structuredClone(first.at(-1));
  completion.matchGameRoomStateChangedEvent.gameRoomInfo.finalMatchResult.matchId = 'synthetic-second-combat';
  const second = [opening, structuredClone(first[1]),
    gre(2, { turnInfo: { turnNumber: 2, phase: 'Phase_Main1', activePlayer: 2 } }),
    gre(3, { turnInfo: { phase: 'Phase_Main2' } }),
    gre(4, { gameInfo: { gameNumber: 1, stage: 'GameStage_GameOver',
      results: [{ scope: 'MatchScope_Game', winningTeamId: 1, reason: 'ResultReason_Concede' }] } }), completion];
  const { replays } = await buildReplays([...first, ...second], names);
  const game = replays.find(replay => replay.match.id === 'synthetic-second-combat').games[0];
  const third = game.steps.find(step => game.states[step.state_id].gameStateId === 3);
  assert.equal(third?.event.type, 'phase');
  assert.equal(third?.event.phase, 'Phase_Main2');
  assert.equal(game.steps.at(-1).event.type, 'game_over');
});

test('tentative combat cannot hide a real tap change in the same observation', async () => {
  const records = syntheticCombatRecords();
  const choosing = records.find(record => record.greToClientEvent?.greToClientMessages?.[0]?.gameStateMessage?.gameStateId === 7)
    .greToClientEvent.greToClientMessages[0].gameStateMessage;
  choosing.gameObjects.push(object(104, 1004, 1, { isTapped: true, cardTypes: ['CardType_Planeswalker'] }));
  const { replays } = await buildReplays(records, names);
  const match = normalizeReplay(replays[0])[0], retained = at(match, 7);
  assert.equal(retained?.event?.type, 'state');
  assert.equal(retained?.gameState.gameObjects.get(104).isTapped, true);
  assert.equal(match.steps.some(step => /selection|cancelled/.test(step.event?.type ?? '')), false);
});

test('blocked survives blocker death, damage survives normalization, and no walker attack arrow returns', async () => {
  const raw = await replay(), match = normalizeReplay(raw)[0], damage = at(match, 9, 'damage');
  const card = damage.gameState.gameObjects.get(101);
  assert.equal(card.isBlocked, true);
  assert.equal(card.damage, 2);
  const presentation = combatPresentation(damage.gameState, 1, damage.event, { attackTargets: observedAttackTargets(match.steps, damage) });
  assert.equal(combatFocus(presentation.links, null).visible.some(link => link.kind === 'attack'), false);
  assert.match(presentation.marks.get(101).detail, /已被阻挡/);
  assert.equal(damage.gameState.gameObjects.get(104).counters['Counter 7'], 2);
  assert.equal(at(match, 10).gameState.gameObjects.get(101).isBlocked, false);
  assert.equal(pendingDamage(raw, 9), 2);
  assert.equal(normalizeState(raw.games[0].states[at(match, 8).stateId]).gameObjects.get(101).damage, 0);
});
function pendingDamage(raw, id) { return Object.values(raw.games[0].states).find(s => s.gameStateId === id).players.opponent.battlefield.find(c => c.instance_id === 101).damage_marked; }

test('death aliases retain event identity; simultaneous damage/death shares one honest observation', async () => {
  const raw = await replay(), match = normalizeReplay(raw)[0], damage = at(match, 9, 'damage');
  assert.equal(damage.event.targets[0].logical_id, 'C103');
  assert.equal(damage.gameState.gameObjects.get(203).logicalId, 'C103');
  assert.ok(boardRelationships(damage.gameState, damage.event).some(link => link.to.card === 203));
  const group = observationGroup(match.steps, damage.stepIndex);
  assert.equal(group.steps.length, 3);
  assert.equal(new Set(group.steps.map(step => step.gameState.gameStateId)).size, 1);
  assert.deepEqual(group.steps.map(step => step.event.type), ['damage', 'damage', 'dies']);
});

test('only observed trample damage restores a damage relationship, never a speculative attack', async () => {
  const raw = await replay({ trample: true }), match = normalizeReplay(raw)[0];
  const step = match.steps.find(step => step.event?.type === 'damage' && step.event.targets?.[0]?.player === 'me');
  const p = combatPresentation(step.gameState, 1, step.event, { attackTargets: observedAttackTargets(match.steps, step) });
  assert.equal(combatFocus(p.links, null).visible.some(link => link.kind === 'attack'), false);
  assert.ok(withoutCombatDuplicates(boardRelationships(step.gameState, step.event), p.links).some(link => link.to.player === 1));
});

test('deathtouch, zero loyalty and unattached aura keep their actual departure semantics', async () => {
  for (const category of ['SBA_Deathtouch', 'SBA_ZeroLoyalty', 'SBA_UnattachedAura']) {
    const raw = await replay({ deathCategory: category });
    const event = raw.games[0].turns.flatMap(turn => turn.events).find(event => event.details === category);
    assert.equal(event.type, category === 'SBA_Deathtouch' ? 'dies' : 'put_into_graveyard');
    assert.doesNotMatch(describeEventZh(event), /操作/);
  }
});

test('explicit repair backs up one match, preserves old links/notes and refuses incomplete source', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'replay-repair-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const current = await replay(), old = structuredClone(current);
  old.schema_version = '2.0';
  const game = old.games[0];
  game.steps = game.steps.filter(step => !['attack', 'block'].includes(step.event.type));
  game.turns.forEach(turn => { turn.events = game.steps.map(step => step.event).filter(event => event.sequence); });
  const originalAnchors = game.steps.map(step => step.anchor);
  await archiveReplays([old], { dataDir });
  const note = { anchor: originalAnchors.at(-2), text: 'Keep this synthetic comment', game_number: 1 };
  await saveCoachNotes(old.match.id, [note], { dataDir });
  const db = new DatabaseSync(join(dataDir, 'replay-ingest.sqlite3'));
  db.exec('CREATE TABLE records(sequence INTEGER PRIMARY KEY, match_id TEXT, json TEXT)');
  const insert = db.prepare('INSERT INTO records(match_id,json) VALUES(?,?)');
  for (const record of syntheticCombatRecords()) insert.run(old.match.id, JSON.stringify(record));
  db.close();
  const preview = await repairArchivedReplay(old.match.id, { dataDir });
  assert.equal(preview.applied, false);
  assert.equal((await getReplay(old.match.id, { dataDir })).schema_version, '2.0');
  assert.ok(originalAnchors.every(anchor => preview.replay.games[0].steps.some(step => step.anchor === anchor)));
  const result = await repairArchivedReplay(old.match.id, { dataDir, apply: true });
  assert.equal(result.applied, true);
  const backup = JSON.parse(await readFile(result.backup_path, 'utf8'));
  assert.equal(backup.replay.schema_version, '2.0');
  const saved = await getReplay(old.match.id, { dataDir });
  assert.equal(saved.schema_version, '2.1');
  assert.deepEqual(saved.coachNotes, [note]);
  assert.ok(originalAnchors.every(anchor => saved.games[0].steps.some(step => step.anchor === anchor)));
  const repeated = await repairArchivedReplay(old.match.id, { dataDir, apply: true });
  assert.equal(repeated.no_change, true);
  assert.equal(repeated.applied, false);
  const fragment = structuredClone(current);
  fragment.games[0].steps.pop();
  assert.throws(() => preserveReplayAnchors(fragment, current), /preserve archived anchor/);
  const wrongAccount = structuredClone(current); wrongAccount.match.account_key = 'different';
  assert.throws(() => preserveReplayAnchors(wrongAccount, current), /account identity/);
  const [revision] = await listReplaySummaries([old.match.id], { dataDir });
  assert.equal((await archiveReplays([backup.replay], {
    dataDir, replaceRevision: revision.replay_revision, strictReplaceRevision: true,
  })).archived, 1);
  const restored = await getReplay(old.match.id, { dataDir });
  assert.equal(restored.schema_version, '2.0');
  assert.deepEqual(restored.coachNotes, [note]);
});
