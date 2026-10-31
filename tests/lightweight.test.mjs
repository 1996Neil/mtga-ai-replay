import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { revisionMemo } from '../src/lightweight.mjs';
import { archiveReplays } from '../src/history.mjs';
import { startReplayServer } from '../src/server.mjs';
import { readDraftCapture, projectDraftCaptures, draftLogRevision } from '../src/draft-capture.mjs';
import { buildDraftBackup, parseDraftBackup } from '../src/draft-backup.mjs';
import { atomicSyncWrite } from '../src/coach-sync.mjs';
const execute = promisify(execFile);
const A = 'a'.repeat(64);
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'lightweight-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('revision memo coalesces readers, reuses unchanged result and never marks a concurrent change consumed', async () => {
  let revision = 'a', calls = 0;
  const read = revisionMemo(async () => revision, async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return calls; });
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => read())), Array(20).fill(1));
  assert.equal(await read(), 1); assert.equal(calls, 1);
  revision = 'b'; assert.equal(await read(), 2);
  let loads = 0;
  const changing = revisionMemo(async () => revision, async () => { if (++loads === 1) revision = 'c'; return loads; });
  assert.equal(await changing(), 2, 'the current caller must receive the stable newer generation');
  await changing(); await changing();
  assert.equal(loads, 2);
});

test('one appended observation rebuilds one tail chunk and reuses immutable old chunks', () => {
  const observation = n => ({ observation_id: n.toString(16).padStart(64, '0'), account_key: A,
    adapter: '17lands-log-v2', kind: 'pack', event_id: 'QuickDraft_SYNTHETIC', pack_number: 1, pick_number: 1,
    card_ids: [n], logged_at: '2026-10-31T00:00:00.000+08:00' });
  const observations = Array.from({ length: 250 }, (_, i) => observation(i + 1)), chunkCache = new Map();
  let built = 0, reused = 0;
  const options = { chunkCache, onBuild: value => { built += value.built; reused += value.reused; } };
  buildDraftBackup({ observations, gaps: 0 }, options); assert.equal(built, 3);
  built = reused = 0;
  const snapshot = buildDraftBackup({ observations: [...observations, observation(251)], gaps: 0 }, options);
  assert.deepEqual({ built, reused }, { built: 1, reused: 2 }); assert.equal(snapshot.observations, 251);
  const [path, text] = [...snapshot.files].find(([path]) => path.includes('/objects/'));
  const cached = parseDraftBackup(path, text);
  assert.throws(() => cached.observations[0].card_ids.push(999), TypeError, 'parsed memo must not be mutable');
  assert.equal(parseDraftBackup(path, text), cached);
});

test('one changed draft reuses old per-pick pool projections and timestamp corrections invalidate its cache', () => {
  let sequence = 0;
  const event = (kind, pick_number, card_ids) => ({ observation_id: (++sequence).toString(16).padEnd(64, 'd'),
    account_key: A, event_id: 'QuickDraft_SYNTHETIC', kind, pack_number: 1, pick_number, card_ids,
    logged_at: '2026-10-31T00:00:00.000+08:00' });
  const observations = [];
  for (let n = 0; n < 3; n++) observations.push(event('pack', 1, [10, 11]), event('pick', 1, [10]),
    event('pack', 2, [11]), event('pick', 2, [11]));
  const cardNames = new Map(); let built = 0, reused = 0;
  const options = { cardNames, onProject: value => { built += value.built; reused += value.reused; } };
  projectDraftCaptures(observations, options); assert.equal(built, 3);
  built = reused = 0;
  const nextPack = event('pack', 1, [10, 11]), nextPick = event('pick', 1, [10]);
  observations.push(nextPack, nextPick);
  projectDraftCaptures(observations, options); assert.deepEqual({ built, reused }, { built: 1, reused: 3 });
  built = reused = 0;
  const corrected = observations.map(value => value === nextPick ? { ...value, logged_at: '2026-10-31T00:01:00.000+08:00' } : value);
  const runs = projectDraftCaptures(corrected, options);
  assert.deepEqual({ built, reused }, { built: 1, reused: 3 });
  assert.equal(runs.find(run => run.run_id === nextPack.observation_id.slice(0, 32)).picks[0].picked_at, '2026-10-31T00:01:00.000+08:00');
});

function captureStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE observations(seq INTEGER PRIMARY KEY,observation_id TEXT,body TEXT);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE accounts(account_key TEXT,label TEXT);
    CREATE TABLE gaps(gap_id TEXT,reason TEXT);
    INSERT INTO meta VALUES ('observation_revision','0');
    CREATE TRIGGER changes_insert AFTER INSERT ON observations
      BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='observation_revision'; END;
    CREATE TRIGGER changes_update AFTER UPDATE ON observations
      BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='observation_revision'; END;`);
  db.prepare('INSERT INTO accounts VALUES (?,?)').run(A, 'Synthetic');
  return db;
}
test('account metadata reads zero observation rows, and observation reads use only appended rows', async t => {
  const dataDir = await directory(t), path = join(dataDir, 'draft-capture.sqlite3'), db = captureStore(path);
  const insert = db.prepare('INSERT INTO observations(observation_id,body) VALUES (?,?)');
  for (let n = 0; n < 200; n++) insert.run(String(n), JSON.stringify({ account_key: A, kind: 'pack', card_ids: [n + 1] }));
  const reads = [];
  const options = { dataDir, onRead: value => reads.push(value.observation_rows) };
  assert.equal((await readDraftCapture({ ...options, metadataOnly: true })).accounts.length, 1);
  assert.equal((await readDraftCapture(options)).observations.length, 200);
  await readDraftCapture(options);
  insert.run('200', JSON.stringify({ account_key: A, kind: 'pack', card_ids: [201] }));
  assert.equal((await readDraftCapture(options)).observations.length, 201);
  await readDraftCapture(options);
  assert.deepEqual(reads, [0, 200, 0, 1, 0]);
  db.prepare('UPDATE observations SET body=? WHERE seq=1').run('{"changed":true}');
  assert.equal((await readDraftCapture(options)).observations[0].changed, true, 'repair must not reuse stale facts');
  db.close();
});

test('ordinary account and catalog polls do not decode draft observations', async t => {
  const dataDir = await directory(t), db = captureStore(join(dataDir, 'draft-capture.sqlite3'));
  db.prepare('INSERT INTO observations(observation_id,body) VALUES (?,?)').run('poison', 'broken JSON must not be decoded by metadata polling');
  db.close();
  const viewerDir = join(dataDir, 'viewer'); await mkdir(viewerDir); await writeFile(join(viewerDir, 'index.html'), 'Synthetic');
  const server = await startReplayServer({ dataDir, viewerDir, observeLocalLogs: false, writeInfo: false,
    enableReplaySync: false, enableCollection: false, includeLocalHistory: true, displayNamesZh: new Map() });
  t.after(() => server.close());
  assert.equal((await fetch(server.url + 'api/accounts')).status, 200);
  assert.equal((await fetch(server.url + 'api/catalog-revision')).status, 200);
});

test('repeated catalog/list requests load history and draft data once until a real archive change', async t => {
  const dataDir = await directory(t), viewerDir = join(dataDir, 'viewer');
  await mkdir(viewerDir); await writeFile(join(viewerDir, 'index.html'), 'Synthetic');
  const replay = id => ({ match: { id, account_key: A, started_at: new Date().toISOString(), result: 'Win', event: 'Synthetic' }, games: [] });
  await archiveReplays([replay('first')], { dataDir });
  const server = await startReplayServer({ dataDir, viewerDir, observeLocalLogs: false, writeInfo: false,
    enableReplaySync: false, enableCollection: false, includeLocalHistory: true, displayNamesZh: new Map(), cardNames: new Map([[1, 'Synthetic']]) });
  t.after(() => server.close());
  const poll = async () => {
    await Promise.all(['api/catalog-revision', 'api/accounts', `api/matches?account=${A}`, `api/draft-runs?account=${A}`]
      .map(path => fetch(server.url + path).then(response => { assert.equal(response.status, 200); return response.json(); })));
  };
  await poll(); const warm = server.workCounters();
  for (let i = 0; i < 8; i++) await poll();
  assert.deepEqual(server.workCounters(), warm);
  assert.deepEqual(warm, { history_loads: 1, account_loads: 1, draft_loads: 1 });
  const revision = await fetch(server.url + 'api/catalog-revision').then(r => r.json());
  await archiveReplays([replay('second')], { dataDir });
  await poll();
  const after = server.workCounters();
  assert.equal(after.history_loads, 2); assert.equal(after.draft_loads, 2);
  assert.notEqual((await fetch(server.url + 'api/catalog-revision').then(r => r.json())).history, revision.history);
  await poll(); assert.deepEqual(server.workCounters(), after);
});

test('idle capture leaves its SQLite file untouched', async t => {
  const dataDir = await directory(t), logs = join(dataDir, 'logs'); await mkdir(logs);
  await writeFile(join(logs, 'seventeenlands.log'), '');
  const args = [fileURLToPath(new URL('../tools/draft-capture/capture.py', import.meta.url)), '--from-start', '--data-dir', dataDir, '--log-dir', logs];
  await execute('python3', args);
  const before = await stat(join(dataDir, 'draft-capture.sqlite3'), { bigint: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  await execute('python3', args);
  const after = await stat(join(dataDir, 'draft-capture.sqlite3'), { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
});
test('capture subprocess gate changes only for relevant log writes or rotation', async t => {
  const root = await directory(t), path = join(root, 'seventeenlands.log');
  await writeFile(path, 'first\n');
  const first = await draftLogRevision(root);
  assert.equal(await draftLogRevision(root), first);
  await writeFile(join(root, 'unrelated.txt'), 'ignored');
  assert.equal(await draftLogRevision(root), first);
  await writeFile(path, 'first\nsecond\n');
  assert.notEqual(await draftLogRevision(root), first);
});

test('unchanged receipt writes preserve inode and timestamp', async t => {
  const root = await directory(t), path = join(root, 'receipt.json');
  await atomicSyncWrite(path, '{"value":1}\n');
  const before = await stat(path, { bigint: true });
  await atomicSyncWrite(path, '{"value":1}\n');
  const same = await stat(path, { bigint: true });
  assert.equal(same.ino, before.ino); assert.equal(same.mtimeNs, before.mtimeNs);
  await atomicSyncWrite(path, '{"value":2}\n');
  assert.equal(await readFile(path, 'utf8'), '{"value":2}\n');
});
