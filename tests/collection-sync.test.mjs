import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildCollectionSnapshot } from '../src/collection.mjs';
import { syncCollectionSnapshot, getCollectionSyncStatus } from '../src/collection-sync.mjs';
import { buildCoachBundle, serializeCoachJson } from '../src/coach-bundle.mjs';
import { configureCoachSync, enqueueCoachBundle, syncCoachBundles, getCoachSyncStatus,
  withCoachSyncLock, recoverCoachSyncLock } from '../src/coach-sync.mjs';

const execute = promisify(execFile);
const REPOSITORY = 'example-user/mtga-replay-data', REMOTE = `https://github.com/${REPOSITORY}.git`;
const digest = text => createHash('sha256').update(text).digest('hex');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

async function snapshot({ count = 5, readAt = '2026-10-02T00:00:00.000Z' } = {}) {
  const cards = Array.from({ length: count }, (_, index) => ({ grpId: 900000 + index, qty: (index % 4) + 1 }));
  const inventory = { gold: 3210, gems: 123, wildcards: { common: 8, uncommon: 7, rare: 6, mythic: 5 } };
  return buildCollectionSnapshot({ schema: 'MTGA_COLLECTION_PROBE_V1', read_at: readAt,
    source: 'mtga-reader@0.1.13/readCollection+readInventory', stable_reads: 2, cards, inventory,
    content_hash: digest(JSON.stringify({ cards, inventory })) }, { cardDb: null, displayNamesZh: new Map() });
}
async function replay(richer = false) {
  const forest = { arena_id: 1, name: 'Forest', instance_id: 101, logical_id: 'C1', visibility: 'public', card_types: ['Land'], counters: [] };
  const player = name => ({ name, life: 20, hand: [], handSize: 0, librarySize: 39, battlefield: [], graveyard: [], exile: [] });
  const state = { gameStateId: 1, turn: 1, phase: 'Phase_Main1', step: 'Step_Main', activePlayer: 'me', priorityPlayer: 'me',
    players: { me: { ...player('Synthetic Me'), battlefield: [forest] }, opponent: player('Synthetic Opponent') }, stack: [], warnings: [] };
  const steps = [{ anchor: 'T1-A1', turn: 1, action: 1, state_id: 'S1', event: { type: 'land', actor: 'me', card: forest } }];
  if (richer) steps.push({ anchor: 'T2-A1', turn: 2, action: 1, state_id: 'S1', event: { type: 'life', actor: 'me', life: { me: 19, opponent: 20 } } });
  return buildCoachBundle({ schema_version: '1.0', match: { id: 'synthetic-match', started_at: '2026-10-01T12:00:00.000Z', event: 'Jump In', is_jump_in: true, result: 'Win', player: 'Synthetic Me', opponent: 'Synthetic Opponent', on_play: true },
    deck: [{ arena_id: 1, name: 'Forest', quantity: 40 }], perspective: { hidden_information: 'omitted' }, warnings: [],
    games: [{ game_number: 1, starting_hand: [], states: { S1: state }, steps, turns: [], result: { outcome: 'Win', reason: 'concede', life: { me: 19, opponent: 20 } }, warnings: [] }] },
  { cards: [{ arena_id: 1, name: 'Forest', display_name_zh: '树林', mana_cost: '', type_line: 'Basic Land — Forest', oracle_text: '{T}: Add {G}.', keywords: [], power: null, toughness: null, metadata_complete: true, source: 'scryfall' }], generatedAt: '2026-10-02T00:00:00.000Z' });
}

async function harness(t, { seed = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mtga-collection-sync-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'local-data'), bare = join(directory, 'remote.git'), checkout = join(dataDir, 'coach-sync', 'repository');
  await execute('git', ['init', '--bare', '-b', 'main', bare], { env });
  const control = { offline: false, rejectPush: false, visibility: 'PRIVATE', calls: [], checks: 0,
    publicAtCheck: Infinity, afterAdd: null, afterPush: null, fetchGate: null };
  const runCommand = async (file, args, { cwd, encoding = 'utf8', env: commandEnv = {}, input } = {}) => {
    control.calls.push({ file, args: [...args] });
    if (file === 'gh') {
      assert.deepEqual(args.slice(0, 3), ['repo', 'view', REPOSITORY]); control.checks++;
      let defaultBranchRef = null;
      try { await execute('git', ['--git-dir', bare, 'rev-parse', '--verify', 'HEAD'], { env }); defaultBranchRef = { name: 'main' }; } catch { /* Empty remote. */ }
      return JSON.stringify({ nameWithOwner: REPOSITORY, visibility: control.checks >= control.publicAtCheck ? 'PUBLIC' : control.visibility,
        url: `https://github.com/${REPOSITORY}`, defaultBranchRef });
    }
    assert.equal(file, 'git');
    const network = args.find(value => value === 'fetch' || value === 'push' || value === 'ls-remote');
    if (network && (control.offline || (control.rejectPush && network === 'push'))) throw new Error('fatal ghp_SyntheticSecretMustNotEscape /Users/synthetic/private.log https://token@example.invalid');
    if (network) {
      const remote = await execute('git', ['remote', 'get-url', '--all', ...(network === 'push' ? ['--push'] : []), 'origin'], { cwd, env });
      assert.ok(remote.stdout.trim().split('\n').every(url => url === REMOTE));
    }
    if (network === 'fetch' && control.fetchGate) await control.fetchGate();
    const routed = network ? ['-c', `url.${bare}.insteadOf=${REMOTE}`, ...args] : args;
    const pending = execute(file, routed, { cwd, encoding, env: { ...process.env, ...env, ...commandEnv }, maxBuffer: 32 * 1024 * 1024 });
    // The injected runner must preserve stdin for Git's batch object reader.
    pending.child.stdin.end(input);
    const result = await pending;
    if (args.includes('add') && control.afterAdd) await control.afterAdd();
    if (network === 'push' && control.afterPush) await control.afterPush();
    return result;
  };
  const options = { dataDir, runCommand };
  const published = async path => (await execute('git', ['--git-dir', bare, 'show', `HEAD:${path}`], { env })).stdout;
  const tree = async prefix => (await execute('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'HEAD', ...(prefix ? ['--', prefix] : [])], { env })).stdout.trim().split('\n').filter(Boolean);
  const commits = async () => Number((await execute('git', ['--git-dir', bare, 'rev-list', '--count', 'HEAD'], { env })).stdout.trim());
  await configureCoachSync(REPOSITORY, options);
  if (seed) { await enqueueCoachBundle(await replay(), options); await syncCoachBundles(options); }
  return { directory, dataDir, bare, checkout, options, control, published, tree, commits };
}
const publishedMap = async (h, prefix) => new Map(await Promise.all((await h.tree(prefix)).map(async path => [path, await h.published(path)])));
const assertMapUnchanged = async (h, map) => { for (const [path, bytes] of map) assert.equal(await h.published(path), bytes); };

test('collection publishes exact remote manifest and bytes while retaining all replay files; later replay retains collection', async t => {
  const h = await harness(t), before = await publishedMap(h), value = await snapshot();
  const result = await syncCollectionSnapshot(value, h.options);
  assert.equal(result.synced, true); assert.equal(result.verified, true); assert.equal(result.repository, REPOSITORY);
  assert.equal(result.last_synced.verified, true);
  const remoteCommit = (await execute('git', ['--git-dir', h.bare, 'rev-parse', 'HEAD'], { env })).stdout.trim();
  assert.equal(result.last_synced.commit, remoteCommit); assert.equal(result.last_synced.content_hash, value.summary.content_hash);
  await assertMapUnchanged(h, before);
  for (const [path, text] of value.files) assert.equal(await h.published(path), text);
  const staged = h.control.calls.filter(call => call.args.includes('add')).at(-1).args;
  assert.ok(staged.includes('-f')); assert.ok(staged.slice(staged.indexOf('--') + 1).every(path => path.startsWith('collection/')));
  const collectionBefore = await publishedMap(h, 'collection/');
  await enqueueCoachBundle(await replay(true), h.options); await syncCoachBundles(h.options);
  await assertMapUnchanged(h, collectionBefore);
  assert.equal(await h.published('.gitignore'), before.get('.gitignore'));
  assert.match(await h.published('README.md'), /collection\/README\.md/);
  assert.equal((await getCollectionSyncStatus(h.options)).pending, 0);
});

test('identical snapshot makes no new commit; later verification time leaves card parts untouched', async t => {
  const h = await harness(t), first = await snapshot(); await syncCollectionSnapshot(first, h.options);
  const count = await h.commits(), partPaths = [...first.files.keys()].filter(path => path.includes('/parts/'));
  const times = new Map(await Promise.all(partPaths.map(async path => [path, (await stat(join(h.checkout, path))).mtimeMs])));
  await syncCollectionSnapshot(first, h.options); assert.equal(await h.commits(), count);
  const repeated = await snapshot({ readAt: '2026-10-02T00:02:00.000Z' });
  assert.equal(first.summary.content_hash, repeated.summary.content_hash);
  await syncCollectionSnapshot(repeated, h.options); assert.equal(await h.commits(), count + 1);
  for (const path of partPaths) {
    assert.equal(repeated.files.get(path), first.files.get(path));
    assert.equal((await stat(join(h.checkout, path))).mtimeMs, times.get(path));
  }
});

test('offline fetch and rejected push retain local publication status and retry without reading Arena or duplicate commit', async t => {
  const h = await harness(t), value = await snapshot(), firstCommits = await h.commits();
  h.control.offline = true;
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'GIT_FAILED');
  let status = await getCollectionSyncStatus(h.options);
  assert.equal(status.pending, 1); assert.equal(status.last_synced, null);
  assert.doesNotMatch(JSON.stringify(status), /SyntheticSecret|\/Users\/|token@example/);
  h.control.offline = false; h.control.rejectPush = true;
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'SYNC_PUSH_FAILED');
  assert.equal(await h.commits(), firstCommits);
  const localCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: h.checkout, env })).stdout.trim();
  h.control.rejectPush = false;
  const result = await syncCollectionSnapshot(value, h.options);
  assert.equal(result.last_synced.commit, localCommit); assert.equal(await h.commits(), firstCommits + 1);
  status = await getCollectionSyncStatus(h.options); assert.equal(status.pending, 0); assert.equal(status.last_error, null);
});

test('private visibility is required at start and immediately before push; exact configured repository is required', async t => {
  const h = await harness(t), value = await snapshot(), commits = await h.commits();
  h.control.visibility = 'PUBLIC';
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'SYNC_NOT_PRIVATE');
  assert.equal(await h.commits(), commits);
  h.control.visibility = 'PRIVATE'; h.control.publicAtCheck = h.control.checks + 2;
  const calls = h.control.calls.length;
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'SYNC_NOT_PRIVATE');
  assert.equal(h.control.calls.slice(calls).some(call => call.args.includes('push')), false);
  assert.equal((await getCollectionSyncStatus(h.options)).last_synced, null);
  const statePath = join(h.dataDir, 'coach-sync', 'state.json'), state = JSON.parse(await readFile(statePath, 'utf8'));
  state.repository = 'fixture-owner/another-private-repository'; await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'COLLECTION_SYNC_REPOSITORY');
});

test('unknown/ignored files, foreign staged data and credential history stop collection before writes or push', async t => {
  const h = await harness(t), value = await snapshot(), before = await publishedMap(h);
  const privateNote = join(h.checkout, 'private-note.txt'); await writeFile(privateNote, 'Untracked private note');
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'SYNC_DIRTY');
  assert.equal(await readFile(privateNote, 'utf8'), 'Untracked private note'); await rm(privateNote);
  const replayPath = join(h.checkout, 'latest', 'summary.json'), exact = await readFile(replayPath, 'utf8');
  await writeFile(replayPath, '{"safe":true}\n'); await execute('git', ['add', '--', 'latest/summary.json'], { cwd: h.checkout, env });
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'SYNC_DIRTY');
  assert.equal((await execute('git', ['show', ':latest/summary.json'], { cwd: h.checkout, env })).stdout, '{"safe":true}\n');
  // Restore the test fixture intentionally; product code never resets dirty data.
  await writeFile(replayPath, exact); await execute('git', ['add', '--', 'latest/summary.json'], { cwd: h.checkout, env });
  await writeFile(join(h.checkout, 'README.md'), 'ghp_SyntheticSecretMustNotEscape\n'); await execute('git', ['add', '--', 'README.md'], { cwd: h.checkout, env });
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'MTGA_SYNC_SECURITY');
  await assertMapUnchanged(h, before);
  assert.doesNotMatch(JSON.stringify((await getCollectionSyncStatus(h.options)).last_error), /SyntheticSecret/);
});

test('foreign changes injected during staging cannot be included in the collection commit', async t => {
  const h = await harness(t), value = await snapshot(), count = await h.commits();
  h.control.afterAdd = async () => {
    h.control.afterAdd = null;
    await writeFile(join(h.checkout, 'latest', 'summary.json'), '{"safe_foreign_change":true}\n');
    await execute('git', ['add', '--', 'latest/summary.json'], { cwd: h.checkout, env });
  };
  const calls = h.control.calls.length;
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'SYNC_FOREIGN_STAGE');
  assert.equal(await h.commits(), count);
  assert.equal(h.control.calls.slice(calls).some(call => (call.args.includes('commit') && call.args.includes('-m')) || call.args.includes('push')), false);
  assert.equal((await execute('git', ['show', ':latest/summary.json'], { cwd: h.checkout, env })).stdout, '{"safe_foreign_change":true}\n');
});

test('failed pushes cannot be retried by the other namespace in either direction', async t => {
  const h = await harness(t), value = await snapshot();
  await enqueueCoachBundle(await replay(true), h.options); h.control.rejectPush = true;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'SYNC_PUSH_FAILED');
  h.control.rejectPush = false;
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'SYNC_FOREIGN_COMMIT');
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1);
  await syncCoachBundles(h.options); h.control.rejectPush = true;
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'SYNC_PUSH_FAILED');
  h.control.rejectPush = false;
  await enqueueCoachBundle(await replay(), h.options);
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'SYNC_FOREIGN_COMMIT');
  await syncCollectionSnapshot(value, h.options); const collection = await publishedMap(h, 'collection/');
  await syncCoachBundles(h.options); await assertMapUnchanged(h, collection);
});

test('shared live sync lock blocks both commands without touching existing snapshots', async t => {
  const h = await harness(t), value = await snapshot();
  let entered, release;
  const didEnter = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  h.control.fetchGate = async () => { h.control.fetchGate = null; entered(); await gate; };
  const inProgress = syncCollectionSnapshot(value, h.options); await didEnter;
  try {
    await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'SYNC_BUSY');
    await assert.rejects(syncCoachBundles(h.options), error => error.code === 'SYNC_BUSY');
  } finally { release(); }
  assert.equal((await inProgress).verified, true);
});

test('obsolete card shards are removed only within collection and manifest exactly covers the remaining remote tree', async t => {
  const h = await harness(t), before = await publishedMap(h), large = await snapshot({ count: 1000 });
  await syncCollectionSnapshot(large, h.options);
  const largeParts = [...large.files.keys()].filter(path => path.includes('/parts/'));
  assert.ok(largeParts.length > 1);
  const small = await snapshot(); await syncCollectionSnapshot(small, h.options);
  assert.deepEqual(await h.tree('collection/'), [...small.files.keys()].sort());
  await assertMapUnchanged(h, before);
  for (const path of largeParts.filter(path => !small.files.has(path))) await assert.rejects(readFile(join(h.checkout, path)));
});

test('remote content altered after push cannot be reported as verified success', async t => {
  const h = await harness(t), value = await snapshot();
  h.control.afterPush = async () => {
    h.control.afterPush = null;
    const other = join(h.directory, 'other-writer'); await execute('git', ['clone', h.bare, other], { env });
    const path = 'collection/latest/inventory.json', inventory = JSON.parse(await readFile(join(other, path), 'utf8'));
    inventory.synthetic_change = true; await writeFile(join(other, path), serializeCoachJson(inventory));
    await execute('git', ['add', '-f', '--', path], { cwd: other, env });
    await execute('git', ['-c', 'user.name=example-user', '-c', 'user.email=example-user@users.noreply.github.com', 'commit', '-m', 'Synthetic concurrent content change'], { cwd: other, env });
    await execute('git', ['push', 'origin', 'main'], { cwd: other, env });
  };
  await assert.rejects(syncCollectionSnapshot(value, h.options), error => error.code === 'COLLECTION_REMOTE_VERIFY');
  const state = await getCollectionSyncStatus(h.options); assert.equal(state.pending, 1); assert.equal(state.last_synced, null);
});

test('unknown snapshot paths and secret payloads cannot reach the data checkout', async t => {
  const h = await harness(t), original = await snapshot();
  for (const [path, text] of [['collection/raw.log', 'safe'], ['collection/latest/inventory.json', '{"access_token":"synthetic-secret"}\n']]) {
    const value = { ...original, files: new Map(original.files) }; value.files.set(path, text);
    const calls = h.control.calls.length;
    await assert.rejects(syncCollectionSnapshot(value, h.options), error => ['COLLECTION_SNAPSHOT_INVALID', 'MTGA_SYNC_SECURITY'].includes(error.code));
    assert.equal(h.control.calls.slice(calls).some(call => call.file === 'git'), false);
  }
});

test('persisted sync diagnostics cannot expose a tampered secret or discarded duplicate value', async t => {
  const h = await harness(t, { seed: false });
  await getCollectionSyncStatus(h.options);
  const statePath = join(h.dataDir, 'collection-sync', 'state.json');
  const base = { schema: 'MTGA_COLLECTION_SYNC_V1', repository: REPOSITORY, pending: false, last_synced: null, last_error: null };
  for (const text of [JSON.stringify({ ...base, extra_field: 'Unapproved diagnostics' }),
    JSON.stringify({ ...base, last_synced: { at: '2026-10-02T00:00:00.000Z', commit: '1'.repeat(40), content_hash: '2'.repeat(64), verified: false } }),
    JSON.stringify({ ...base, last_synced: { at: '2026-10-02T00:00:00.000Z', commit: ['1'.repeat(40)], content_hash: '2'.repeat(64), verified: true } }),
    JSON.stringify({ ...base, last_error: { message: 'ghp_SyntheticSecretMustNotEscape' } }),
    JSON.stringify(base).replace('"last_error":null', '"last_error":"/Users/synthetic/private.log","last_error":null')]) {
    await writeFile(statePath, text);
    await assert.rejects(getCollectionSyncStatus(h.options), error => {
      assert.equal(error.code, 'COLLECTION_SYNC_STATE');
      assert.doesNotMatch(error.message, /SyntheticSecret|\/Users\//); return true;
    });
  }
});

test('stale lock contenders never auto-delete; explicit recovery serializes and cannot remove a live writer', async t => {
  const h = await harness(t, { seed: false }), lock = join(h.dataDir, 'coach-sync', 'sync.lock');
  const deadPid = (await execute(process.execPath, ['-e', 'console.log(process.pid)'], { env })).stdout.trim();
  await writeFile(lock, deadPid);
  let entered = 0;
  const contenders = await Promise.allSettled(Array.from({ length: 8 }, () => withCoachSyncLock(h.dataDir, async () => { entered++; })));
  assert.equal(entered, 0);
  for (const result of contenders) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'SYNC_LOCK_STALE'); }
  assert.equal(await readFile(lock, 'utf8'), deadPid);
  const recoveries = await Promise.allSettled(Array.from({ length: 8 }, () => recoverCoachSyncLock(h.options)));
  assert.equal(recoveries.filter(result => result.status === 'fulfilled' && result.value.recovered).length, 1);
  for (const result of recoveries.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'SYNC_BUSY');
  await assert.rejects(readFile(lock), error => error.code === 'ENOENT');

  let release, enteredLive;
  const liveEntered = new Promise(resolve => { enteredLive = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const live = withCoachSyncLock(h.dataDir, async () => { enteredLive(); await gate; }); await liveEntered;
  try {
    await assert.rejects(recoverCoachSyncLock(h.options), error => error.code === 'SYNC_BUSY');
    await assert.rejects(withCoachSyncLock(h.dataDir, async () => { entered++; }), error => error.code === 'SYNC_BUSY');
    assert.equal(await readFile(lock, 'utf8'), String(process.pid));
  } finally { release(); }
  await live; assert.equal(entered, 0);
  assert.deepEqual(await recoverCoachSyncLock(h.options), { recovered: false });

  const recovery = join(h.dataDir, 'coach-sync', 'recovery.lock');
  await writeFile(recovery, deadPid);
  await assert.rejects(withCoachSyncLock(h.dataDir, async () => { entered++; }), error => error.code === 'SYNC_BUSY');
  await assert.rejects(recoverCoachSyncLock(h.options), error => error.code === 'SYNC_BUSY');
  assert.equal(await readFile(recovery, 'utf8'), deadPid); assert.equal(entered, 0);
});
