import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syntheticLog, syntheticMatchRecords } from './helpers/synthetic-log.mjs';
import { importIncrementalReplays } from '../src/incremental-replay-import.mjs';
import { listReplays, getReplay } from '../src/history.mjs';
import { readRecords } from '../src/log-reader.mjs';
import { buildReplays } from '../src/replay.mjs';
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'replay-incremental-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cardDb = join(dataDir, 'cards.sqlite3'), database = new DatabaseSync(cardDb);
  database.exec(`CREATE TABLE Cards(GrpId INTEGER,TitleId INTEGER);
    CREATE TABLE Localizations_enUS(LocId INTEGER,Loc TEXT,Formatted INTEGER);
    CREATE TABLE Enums(Value INTEGER,LocId INTEGER,Type TEXT);`);
  database.close();
  return { dataDir, cardDb, logPath: join(dataDir, 'Player.log') };
}
test('append cursor survives partial JSON and UTF-8; unchanged run reads zero log bytes', async t => {
  const options = await setup(t), initial = syntheticLog([['synthetic-first', 0]]);
  await writeFile(options.logPath, initial);
  assert.equal((await importIncrementalReplays(options)).archive.archived, 1);
  assert.equal((await importIncrementalReplays(options)).bytes_read, 0);
  const records = syntheticMatchRecords('synthetic-second', 1);
  records[0].matchGameRoomStateChangedEvent.gameRoomInfo.gameRoomConfig.reservedPlayers[1].playerName = '中文玩家';
  const addition = Buffer.from(records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const cut = addition.indexOf(Buffer.from('中文')) + 1;
  await appendFile(options.logPath, addition.subarray(0, cut));
  assert.equal((await importIncrementalReplays(options)).bytes_read, cut);
  await appendFile(options.logPath, addition.subarray(cut));
  const result = await importIncrementalReplays(options);
  assert.equal(result.bytes_read, addition.length - cut);
  assert.equal((await listReplays({ dataDir: options.dataDir })).length, 2);
  const batch = await buildReplays((await readRecords([options.logPath])).records);
  const expected = batch.replays.find(row => row.match.id === 'synthetic-second');
  const actual = await getReplay('synthetic-second', options);
  delete actual.coachNotes;
  assert.deepEqual(actual, expected);
});
test('same inode rewritten to larger content resets cursor; match frames stay isolated', async t => {
  const options = await setup(t);
  await writeFile(options.logPath, syntheticLog([['synthetic-old', 0]]));
  await importIncrementalReplays(options);
  const records = syntheticMatchRecords('synthetic-new', 1);
  for (const row of records) for (const message of row.greToClientEvent?.greToClientMessages ?? [])
    message.gameStateMessage.gameInfo.matchID = 'synthetic-new';
  const replacement = records.map(row => JSON.stringify(row)).join('\n') + '\n' + ' '.repeat(512);
  await writeFile(options.logPath, replacement);
  assert.equal((await importIncrementalReplays(options)).bytes_read, Buffer.byteLength(replacement));
  assert.ok(await getReplay('synthetic-new', options));
  const database = new DatabaseSync(join(options.dataDir, 'replay-ingest.sqlite3'), { readOnly: true });
  assert.equal(database.prepare("SELECT count(*) AS n FROM records WHERE match_id IS NULL AND json LIKE '%gameStateMessage%'").get().n, 0);
  database.close();
});
