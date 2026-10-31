import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildCollectionSnapshot, saveCollectionSnapshot, loadCollectionSnapshot } from '../src/collection.mjs';
import { collectionStoreRoot } from '../src/collection-scope.mjs';
import { updateCollection, collectionStatus, recoverCollectionOperationLock } from '../src/collection-update.mjs';
import { createAccountViewerCollections } from '../src/viewer-collection.mjs';
import { createTaskJournal } from '../src/task-journal.mjs';
import { startReplayServer } from '../src/server.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const digest = value => createHash('sha256').update(value).digest('hex');
function probe(quantity = 2) {
  const cards = [{ grpId: 900001, qty: quantity }], inventory = { gold: 100, gems: 0, wildcards: { common: 1, uncommon: 2, rare: 3, mythic: 4 } };
  return { schema: 'MTGA_COLLECTION_PROBE_V1', read_at: '2026-10-30T00:00:00.000Z', source: 'mtga-reader@0.1.13/readCollection+readInventory',
    stable_reads: 2, cards, inventory, content_hash: digest(JSON.stringify({ cards, inventory })) };
}
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'collection-accounts-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, cardDb: null, displayNamesZh: new Map(), noSync: true, confirmAccount: true };
}
async function snapshot(options, accountKey, quantity = 2) {
  return buildCollectionSnapshot(probe(quantity), { ...options, accountKey });
}

test('A, B and unassigned snapshots remain separate, including identical cards and ownership hashes', async t => {
  const options = await fixture(t);
  const old = await snapshot(options), a = await snapshot(options, A), b = await snapshot(options, B);
  await saveCollectionSnapshot(old, options);
  const legacyPointer = await readFile(join(options.dataDir, 'collection/current.json'), 'utf8');
  assert.equal(a.summary.card_content_hash, b.summary.card_content_hash);
  assert.notEqual(a.summary.content_hash, b.summary.content_hash);
  await saveCollectionSnapshot(a, { ...options, accountKey: A });
  await saveCollectionSnapshot(b, { ...options, accountKey: B });
  assert.equal((await loadCollectionSnapshot({ ...options, accountKey: A })).summary.account_key, A);
  assert.equal((await loadCollectionSnapshot({ ...options, accountKey: B })).summary.account_key, B);
  assert.equal((await loadCollectionSnapshot(options)).summary.account_key, undefined);
  assert.equal(await readFile(join(options.dataDir, 'collection/current.json'), 'utf8'), legacyPointer);
  assert.ok([...a.files.keys()].every(path => path.startsWith(`collection/accounts/${A}/`)));
  await assert.rejects(saveCollectionSnapshot(a, { ...options, accountKey: B }), { code: 'COLLECTION_INVALID' });
  await assert.rejects(loadCollectionSnapshot({ ...options, accountKey: '../escape' }), { code: 'COLLECTION_ACCOUNT_INVALID' });
});

test('scoped storage rejects symlink ancestors without changing an outside sentinel', async t => {
  const options = await fixture(t), outside = join(options.dataDir, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'sentinel'), 'keep');
  await mkdir(join(options.dataDir, 'collection'));
  await symlink(outside, join(options.dataDir, 'collection/accounts'));
  await assert.rejects(saveCollectionSnapshot(await snapshot(options, A), { ...options, accountKey: A }));
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');
});

test('account-specific updates compare only their own previous collection and reject changed active account', async t => {
  const options = await fixture(t);
  const a = { ...options, accountKey: A, activeAccount: async () => A, readProbe: async () => probe(4) };
  const b = { ...options, accountKey: B, activeAccount: async () => B, readProbe: async () => probe(2) };
  await updateCollection(a); await updateCollection(b);
  await assert.rejects(updateCollection({ ...b, readProbe: async () => probe(1) }), { code: 'COLLECTION_DECREASE' });
  assert.equal((await collectionStatus(a)).summary.total_quantity, 4);
  assert.equal((await collectionStatus(b)).summary.total_quantity, 2);
  const pointer = await readFile(join(collectionStoreRoot(options.dataDir, A), 'current.json'), 'utf8');
  let calls = 0, checks = 0;
  await assert.rejects(updateCollection({ ...a, activeAccount: async () => checks++ ? B : A,
    readProbe: async () => { calls++; return probe(5); } }), { code: 'COLLECTION_ACCOUNT_CHANGED' });
  assert.equal(calls, 1);
  assert.equal(await readFile(join(collectionStoreRoot(options.dataDir, A), 'current.json'), 'utf8'), pointer);
  await assert.rejects(updateCollection({ ...a, activeAccount: async () => B, readProbe: async () => { calls++; return probe(5); } }), { code: 'COLLECTION_ACCOUNT_CHANGED' });
  assert.equal(calls, 1, 'mismatched account must not start the reader');
});

test('global operation lock prevents simultaneous collection reads across accounts', async t => {
  const options = await fixture(t); let release, entered;
  const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const first = updateCollection({ ...options, accountKey: A, activeAccount: async () => A, readProbe: async () => { entered(); await gate; return probe(); } });
  await ready;
  let reads = 0;
  await assert.rejects(updateCollection({ ...options, accountKey: B, activeAccount: async () => B,
    readProbe: async () => { reads++; return probe(); } }), { code: 'COLLECTION_BUSY' });
  assert.equal(reads, 0); release(); await first;
});

test('explicit lock recovery also repairs the selected account save lock without changing snapshots', async t => {
  const options = await fixture(t);
  await saveCollectionSnapshot(await snapshot(options, A), { ...options, accountKey: A });
  await saveCollectionSnapshot(await snapshot(options, B), { ...options, accountKey: B });
  const root = collectionStoreRoot(options.dataDir, A), other = collectionStoreRoot(options.dataDir, B);
  const pointer = await readFile(join(other, 'current.json'), 'utf8');
  await writeFile(join(root, 'save.lock'), '2147483647');
  assert.equal(await recoverCollectionOperationLock({ ...options, accountKey: A }), true);
  await assert.rejects(readFile(join(root, 'save.lock')), { code: 'ENOENT' });
  assert.equal(await readFile(join(other, 'current.json'), 'utf8'), pointer);
  assert.equal((await loadCollectionSnapshot({ ...options, accountKey: A })).summary.account_key, A);
});

test('account task journals isolate results and discover interrupted accounts on restart', async t => {
  const options = await fixture(t), journal = createTaskJournal(options.dataDir);
  const manager = createAccountViewerCollections({ ...options, journal, update: async ({ accountKey }) =>
    ({ local_updated: true, synced: false, summary: { card_kinds: accountKey === A ? 3 : 7, total_quantity: 4 } }) });
  manager.start('update', A); await manager.wait();
  assert.equal(manager.snapshot(A).result.summary.card_kinds, 3);
  assert.equal(manager.snapshot(B).status, 'idle');
  assert.equal(manager.snapshot('unassigned').result, null);
  journal.save(`collection:${B}`, { id: '00000000-0000-4000-8000-000000000001', status: 'running', operation: 'update' });
  journal.close();
  const reopened = createTaskJournal(options.dataDir); t.after(() => reopened.close());
  const restored = createAccountViewerCollections({ ...options, journal: reopened });
  assert.equal(restored.snapshot(A).result.summary.card_kinds, 3);
  assert.equal(restored.snapshot().status, 'needs_recovery');
  assert.equal(restored.start('update', A), null);
});

async function accountCatalog(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'draft-capture.sqlite3'));
  db.exec('CREATE TABLE accounts(account_key TEXT PRIMARY KEY,label TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE observations(seq INTEGER PRIMARY KEY,observation_id TEXT,body TEXT); CREATE TABLE gaps(gap_id TEXT PRIMARY KEY,reason TEXT);');
  db.prepare('INSERT INTO accounts VALUES (?,?)').run(A, 'Synthetic A');
  db.prepare('INSERT INTO accounts VALUES (?,?)').run(B, 'Synthetic B');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('active_account', A); db.close();
}

test('HTTP collection routes require known selected account and keep jobs/results scoped', async t => {
  const options = await fixture(t); await accountCatalog(options.dataDir);
  const viewerDir = join(options.dataDir, 'viewer'); await mkdir(viewerDir); await writeFile(join(viewerDir, 'index.html'), 'Synthetic');
  const seen = [];
  const server = await startReplayServer({ ...options, viewerDir, observeLocalLogs: false, displayNamesZh: new Map(),
    collectionUpdate: async ({ accountKey }) => { seen.push(accountKey); return { local_updated: true, synced: true, summary: { card_kinds: 5, total_quantity: 6 } }; } });
  t.after(() => server.close());
  const post = (account, confirmation = true) => fetch(server.url + 'api/collection' + (account ? '?account=' + account : ''),
    { method: 'POST', headers: { Origin: new URL(server.url).origin, 'X-MTGA-Replay-Action': 'collection-update',
      ...(confirmation ? { 'X-MTGA-Replay-Account-Confirmation': 'unknown-account-reviewed' } : {}) } });
  assert.equal((await post()).status, 400);
  assert.equal((await post('unassigned')).status, 400);
  assert.equal((await post(A, false)).status, 409);
  assert.equal((await post(B)).status, 409);
  assert.equal((await post(A)).status, 202);
  let job;
  for (let i = 0; i < 30; i++) { job = await fetch(server.url + 'api/collection?account=' + A).then(r => r.json()); if (job.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.deepEqual(seen, [A]); assert.equal(job.account_key, A); assert.equal(job.result.summary.card_kinds, 5);
  assert.equal((await fetch(server.url + 'api/collection?account=' + B).then(r => r.json())).status, 'idle');
  assert.equal((await fetch(server.url + 'api/collection').then(r => r.json())).result, null);
});
