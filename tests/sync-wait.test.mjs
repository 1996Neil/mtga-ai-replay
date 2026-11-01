import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { withCoachSyncLock, CoachSyncError, configureCoachSync, enqueueCoachBundle, syncCoachBundles } from '../src/coach-sync.mjs';
import { createViewerTask } from '../src/viewer-task.mjs';
import { createTaskJournal } from '../src/task-journal.mjs';
import { DatabaseSync } from 'node:sqlite';
import { syncReplays } from '../src/replay-sync.mjs';
import { bundle, harness } from './helpers/cloud-review-fixture.mjs';
import { replayWorker } from '../src/replay-worker.mjs';

async function directory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'sync-wait-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'coach-sync'));
  return dataDir;
}
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}
async function holder(t, dataDir) {
  const release = deferred(), ready = deferred();
  const complete = withCoachSyncLock(dataDir, async () => { ready.resolve(); await release.promise; });
  await ready.promise;
  t.after(async () => { release.resolve(); await complete; });
  return { release: async () => { release.resolve(); await complete; } };
}

test('a real second process waits without entering work and continues exactly once after release', async t => {
  const dataDir = await directory(t), moduleUrl = new URL('../src/coach-sync.mjs', import.meta.url).href;
  const code = `import{withCoachSyncLock}from ${JSON.stringify(moduleUrl)};
    await withCoachSyncLock(process.argv[1],async()=>{process.send('held');await new Promise(done=>process.once('message',done));});
    process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, dataDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exit; });
  assert.equal((await once(child, 'message'))[0], 'held');
  const phases = [], waiting = deferred(); let calls = 0;
  const pending = withCoachSyncLock(dataDir, async () => { calls++; return 'complete'; }, {
    waitForSync: true, syncWaitTimeoutMs: 2000, onProgress: value => { phases.push(value.phase); if (value.phase === 'waiting') waiting.resolve(); },
  });
  await waiting.promise;
  assert.equal(calls, 0);
  assert.equal((await readFile(join(dataDir, 'coach-sync/sync.lock'), 'utf8')).trim(), String(child.pid));
  child.send('release');
  assert.equal(await pending, 'complete'); assert.equal(calls, 1);
  assert.deepEqual(phases, ['waiting', 'comparing']);
  assert.deepEqual(await exit, [0, null]);
});

test('waiting viewers keep one running task, preserve waiting progress and do not repeat work', async t => {
  const dataDir = await directory(t), held = await holder(t, dataDir), waiting = deferred();
  const journal = createTaskJournal(dataDir); t.after(() => journal.close());
  let calls = 0;
  const task = createViewerTask({ kind: 'replay', journal, errorMessage: error => error.message,
    workflow: ({ onProgress }) => withCoachSyncLock(dataDir, async () => { calls++; return { status: 'succeeded' }; }, {
      waitForSync: true, syncWaitTimeoutMs: 2000, onProgress: progress => { onProgress(progress); if (progress.phase === 'waiting') waiting.resolve(); },
    }) });
  const first = task.start(); await waiting.promise;
  assert.equal(task.snapshot().status, 'running'); assert.equal(task.snapshot().progress.phase, 'waiting');
  assert.equal(task.start().id, first.id); assert.equal(calls, 0);
  const db = new DatabaseSync(join(dataDir, 'tasks/journal.sqlite3'), { readOnly: true });
  try { assert.equal(JSON.parse(db.prepare("SELECT value FROM task WHERE kind='replay'").get().value).progress.phase, 'waiting'); }
  finally { db.close(); }
  await held.release(); await task.wait();
  assert.equal(task.snapshot().id, first.id); assert.equal(task.snapshot().status, 'succeeded'); assert.equal(calls, 1);
});

test('timeout and cancellation leave the live owner lock and never enter the callback', async t => {
  const dataDir = await directory(t), held = await holder(t, dataDir), lock = join(dataDir, 'coach-sync/sync.lock');
  const original = await readFile(lock); let calls = 0;
  await assert.rejects(withCoachSyncLock(dataDir, () => { calls++; }, { waitForSync: true, syncWaitTimeoutMs: 20 }),
    error => error.code === 'SYNC_WAIT_TIMEOUT');
  assert.deepEqual(await readFile(lock), original);
  const abort = new AbortController();
  await assert.rejects(withCoachSyncLock(dataDir, () => { calls++; }, { waitForSync: true, signal: abort.signal,
    onProgress: () => abort.abort() }), error => error.name === 'AbortError');
  assert.equal(calls, 0); assert.deepEqual(await readFile(lock), original); await held.release();
});

test('a lock released after the waiting deadline cannot start a late callback', async t => {
  const dataDir = await directory(t), held = await holder(t, dataDir);
  let calls = 0, release;
  const pending = withCoachSyncLock(dataDir, () => { calls++; }, {
    waitForSync: true, syncWaitTimeoutMs: 10,
    onProgress: () => {
      // Simulate an occupied event loop that wakes after the nominal deadline.
      const stop = performance.now() + 25; while (performance.now() < stop) {}
      release = held.release();
    },
  });
  await assert.rejects(pending, error => error.code === 'SYNC_WAIT_TIMEOUT');
  await release; assert.equal(calls, 0);
});

test('legacy callers still fail fast, malformed and stale locks require recovery, and recovery gates are never bypassed', async t => {
  const dataDir = await directory(t), lock = join(dataDir, 'coach-sync/sync.lock');
  await writeFile(lock, String(process.pid));
  await assert.rejects(withCoachSyncLock(dataDir, () => assert.fail()), error => error.code === 'SYNC_BUSY');
  await writeFile(lock, '');
  await assert.rejects(withCoachSyncLock(dataDir, () => assert.fail(), { waitForSync: true }), error => error.code === 'SYNC_BUSY');
  assert.equal(await readFile(lock, 'utf8'), '');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); await once(child, 'exit');
  await writeFile(lock, String(child.pid));
  await assert.rejects(withCoachSyncLock(dataDir, () => assert.fail(), { waitForSync: true }), error => error.code === 'SYNC_LOCK_STALE');
  assert.equal(await readFile(lock, 'utf8'), String(child.pid));
  await rm(lock);
  await writeFile(join(dataDir, 'coach-sync/recovery.lock'), String(process.pid));
  await assert.rejects(withCoachSyncLock(dataDir, () => assert.fail(), { waitForSync: true }), error => error.code === 'SYNC_BUSY');
});

test('a callback with an uncertain push outcome is not replayed after acquisition', async t => {
  const dataDir = await directory(t), held = await holder(t, dataDir), waiting = deferred(); let calls = 0;
  const pending = withCoachSyncLock(dataDir, () => { calls++; throw new CoachSyncError('SYNC_PUSH_TIMEOUT', 'Unverified push'); }, {
    waitForSync: true, syncWaitTimeoutMs: 2000, onProgress: progress => { if (progress.phase === 'waiting') waiting.resolve(); },
  });
  await waiting.promise; await held.release();
  await assert.rejects(pending, error => error.code === 'SYNC_PUSH_TIMEOUT'); assert.equal(calls, 1);
  await assert.rejects(readFile(join(dataDir, 'coach-sync/sync.lock')), { code: 'ENOENT' });
});

test('draft publication worker relays waiting without treating progress as a result or crashing on an observer error', async t => {
  const dataDir = await directory(t), held = await holder(t, dataDir), waiting = deferred(), phases = [];
  let settled = false;
  const pending = replayWorker('draft-publication', { dataDir, waitForSync: true, syncWaitTimeoutMs: 2000 }, {
    onProgress: progress => { phases.push(progress.phase); if (progress.phase === 'waiting') waiting.resolve(); throw Error('Synthetic observer failure'); },
  });
  const checked = assert.rejects(pending, /本地回放处理未全部完成/).then(() => { settled = true; });
  await waiting.promise; assert.equal(settled, false);
  await held.release();
  // The fixture has no configured destination. It reaches that check only
  // after releasing the live lock, and sends one final failure rather than
  // mistaking its earlier progress messages for a successful publication.
  await checked;
  assert.deepEqual(phases, ['waiting', 'comparing']);
  await assert.rejects(readFile(join(dataDir, 'coach-sync/sync.lock')), { code: 'ENOENT' });
});

test('the real replay workflow waits for a competing draft writer before any remote request and finishes once', async t => {
  const h = await harness(t);
  await configureCoachSync('fixture-owner/private-coaching', h.options);
  await enqueueCoachBundle(await bundle(), h.options);
  await syncCoachBundles({ ...h.options, fastSync: true });
  const before = await h.commits(), held = await holder(t, h.dataDir), waiting = deferred();
  let remote = 0;
  const runCommand = (...args) => { remote++; return h.options.runCommand(...args); };
  const pending = syncReplays({ ...h.options, runCommand, workerCount: 0, syncWaitTimeoutMs: 3000,
    onProgress: progress => { if (progress.phase === 'waiting') waiting.resolve(); } });
  await waiting.promise;
  assert.equal(remote, 0, 'No repeated Git/remote scan while waiting');
  const duplicate = syncReplays({ ...h.options, runCommand, workerCount: 0 });
  assert.equal(duplicate, pending);
  await held.release();
  const result = await pending;
  assert.equal(result.status, 'succeeded'); assert.equal(result.downloaded, 1);
  assert.equal(await h.commits(), before, 'Waiting alone does not create another publication');
});
