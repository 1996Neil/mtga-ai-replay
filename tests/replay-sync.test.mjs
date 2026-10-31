import test from 'node:test';
import assert from 'node:assert/strict';
import { bundle, harness } from './helpers/cloud-review-fixture.mjs';
import { configureCoachSync, enqueueCoachBundle, syncCoachBundles } from '../src/coach-sync.mjs';
import { syncReplays } from '../src/replay-sync.mjs';
import { listReplays } from '../src/history.mjs';
import { archiveReplays, getReplay } from '../src/history.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { saveReplaySettings } from '../src/replay-settings.mjs';
import { buildCoachBundle } from '../src/coach-bundle.mjs';
test('sync downloads cloud-only replay and unchanged repeat neither rebuilds nor uploads it', async t => {
  const h = await harness(t);
  await configureCoachSync('fixture-owner/private-coaching', h.options);
  const value = await bundle();
  await enqueueCoachBundle(value, h.options);
  await syncCoachBundles({ ...h.options, fastSync: true });
  const before = await h.commits();
  const first = await syncReplays({ ...h.options, workerCount: 0 });
  assert.equal(first.downloaded, 1);
  assert.equal(first.published, 0);
  assert.equal((await listReplays({ dataDir: h.dataDir })).length, 1);
  const second = await syncReplays({ ...h.options, workerCount: 0 });
  assert.equal(second.downloaded, 0);
  assert.equal(await h.commits(), before);
  assert.equal(second.remote_checked, true);
});
test('successful match sync refreshes draft associations without new picks and reports association failure separately', async t => {
  const h = await harness(t);
  await configureCoachSync('fixture-owner/private-coaching', h.options);
  await enqueueCoachBundle(await bundle(), h.options); await syncCoachBundles({ ...h.options, fastSync: true });
  // Injected publisher owns the fixture; no game read or real remote is used.
  await writeFile(join(h.dataDir, 'draft-capture.sqlite3'), 'synthetic publisher marker');
  let calls = 0;
  const failed = await syncReplays({ ...h.options, workerCount: 0,
    draftPublisher: async () => { calls++; throw Error('Synthetic draft publication failure'); } });
  assert.equal(calls, 1); assert.equal(failed.status, 'partial'); assert.match(failed.error, /轮抽关联发布尚未完成/);
  assert.equal(failed.downloaded, 1);
  const success = await syncReplays({ ...h.options, workerCount: 0,
    draftPublisher: async () => { calls++; return { verified: true, linked_runs: 1, pending_runs: 0, revision: 'a'.repeat(40) }; } });
  assert.equal(calls, 2); assert.equal(success.status, 'succeeded'); assert.equal(success.draft_links.linked_runs, 1);
});
test('saved retention days filter both old local upload candidates and old cloud downloads', async t => {
  const h = await harness(t);
  await configureCoachSync('fixture-owner/private-coaching', h.options);
  await enqueueCoachBundle(await bundle({ id: 'cloud-too-old', started: '2020-01-01T00:00:00Z' }), h.options);
  await enqueueCoachBundle(await bundle({ id: 'cloud-recent', started: new Date(Date.now() - 86400000).toISOString() }), h.options);
  await syncCoachBundles({ ...h.options, fastSync: true });
  await archiveReplays([{ match: { id: 'local-too-old', started_at: '2020-01-01T00:00:00Z' }, games: [] }], h.options);
  await saveReplaySettings({ retention_days: 7 }, h.dataDir);
  const result = await syncReplays({ ...h.options, workerCount: 0 });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.downloaded, 1);
  assert.equal(result.published, 0);
  assert.equal(await getReplay('cloud-too-old', h.options), null);
  assert.ok(await getReplay('cloud-recent', h.options));
  assert.ok(!JSON.parse(await h.published('index.json')).matches.some(row => row.match_id === 'local-too-old'));
});
test('remote updates of an existing download are applied once, while simultaneous edits preserve both sides', async t => {
  const h = await harness(t);
  await configureCoachSync('fixture-owner/private-coaching', h.options);
  const first = await bundle({ id: 'versioned' });
  await enqueueCoachBundle(first, h.options); await syncCoachBundles({ ...h.options, fastSync: true });
  await syncReplays({ ...h.options, workerCount: 0 });
  const richer = await bundle({ id: 'versioned', richer: true });
  await enqueueCoachBundle(richer, h.options); await syncCoachBundles({ ...h.options, fastSync: true });
  assert.equal((await syncReplays({ ...h.options, workerCount: 0 })).downloaded, 1);
  assert.equal((await syncReplays({ ...h.options, workerCount: 0 })).published, 0);
  const local = await getReplay('versioned', h.options);
  local.match.player = 'Locally changed';
  const revision = (await listReplays(h.options))[0].replay_revision;
  await archiveReplays([local], { ...h.options, replaceRevision: revision });
  // Change cloud independently after the last downloaded baseline.
  const cloud = await bundle({ id: 'versioned', richer: true, onReplay: replay => { replay.match.player = 'Cloud changed'; } });
  // Different generated time alone does not change content; change the public
  // static card field through the builder option to exercise a changed hash.
  const changed = await bundle({ id: 'versioned', richer: true, coachOptions: { cards: [] } });
  await enqueueCoachBundle(changed, h.options); await syncCoachBundles({ ...h.options, fastSync: true });
  const commits = await h.commits();
  const result = await syncReplays({ ...h.options, workerCount: 0 });
  assert.equal(result.failed, 1);
  assert.equal(await h.commits(), commits);
  assert.equal((await getReplay('versioned', h.options)).match.player, 'Locally changed');
});

test('an already published identical local repair reconciles an older receipt without replacing or uploading the replay', async t => {
  const h = await harness(t);
  await configureCoachSync('fixture-owner/private-coaching', h.options);
  const first = await bundle({ id: 'already-published-repair' });
  await enqueueCoachBundle(first, h.options); await syncCoachBundles({ ...h.options, fastSync: true });
  await syncReplays({ ...h.options, workerCount: 0 });
  const replay = await getReplay(first.summary.match_id, h.options);
  const baseline = (await listReplays(h.options))[0].replay_revision;
  replay.match.player = 'Synthetic repaired display';
  await archiveReplays([replay], { ...h.options, replaceRevision: baseline });
  const current = (await listReplays(h.options))[0].replay_revision;
  const repaired = await buildCoachBundle(await getReplay(first.summary.match_id, h.options),
    { cards: first.cards, historyKey: first.historyKey, multipart: true });
  await enqueueCoachBundle(repaired, h.options); await syncCoachBundles({ ...h.options, fastSync: true });
  const commits = await h.commits();
  const result = await syncReplays({ ...h.options, workerCount: 0 });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.downloaded, 0); assert.equal(result.updated, 0);
  assert.equal(await h.commits(), commits);
  assert.equal((await listReplays(h.options))[0].replay_revision, current);
  const receipt = JSON.parse(await readFile(join(h.dataDir, 'replay-remote-receipts.json'), 'utf8'));
  assert.equal(receipt[first.summary.match_id].content_hash, repaired.contentHash);
  assert.equal(receipt[first.summary.match_id].local_revision, current);
});
