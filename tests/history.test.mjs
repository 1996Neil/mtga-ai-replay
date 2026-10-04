import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveReplays, listReplays, getReplay, getLatestReplay, getArchivedCard, saveCoachNotes } from '../src/history.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'mtga-history-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function replay(id, day = 1) {
  return { schema_version: '1.1', perspective: { hidden_information: 'omitted' },
    match: { id, started_at: `2026-10-0${day}T12:00:00.000Z`, event: 'Jump In', event_id: 'Jump_In_2024', is_jump_in: true, result: 'Win' },
    games: [{ game_number: 1, turns: [{ turn_number: 1, events: [{ type: 'land', card: { arena_id: 100, name: 'Forest', visibility: 'public' } }] }],
      replay_steps: [{ anchor: 'T1-A1', coachNotes: [], state: { myHand: [{ arena_id: 101, name: 'Synthetic Own Card', visibility: 'player_known' }] } }],
    }], coachNotes: [],
  };
}

test('SQLite history survives repeat imports and remains newest-first after source logs disappear', async (t) => {
  const dataDir = await directory(t), options = { dataDir };
  assert.deepEqual(await listReplays(options), []);
  assert.equal(await getLatestReplay(options), null);
  await archiveReplays([replay('old'), replay('new', 2)], options);
  const updated = replay('old');
  updated.games[0].replay_steps.push({ anchor: 'T1-A2', coachNotes: [], state: {} });
  const result = await archiveReplays([updated], options);
  assert.equal(result.total, 2);
  assert.deepEqual((await listReplays(options)).map(item => item.id), ['new', 'old']);
  assert.equal((await getLatestReplay(options)).match.id, 'new');
  assert.equal((await getReplay('old', options)).games[0].replay_steps.length, 2);
  assert.equal(await getReplay('absent', options), null);
  assert.equal((await listReplays({ ...options, limit: 1 })).length, 1);
});

test('batch catalog enumeration includes history beyond the bounded Viewer page', async t => {
  const dataDir = await directory(t);
  await archiveReplays(Array.from({ length: 1001 }, (_, i) => replay(`synthetic-${i}`)), { dataDir });
  assert.equal((await listReplays({ dataDir })).length, 100);
  assert.equal((await listReplays({ dataDir, limit: 1000 })).length, 1000);
  assert.equal((await listReplays({ dataDir, limit: null })).length, 1001);
});

test('archive preserves coach notes separately across replay upgrades and stores only marked-safe card identities', async (t) => {
  const dataDir = await directory(t), options = { dataDir }, input = replay('safe');
  input.games[0].replay_steps[0].state.opponentHand = [{ arena_id: 999, name: 'Synthetic Secret', visibility: 'hidden' }];
  input.games[0].replay_steps[0].state.postgame = { arena_id: 998, name: 'Synthetic Postgame Secret', visibility: 'post_game_revealed' };
  await archiveReplays([input], options);
  await saveCoachNotes('safe', [{ anchor: 'T1-A1', text: 'Synthetic coach note' }], options);
  const upgraded = replay('safe');
  upgraded.schema_version = '1.2';
  await archiveReplays([upgraded], options);
  const saved = await getReplay('safe', options);
  assert.equal(saved.schema_version, '1.2');
  assert.deepEqual(saved.coachNotes, [{ anchor: 'T1-A1', text: 'Synthetic coach note' }]);
  assert.equal((await getArchivedCard(100, options)).name, 'Forest');
  assert.equal(await getArchivedCard(999, options), null);
  assert.equal(await getArchivedCard(998, options), null);
  assert.equal(JSON.stringify(input).includes('Synthetic Secret'), true); // Caller input remains untouched.
});

test('a failed batch rolls back all matches and match IDs are SQL parameters', async (t) => {
  const dataDir = await directory(t), options = { dataDir };
  await assert.rejects(archiveReplays([replay('would-be-partial'), {}], options), /stable match/);
  assert.deepEqual(await listReplays(options), []);
  const unusualId = "synthetic'; DROP TABLE replays; --";
  await archiveReplays([replay(unusualId)], options);
  assert.equal((await getReplay(unusualId, options)).match.id, unusualId);
  assert.equal((await listReplays(options)).length, 1);
  await assert.rejects(saveCoachNotes('unknown', [], options), /Unknown archived match/);
});

test('rotated-log trailing fragments cannot shrink a complete replay, while richer schema upgrades preserve notes', async (t) => {
  const dataDir = await directory(t), options = { dataDir }, complete = replay('complete');
  complete.schema_version = '2.0';
  complete.games[0].starting_hand = [{ arena_id: 100, name: 'Forest', visibility: 'player_known' }];
  complete.games[0].states = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`S${index + 1}`, { turn: index + 1, players: {} }]));
  complete.games[0].steps = Array.from({ length: 20 }, (_, index) => ({ anchor: `T${index + 1}-A1`, turn: index + 1, state_id: `S${index + 1}` }));
  await archiveReplays([complete], options);
  await saveCoachNotes('complete', [{ anchor: 'T12-A1', text: 'Keep this note' }], options);

  const fragment = replay('complete');
  fragment.schema_version = '2.0';
  fragment.games[0].states = { S1: { turn: 20 } };
  fragment.games[0].steps = [{ anchor: 'T20-A1', turn: 20, state_id: 'S1' }];
  fragment.games[0].turns = [{ turn_number: 20, events: [] }];
  const result = await archiveReplays([fragment], options);
  assert.equal(result.preserved, 1);
  assert.equal((await getReplay('complete', options)).games[0].steps.length, 20);

  // More observed turn markers do not compensate for lost action/frame detail.
  fragment.games[0].turns = Array.from({ length: 21 }, (_, index) => ({ turn_number: index + 1, events: [] }));
  assert.equal((await archiveReplays([fragment], options)).preserved, 1);
  assert.equal((await getReplay('complete', options)).games[0].steps.length, 20);

  const upgrade = structuredClone(complete);
  upgrade.schema_version = '2.1';
  upgrade.games[0].states.S21 = { turn: 21, players: {} };
  upgrade.games[0].steps.push({ anchor: 'T21-A1', turn: 21, state_id: 'S21' });
  await archiveReplays([upgrade], options);
  const archived = await getReplay('complete', options);
  assert.equal(archived.schema_version, '2.1');
  assert.equal(archived.games[0].steps.length, 21);
  assert.deepEqual(archived.coachNotes, [{ anchor: 'T12-A1', text: 'Keep this note' }]);
});
