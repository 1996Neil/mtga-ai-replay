import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveReplays, getReplay, saveCoachNotes, listReplaySummaries } from '../src/history.mjs';
import { appendTerminalSteps, repairTerminalReplay } from '../src/replay-terminal-repair.mjs';

function fixture(id = 'synthetic-terminal', account = 'a'.repeat(64)) {
  const snapshot = (id, extra = {}) => ({ turn: 3, gameStateId: id, activePlayer: 'me', phase: 'Phase_Main1',
    step: null, players: { me: { life: 6, battlefield: [], hand: [] }, opponent: { life: 20, battlefield: [], hand: [] } }, ...extra });
  return { schema_version: '2.0', match: { id, account_key: account, started_at: '2026-10-31T08:00:00Z', result: 'Loss' },
    games: [{ game_number: 1, result: { outcome: 'Loss', reason: 'concede', life: { me: 6, opponent: 20 } },
      states: { S1: snapshot(11), S2: snapshot(12), S3: snapshot(13, { post_game: { hidden: true } }) },
      steps: [{ anchor: 'T3-A1', turn: 3, action: 1, state_id: 'S1', before_state_id: null,
        event: { type: 'phase' }, coachNotes: [{ text: 'Keep inline note' }] }],
      turns: [{ turn_number: 3, events: [] }], warnings: [],
    }], warnings: [], deck: [{ arena_id: 100, name: 'Old synthetic card', power: 1, quantity: 1 }] };
}

test('append only the first proven terminal snapshot; preserve every prior fact and inline comment', () => {
  const previous = fixture(), original = structuredClone(previous);
  const result = appendTerminalSteps(previous, [{ game_number: 1, state_id: 12 }, { game_number: 1, state_id: 13 }]);
  assert.deepEqual(previous, original);
  assert.equal(result.changes.length, 1);
  const patched = result.replay.games[0], last = patched.steps.at(-1);
  assert.equal(last.event.type, 'game_over'); assert.equal(last.state_id, 'S2');
  assert.equal(last.before_state_id, 'S1'); assert.equal(last.anchor, 'T3-A2');
  assert.deepEqual({ ...result.replay, games: [{ ...patched, steps: patched.steps.slice(0, -1) }] }, original);
  assert.equal(appendTerminalSteps(result.replay, [{ game_number: 1, state_id: 12 }]).changes.length, 0);
});

test('no terminal entry without matching game and saved snapshot; refuse terminal before the timeline', () => {
  const previous = fixture();
  assert.equal(appendTerminalSteps(previous, []).replay, previous);
  assert.equal(appendTerminalSteps(previous, [{ game_number: 2, state_id: 12 }]).changes.length, 0);
  assert.equal(appendTerminalSteps(previous, [{ game_number: 1, state_id: 999 }]).changes.length, 0);
  previous.games[0].steps[0].state_id = 'S3';
  assert.throws(() => appendTerminalSteps(previous, [{ game_number: 1, state_id: 12 }]), /precedes/);
});

test('Bo3 terminal evidence is game-scoped and new anchors cannot collide with old notes', () => {
  const previous = fixture();
  previous.games.push({ ...structuredClone(previous.games[0]), game_number: 2 });
  previous.coachNotes = [{ anchor: 'T3-A2', game_number: 1, text: 'Reserved link' }];
  const result = appendTerminalSteps(previous, [{ game_number: 2, state_id: 12 }]);
  assert.equal(result.replay.games[0].steps.length, 1);
  assert.equal(result.replay.games[1].steps.at(-1).anchor, 'T3-A3');
  assert.deepEqual(result.replay.coachNotes, previous.coachNotes);
});

test('indexed single-match repair backs up, preserves other accounts, is idle on retry, and can restore', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'terminal-repair-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const a = fixture(), b = fixture('synthetic-other-account', 'b'.repeat(64));
  await archiveReplays([a, b], { dataDir });
  const notes = [{ anchor: 'T3-A1', game_number: 1, text: 'Keep stored note' }];
  await saveCoachNotes(a.match.id, notes, { dataDir });
  const metadata = new DatabaseSync(join(dataDir, 'replays.sqlite3'));
  const newerCard = JSON.stringify({ arena_id: 100, name: 'Newer synthetic metadata', power: 7 });
  metadata.prepare('UPDATE cards SET name=?,metadata_json=? WHERE arena_id=100').run('Newer synthetic metadata', newerCard);
  metadata.close();
  const database = new DatabaseSync(join(dataDir, 'replay-ingest.sqlite3'));
  database.exec('CREATE TABLE records(sequence INTEGER PRIMARY KEY, match_id TEXT, json TEXT); CREATE INDEX records_match ON records(match_id)');
  const insert = database.prepare('INSERT INTO records(match_id,json) VALUES(?,?)');
  const message = (gameNumber, stateId, matchID) => ({ gameStateMessage: {
    gameStateId: stateId, gameInfo: { gameNumber, stage: 'GameStage_GameOver', ...(matchID ? { matchID } : {}) },
  } });
  insert.run(a.match.id, JSON.stringify({ greToClientEvent: { greToClientMessages: [
    { type: 'GREMessageType_ConnectResp' }, message(1, 12), message(1, 13),
    message(1, 11, b.match.id), // An explicit different match cannot certify a snapshot.
  ] } }));
  database.close();
  const baseline = await getReplay(a.match.id, { dataDir });
  const other = await getReplay(b.match.id, { dataDir });
  const preview = await repairTerminalReplay(a.match.id, { dataDir });
  assert.equal(preview.added_terminal_steps, 1); assert.equal(preview.applied, false);
  assert.deepEqual(await getReplay(a.match.id, { dataDir }), baseline);
  const applied = await repairTerminalReplay(a.match.id, { dataDir, apply: true });
  assert.equal(applied.applied, true);
  const backup = JSON.parse(await readFile(applied.backup_path, 'utf8'));
  assert.deepEqual(backup.replay, baseline);
  assert.equal((await stat(applied.backup_path)).mode & 0o777, 0o600);
  const saved = await getReplay(a.match.id, { dataDir });
  assert.equal(saved.games[0].steps.at(-1).state_id, 'S2');
  assert.deepEqual(saved.coachNotes, notes);
  assert.deepEqual(await getReplay(b.match.id, { dataDir }), other);
  const cardDatabase = new DatabaseSync(join(dataDir, 'replays.sqlite3'), { readOnly: true });
  assert.equal(cardDatabase.prepare('SELECT metadata_json FROM cards WHERE arena_id=100').get().metadata_json, newerCard);
  cardDatabase.close();
  const [revision] = await listReplaySummaries([a.match.id], { dataDir });
  const repeated = await repairTerminalReplay(a.match.id, { dataDir, apply: true });
  assert.equal(repeated.no_change, true); assert.equal(repeated.applied, false);
  assert.equal((await listReplaySummaries([a.match.id], { dataDir }))[0].replay_revision, revision.replay_revision);
  assert.equal((await readdir(join(dataDir, 'backups', 'replay-terminal-repair'))).length, 1);
  assert.equal((await archiveReplays([backup.replay], {
    dataDir, replaceRevision: revision.replay_revision, strictReplaceRevision: true,
  })).archived, 1);
  assert.deepEqual(await getReplay(a.match.id, { dataDir }), baseline);
});
