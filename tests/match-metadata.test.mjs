import test from 'node:test';
import assert from 'node:assert/strict';
import { indexMatchMetadata } from '../src/match-metadata.mjs';
import { buildReplays } from '../src/replay.mjs';
import { syntheticMatchRecords } from './helpers/synthetic-log.mjs';

const connect = seat => ({greToClientEvent:{greToClientMessages:[{type:'GREMessageType_ConnectResp',systemSeatIds:[seat]}]}});
function match(id, seat, minute, explicit = true) {
  const records = syntheticMatchRecords(id,minute,'QuickDraft_FRA');
  for (const record of records) for (const message of record.greToClientEvent?.greToClientMessages ?? []) {
    message.systemSeatIds = [seat];
    if (explicit) message.gameStateMessage.gameInfo.matchID = id;
    for (const result of message.gameStateMessage.gameInfo.results ?? []) result.winningTeamId = seat;
  }
  for (const result of records.at(-1).matchGameRoomStateChangedEvent.gameRoomInfo.finalMatchResult.resultList) result.winningTeamId = seat;
  return records;
}

for (const nextSeat of [1,2]) test(`end A → connect B (seat ${nextSeat}) → room B never reverses A`, async () => {
  const records = [...match('synthetic-A',2,0),connect(nextSeat),...match('synthetic-B',nextSeat,1)];
  const metadata = indexMatchMetadata(records);
  assert.equal(metadata.get('synthetic-A').localSeat,2);
  assert.equal(metadata.get('synthetic-B').localSeat,nextSeat);
  const {replays} = await buildReplays(records);
  assert.equal(replays.find(r=>r.match.id==='synthetic-A').match.result,'Win');
  assert.equal(replays.find(r=>r.match.id==='synthetic-B').match.result,'Win');
});

test('legacy messages without matchID bind an early connection only after the next room arrives', () => {
  const records = [...match('synthetic-A',2,0,false),connect(1),...match('synthetic-B',1,1,false)];
  const metadata = indexMatchMetadata(records);
  assert.equal(metadata.get('synthetic-A').localSeat,2);
  assert.equal(metadata.get('synthetic-B').localSeat,1);
});

test('explicit conflicting seats stay unknown, while a Bo3 single game ending keeps the match open', () => {
  const records = match('synthetic-A',2,0);
  const conflicting = structuredClone(records[1]); conflicting.greToClientEvent.greToClientMessages[0].systemSeatIds=[1];
  assert.equal(indexMatchMetadata([...records,conflicting]).get('synthetic-A').localSeat,undefined);
  const legacy = match('synthetic-B',2,1,false); legacy.pop();
  const metadata = indexMatchMetadata([...legacy,connect(2)]);
  assert.equal(metadata.get('synthetic-B').seatConfirmed,true);
});
