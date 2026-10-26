import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDraftCapture } from '../src/draft-capture.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { arenaAccountKey, filterAccount } from '../src/account-scope.mjs';
import { archiveReplays } from '../src/history.mjs';
import { startReplayServer } from '../src/server.mjs';
const execute = promisify(execFile);
const idA = 'SYNTHETIC' + '0'.repeat(16) + '1', idB = 'SYNTHETIC' + '0'.repeat(16) + '2';
const A = arenaAccountKey(idA), B = arenaAccountKey(idB);

test('account keys are case-stable and reject inferred names/invalid IDs', () => {
  assert.equal(arenaAccountKey(idA.toUpperCase()), A); assert.notEqual(A, B);
  assert.equal(arenaAccountKey('Synthetic Player'), null);
  assert.match(arenaAccountKey('00000000-0000-4000-8000-000000000001'), /^[a-f0-9]{64}$/);
  assert.deepEqual(filterAccount([{ account_key: A }, { account_key: B }, {}], A), [{ account_key: A }]);
  assert.deepEqual(filterAccount([{ account_key: A }, {}], 'unassigned'), [{}]);
});

test('HTTP account isolation includes captures, matches, current account and direct match read', async t => {
  const root = await mkdtemp(join(tmpdir(), 'account-capture-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'), logs = join(root, 'logs'), viewerDir = join(root, 'viewer');
  await mkdir(logs); await mkdir(viewerDir); await writeFile(join(viewerDir, 'index.html'), 'Synthetic');
  const login = (id, label) => `20261024 010200.123,INFO,tracker,Updating user info: {'player_id': '${id}', 'screen_name': '${label}'}\n`;
  const pack = `20261024 010201.123,INFO,tracker,Draft pack: {'event_name': 'QuickDraft_SYNTHETIC', 'pack_number': 0, 'pick_number': 0, 'card_ids': [10, 11]}\n`;
  const pick = `20261024 010202.123,INFO,tracker,Draft pick: {'event_name': 'QuickDraft_SYNTHETIC', 'pack_number': 0, 'pick_number': 0, 'card_ids': [10]}\n`;
  await writeFile(join(logs, 'seventeenlands.log'), login(idA, 'Synthetic A') + pack + pick + login(idB, 'Synthetic B') + pack + pick);
  await execute('python3', [fileURLToPath(new URL('../tools/draft-capture/capture.py', import.meta.url)), '--from-start', '--log-dir', logs, '--data-dir', dataDir]);
  await archiveReplays([['a', A], ['b', B], ['legacy', null]].map(([id, account_key]) => ({ match: { id, account_key, started_at: '2026-10-24T00:00:00.000Z' }, games: [], deck: [] })), { dataDir });
  const server = await startReplayServer({ dataDir, viewerDir, observeLocalLogs: false, cardNames: new Map([[10, 'Synthetic']]), displayNamesZh: new Map() });
  t.after(() => server.close());
  const get = path => fetch(server.url + path);
  const accounts = await get('api/accounts').then(r => r.json());
  assert.equal(accounts.active_account, B); assert.equal(accounts.accounts.length, 2);
  assert.deepEqual(await get(`api/draft-runs?account=${A}`).then(r => r.json()), []);
  await mkdir(join(dataDir, 'draft-sync'));
  const observations = (await readDraftCapture({ dataDir })).observations;
  await writeFile(join(dataDir, 'draft-sync/published.json'), JSON.stringify({
    verified: true, revision: 'a'.repeat(40), observation_ids: observations.map(item => item.observation_id),
  }));
  for (const [key, id] of [[A, 'a'], [B, 'b']]) {
    const drafts = await get(`api/draft-runs?account=${key}`).then(r => r.json());
    assert.equal(drafts.length, 1); assert.equal(drafts[0].account_key, key); assert.equal(drafts[0].picks.length, 1);
    assert.deepEqual((await get(`api/matches?account=${key}`).then(r => r.json())).map(m => m.id), [id]);
  }
  assert.deepEqual((await get('api/matches?account=unassigned').then(r => r.json())).map(m => m.id), ['legacy']);
  assert.equal((await get(`api/matches/a?account=${B}`)).status, 404);
  assert.equal((await get('api/matches?account=bad')).status, 400);
});
