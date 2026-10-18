import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createReplayAutoUpload, hasUnverifiedReplayAutoUpload } from '../src/replay-auto-upload.mjs';

const binding = { repository: 'fixture-owner/private-coaching', repository_id: 'R_fixture', branch: 'main' };
const digest = value => createHash('sha256').update(value).digest('hex');
const failed = code => Object.assign(Error('Synthetic private error must not appear'), { code });
async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'replay-auto-test-'));
  let time = Date.parse('2026-10-01T12:00:00Z'), busy = false;
  const catalog = [], remote = new Set(), calls = [], control = {};
  const reference = id => ({ match_id: id, started_at: catalog.find(item => item.id === id).started_at, history_key: id, content_hash: digest(id) });
  const transport = {
    list: async () => catalog,
    inspect: async id => { calls.push(['inspect', id]); if (control.offline) throw failed('GITHUB_UNAVAILABLE'); return { source: 'remote', pending: [], index: { matches: [] } }; },
    prepare: async id => { calls.push(['prepare', id]); return reference(id); },
    verify: async ref => { calls.push(['verify', ref.match_id]); if (control.verifyOffline) throw failed('GITHUB_UNAVAILABLE'); return remote.has(ref.content_hash) ? { verified: true, content_hash: ref.content_hash, commit: 'a'.repeat(40) } : { verified: false }; },
    publish: async (ref, progress) => {
      calls.push(['publish', ref.match_id]);
      if (control.offlineBeforeWrite) throw failed('GITHUB_UNAVAILABLE');
      progress({ checkpoint: { commit: 'a'.repeat(40), destination_hash: digest('destination') } });
      if (!control.rejectWrite) remote.add(ref.content_hash);
      if (control.loseResponse) { control.verifyOffline = true; throw failed('SYNC_PUSH_TIMEOUT'); }
    },
  };
  const options = { dataDir, enabled: true, binding, transport, now: () => time, isBusy: () => busy,
    pollIntervalMs: 60000, retryBaseMs: 100, retryMaxMs: 1000 };
  let controller;
  const open = () => controller = createReplayAutoUpload(options);
  const complete = (id, overrides = {}) => { time += 1000; catalog.push({ id, started_at: new Date(time).toISOString(), result: 'Win', step_count: 2, auto_upload_ready: true, ...overrides }); };
  t.after(async () => { await controller?.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, options, calls, catalog, control, remote, reference, open, complete,
    advance: (ms = 1000) => { time += ms; }, busy: value => { busy = value; } };
}

test('default OFF creates no ledger and cannot call transport', async t => {
  const h = await harness(t);
  const queue = createReplayAutoUpload({ ...h.options, enabled: false });
  assert.equal((await queue.check()).status, 'disabled'); queue.start(); await queue.close();
  assert.equal(h.calls.length, 0);
  await assert.rejects(stat(join(h.dataDir, 'tasks')), { code: 'ENOENT' });
});

test('activation excludes history, later discovered old logs, incomplete and unknown matches', async t => {
  const h = await harness(t); h.complete('historical');
  const queue = h.open(); await queue.check();
  h.complete('late-old-log', { started_at: '2026-09-01T00:00:00Z' });
  h.complete('unfinished', { result: null }); h.complete('no-detail', { step_count: 0 });
  await queue.check(); assert.equal(h.calls.filter(([kind]) => kind === 'publish').length, 0);
  h.complete('new-completed'); await queue.check();
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'publish'), [['publish', 'new-completed']]);
});

test('duplicate completion observations and concurrent ticks publish exactly once', async t => {
  const h = await harness(t), queue = h.open(); await queue.check(); h.complete('new-match');
  await Promise.all([queue.check(), queue.check(), queue.check()]);
  h.catalog.push({ ...h.catalog[0] }); await queue.check();
  assert.equal(queue.snapshot().succeeded, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'prepare').length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'publish').length, 1);
});

test('offline queue and immutable prepared receipt survive restart without regeneration', async t => {
  const h = await harness(t); let queue = h.open(); await queue.check(); h.complete('offline-match');
  h.control.offlineBeforeWrite = true; await queue.check();
  assert.equal(queue.snapshot().queued, 1); assert.equal(hasUnverifiedReplayAutoUpload(h.dataDir), false);
  await queue.close(); h.advance(); queue = h.open();
  h.control.offlineBeforeWrite = false; await queue.check();
  assert.equal(queue.snapshot().succeeded, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'prepare').length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'publish').length, 2, 'one definitely pre-write offline attempt, then one write');
});

test('lost response remains fail-closed across restart, then acknowledges exact remote receipt without reupload', async t => {
  const h = await harness(t); let queue = h.open(); await queue.check(); h.complete('uncertain-match');
  h.control.loseResponse = true; await queue.check();
  assert.equal(queue.snapshot().needs_recovery, 1); assert.equal(hasUnverifiedReplayAutoUpload(h.dataDir), true);
  await queue.close(); h.advance(); queue = h.open(); await queue.check();
  assert.equal(queue.snapshot().needs_recovery, 1);
  h.control.verifyOffline = false; h.advance(); await queue.check();
  assert.equal(queue.snapshot().succeeded, 1); assert.equal(hasUnverifiedReplayAutoUpload(h.dataDir), false);
  assert.equal(h.calls.filter(([kind]) => kind === 'publish').length, 1);
});

test('unknown write absent remotely blocks newer jobs and never retries the write', async t => {
  const h = await harness(t), queue = h.open(); await queue.check(); h.complete('uncertain-match');
  h.control.loseResponse = true; h.control.rejectWrite = true; await queue.check();
  h.control.verifyOffline = false; h.complete('later-match');
  for (let i = 0; i < 3; i++) { h.advance(); await queue.check(); }
  assert.equal(queue.snapshot().needs_recovery, 1); assert.equal(queue.snapshot().queued, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'publish').length, 1);
});

test('manual job owns the lane; manual receipt can satisfy queued auto work', async t => {
  const h = await harness(t), queue = h.open(); await queue.check(); h.complete('manual-fallback');
  h.busy(true); await queue.check(); assert.equal(queue.snapshot().queued, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'publish').length, 0);
  h.remote.add(digest('manual-fallback')); h.busy(false); await queue.check();
  assert.equal(queue.snapshot().succeeded, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'publish').length, 0);
});

test('interrupted publishing marker is read-only recovery, never a restart upload', async t => {
  const h = await harness(t); let queue = h.open(); await queue.check(); h.complete('interrupted');
  h.control.offlineBeforeWrite = true; await queue.check(); await queue.close();
  const db = new DatabaseSync(join(h.dataDir, 'tasks', 'replay-auto-upload.sqlite3'));
  const row = JSON.parse(db.prepare('SELECT value FROM work WHERE match_id=?').get('interrupted').value);
  db.prepare('UPDATE work SET value=? WHERE match_id=?').run(JSON.stringify({ ...row, status: 'publishing' }), 'interrupted'); db.close();
  h.advance(); h.control.offlineBeforeWrite = false; queue = h.open(); await queue.check();
  assert.equal(queue.snapshot().needs_recovery, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'publish').length, 1);
});

test('same directory cannot have two live controllers or silently change repository binding', async t => {
  const h = await harness(t), queue = h.open(); await queue.check();
  assert.throws(() => createReplayAutoUpload(h.options), { code: 'AUTO_UPLOAD_BUSY' });
  await queue.close();
  assert.throws(() => createReplayAutoUpload({ ...h.options, binding: { ...binding, repository_id: 'R_recreated' } }), { code: 'SYNC_BINDING' });
});

test('ledger contains bounded IDs and receipts, with private file permissions', async t => {
  const h = await harness(t), queue = h.open(); await queue.check(); h.complete('sanitized'); await queue.check();
  const path = join(h.dataDir, 'tasks', 'replay-auto-upload.sqlite3');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const bytes = await readFile(path); assert.equal(bytes.includes(Buffer.from('Synthetic private error')), false);
  assert.equal(bytes.includes(Buffer.from('Player.log')), false);
});


test('first enabled offline startup persists consent baseline and queues later completions across restart', async t => {
  const h = await harness(t); h.complete('old-before-enable'); h.control.offline = true;
  let queue = h.open(); await queue.check();
  assert.equal(queue.snapshot().initialized, true); assert.equal(queue.snapshot().binding_verified, false);
  h.complete('played-while-offline'); await queue.check(); assert.equal(queue.snapshot().queued, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'publish').length, 0);
  await queue.close(); h.advance(); queue = h.open(); h.control.offline = false;
  await queue.check(); assert.equal(queue.snapshot().succeeded, 1); assert.equal(queue.snapshot().binding_verified, true);
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'publish'), [['publish', 'played-while-offline']]);
});

test('tutorial exclusion is terminal skipped, never succeeded, and continues to eligible peer', async t => {
  const h = await harness(t), original = h.options.transport.prepare;
  h.options.transport.prepare = async id => { if (id === 'tutorial') throw failed('SYNC_TUTORIAL_EXCLUDED'); return original(id); };
  const queue = h.open(); await queue.check(); h.complete('tutorial'); h.complete('ordinary');
  await queue.check(); assert.equal(queue.snapshot().skipped_tutorial, 1); assert.equal(queue.snapshot().succeeded, 1);
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'publish'), [['publish', 'ordinary']]);
  await queue.check(); assert.equal(queue.snapshot().skipped_tutorial, 1);
});

test('unknown tutorial classification holds without falsely acknowledging upload', async t => {
  const h = await harness(t); h.options.transport.prepare = async () => { throw failed('SYNC_TUTORIAL_HOLD'); };
  const queue = h.open(); await queue.check(); h.complete('unknown'); await queue.check();
  assert.equal(queue.snapshot().blocked, 1); assert.equal(queue.snapshot().succeeded, 0); assert.equal(queue.snapshot().skipped_tutorial, 0);
  assert.equal(queue.snapshot().issues[0].code, 'SYNC_TUTORIAL_HOLD');
  assert.equal(h.calls.some(([kind]) => kind === 'publish'), false);
});
