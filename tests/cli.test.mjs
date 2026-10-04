import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { archiveReplays } from '../src/history.mjs';

test('one-shot CLI can replay archived Jump In after source logs rotate away', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mtga-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logs = join(dir, 'empty-logs'), dataDir = join(dir, 'history'), output = join(dir, 'output');
  await mkdir(logs);
  const replay = { schema_version: '2.0', perspective: { hidden_information: 'omitted' },
    match: { id: 'archived-synthetic', started_at: '2026-10-01T00:00:00.000Z', event: 'Jump In', is_jump_in: true, result: 'Win' },
    deck: [], warnings: [], games: [{ game_number: 1, on_play: true, starting_hand: [], mulligans: { me: 0, opponent: 0 },
      turns: [{ turn_number: 1, active_player: 'me', events: [{ type: 'life', life: { me: 20, opponent: 0 } }] }],
      states: {}, steps: [{ anchor: 'T1-A1', event: { type: 'life' } }],
      result: { outcome: 'Win', reason: 'unknown', life: { me: 20, opponent: 0 } }, warnings: [] }] };
  await archiveReplays([replay], { dataDir });
  const cli = fileURLToPath(new URL('../bin/mtga-gpt-replay.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'replay', 'latest', '--log-dir', logs, '--data-dir', dataDir, '--output', output, '--no-open'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /latest: Jump In, Win/);
  assert.equal(JSON.parse(await readFile(join(output, 'latest.json'), 'utf8')).match.id, replay.match.id);
  assert.match(await readFile(join(output, 'latest.md'), 'utf8'), /Jump In/);
  assert.doesNotMatch(run.stdout, /Visual Replay:/);
});

test('GitHub failure retains pending bundle and does not fail local replay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mtga-cli-offline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logs = join(dir, 'logs'), dataDir = join(dir, 'history'), output = join(dir, 'output'), fakeBin = join(dir, 'bin');
  await mkdir(logs); await mkdir(fakeBin); await mkdir(join(dataDir, 'coach-sync'), { recursive: true });
  const fakeGh = join(fakeBin, 'gh');
  await writeFile(fakeGh, '#!/bin/sh\necho "Synthetic network failure" >&2\nexit 1\n'); await chmod(fakeGh, 0o700);
  await writeFile(join(dataDir, 'coach-sync', 'state.json'), JSON.stringify({ schema: 'MTGA_LOCAL_SYNC_V1', enabled: true,
    repository: 'synthetic-owner/synthetic-private', pending: [], synced: {}, last_synced: null, visibility: 'PRIVATE' }));
  const replay = { schema_version: '2.0', perspective: { hidden_information: 'omitted' },
    match: { id: 'synthetic-network-failure', started_at: '2026-10-01T00:00:00.000Z', event: 'Jump In', is_jump_in: true, result: 'Win' },
    deck: [], warnings: [], games: [{ game_number: 1, on_play: true, starting_hand: [], mulligans: { me: 0, opponent: 0 },
      turns: [{ turn_number: 1, active_player: 'me', events: [{ type: 'life', life: { me: 20, opponent: 0 } }] }],
      states: {}, steps: [{ anchor: 'T1-A1', event: { type: 'life' } }], result: { outcome: 'Win', life: { me: 20, opponent: 0 } }, warnings: [] }] };
  const older = structuredClone(replay);
  older.match.id = 'synthetic-older-network-failure'; older.match.started_at = '2026-09-30T00:00:00.000Z';
  await archiveReplays([older, replay], { dataDir });
  const cli = fileURLToPath(new URL('../bin/mtga-gpt-replay.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'latest', '--log-dir', logs, '--data-dir', dataDir, '--output', output, '--no-open'],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(await readFile(join(output, 'latest.json'), 'utf8')).match.id, replay.match.id);
  assert.match(run.stderr, /GitHub Coach sync pending/);
  assert.doesNotMatch(run.stderr, /Synthetic network failure/);
  assert.match(run.stdout, /Local matches: 2[\s\S]*Missing: 2/);
  const pending = JSON.parse(await readFile(join(dataDir, 'coach-sync', 'state.json'), 'utf8')).pending;
  assert.deepEqual(pending.map(item => item.match_id).sort(), [replay.match.id, older.match.id].sort());
});

test('sync status works without MTGA logs or an enabled connection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mtga-cli-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../bin/mtga-gpt-replay.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'sync', 'status', '--data-dir', dir], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /GitHub sync: disabled/); assert.match(run.stdout, /Pending: 0/);
});
