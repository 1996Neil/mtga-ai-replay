import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReplays } from '../src/replay.mjs';
import { archiveReplays, getReplay, listReplays } from '../src/history.mjs';
import { isReplayAutoUploadReady, TERMINAL_GRE_WARNING } from '../src/replay-finalization.mjs';
import { syntheticMatchRecords } from './helpers/synthetic-log.mjs';

async function fixture() {
  const [room, first, last, complete] = syntheticMatchRecords('trailing-final', 1);
  const partial = (await buildReplays([room, first, complete])).replays[0];
  const finalized = (await buildReplays([room, first, complete, last])).replays[0];
  return { partial, finalized, room, first, last, complete };
}
async function directory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'replay-finalization-'));
  t.after(() => rm(dataDir, { recursive: true, force: true })); return { dataDir };
}

test('MatchCompleted before trailing GameOver stays unready, then enriches only after observed terminal GRE', async t => {
  const { partial, finalized } = await fixture(), options = await directory(t);
  assert.equal(partial.match.result, 'Win'); assert.equal(partial.games[0].evidence.terminal_state_observed, false);
  assert.equal(isReplayAutoUploadReady(partial), false); assert.equal(isReplayAutoUploadReady(finalized), true);
  await archiveReplays([partial], options); assert.equal((await listReplays(options))[0].auto_upload_ready, false);
  const result = await archiveReplays([finalized], options);
  assert.equal(result.archived, 1); assert.equal(result.conflicts, 0);
  const saved = await getReplay(partial.match.id, options);
  assert.equal(saved.games[0].steps.length, 2); assert.deepEqual(saved.games[0].result.life, { me: 6, opponent: 0 });
  assert.equal((await listReplays(options))[0].auto_upload_ready, true);
  assert.equal((await archiveReplays([partial], options)).conflicts, 1, 'later truncated input cannot regress a finalized snapshot');
});

test('terminal enrichment never permits missing legacy evidence, changed facts, lower counts or unrelated warning removal', async t => {
  const original = await fixture();
  const cases = [
    ['legacy evidence', (old) => { delete old.games[0].evidence.terminal_state_observed; }],
    ['changed result', (_old, next) => { next.games[0].result.outcome = 'Loss'; }],
    ['disappearing fact', (_old, next) => { delete next.games[0].states.S1.players.me.life; }],
    ['lower parser count', (old, next) => { old.games[0].evidence.actions_parsed = 1; next.games[0].evidence.actions_parsed = 0; }],
    ['unrelated warning', (old) => { old.games[0].warnings.push('Synthetic independent coverage warning.'); }],
    ['changed action', (_old, next) => { next.games[0].steps[0].turn = 999; }],
  ];
  for (const [label, mutate] of cases) {
    const options = await directory(t), old = structuredClone(original.partial), next = structuredClone(original.finalized);
    mutate(old, next); await archiveReplays([old], options);
    assert.equal((await archiveReplays([next], options)).conflicts, 1, label);
    assert.deepEqual((await getReplay(old.match.id, options)).games, old.games, label);
  }
});

test('BO3 game-one terminal is insufficient without completed-match evidence and every expected game', async () => {
  const { room, first, last, complete, finalized } = await fixture();
  assert.equal((await buildReplays([room, first, last])).replays.length, 0, 'no match-end result yet');
  const twoGames = structuredClone(complete);
  twoGames.matchGameRoomStateChangedEvent.gameRoomInfo.finalMatchResult.resultList.unshift(
    { scope: 'MatchScope_Game', winningTeamId: 2, reason: 'ResultReason_Life' });
  const missing = (await buildReplays([room, first, last, twoGames])).replays[0];
  assert.equal(missing.match.completion_evidence.expected_games, 2);
  assert.equal(missing.games.length, 1); assert.equal(isReplayAutoUploadReady(missing), false);
  const noTerminal = structuredClone(finalized); noTerminal.games[0].warnings.push(TERMINAL_GRE_WARNING);
  assert.equal(isReplayAutoUploadReady(noTerminal), false);
  const gameTwo = [first, last].map(record => {
    const value = structuredClone(record), message = value.greToClientEvent.greToClientMessages[0];
    message.msgId += 100; message.gameStateMessage.gameStateId += 100; message.gameStateMessage.gameInfo.gameNumber = 2; return value;
  });
  const completeTwo = (await buildReplays([room, first, last, ...gameTwo, twoGames])).replays[0];
  assert.equal(completeTwo.games.length, 2); assert.equal(isReplayAutoUploadReady(completeTwo), true);
});
