import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundle, filesForBundle, reportForSource } from './helpers/cloud-review-fixture.mjs';
import { readPublishedReviewSource } from '../src/review/cloud-review.mjs';
import { createCloudReviewReader } from '../src/review/review-sync.mjs';
import { createComputePool } from '../src/compute-pool.mjs';
const revision = 'a'.repeat(40);
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cloud-review-reader-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let replay;
  const value = await bundle({ richer: true, coachOptions: { multipart: true }, onReplay: raw => { replay = raw; } });
  const source = readPublishedReviewSource({ files: filesForBundle(value), matchId: value.summary.match_id, revision });
  const report = reportForSource(source), id = source.match_id;
  await mkdir(join(dataDir, 'coach-sync'));
  const state = { schema: 'MTGA_LOCAL_SYNC_V1', enabled: true, repository: 'fixture-owner/private-coaching', pending: [],
    synced: { [id]: { content_hash: value.contentHash } } };
  await writeFile(join(dataDir, 'coach-sync/state.json'), JSON.stringify(state));
  const control = { offline: false, missing: false, source, report, duringFetch: null, onLoad: null, branch: 'main' };
  const reader = createCloudReviewReader({ dataDir, loadReplay: async matchId => { control.onLoad?.(); return matchId === id ? replay : null; },
    fetchReview: async (_id, _game, options) => { await control.duringFetch?.(); if (control.offline) throw Error('synthetic network interruption');
      await options.onVerifiedTarget({ repository: state.repository, branch: control.branch });
      return { source: control.source, report: control.missing ? null : control.report, repository: state.repository, branch: control.branch }; } });
  t.after(() => reader.close());
  return { reader, replay, source, report, id, dataDir, control };
}
test('read-only sync caches separate reports, offline retains checked report, source/policy change removes markers', async t => {
  const h = await setup(t), { reader, id, control } = h;
  const originalState = await readFile(join(h.dataDir, 'coach-sync/state.json'), 'utf8');
  assert.equal((await reader.read(id, 1)).status, 'missing');
  assert.equal(reader.start(id, 1).code, 202); assert.equal(reader.start(id, 1).code, 202);
  await reader.wait();
  let value = await reader.read(id, 1);
  assert.equal(value.status, 'ready'); assert.equal(value.review.notes[0].cards[0], 'Forest');
  const checked = value.checked_at;
  control.offline = true; reader.start(id, 1); await reader.wait();
  value = await reader.read(id, 1); assert.equal(value.status, 'ready'); assert.equal(value.offline, true); assert.equal(value.checked_at, checked);
  h.replay.games[0].states.S1.turn = 99;
  assert.equal((await reader.read(id, 1)).status, 'stale');
  assert.equal((await reader.read('another-match', 1)).code, 404);
  assert.equal((await reader.read(id, 2)).code, 404);
  assert.equal(await readFile(join(h.dataDir, 'coach-sync/state.json'), 'utf8'), originalState);
});
test('missing remote report clears cache, malformed/changed-policy reports never become new reports', async t => {
  const { reader, id, control } = await setup(t);
  reader.start(id, 1); await reader.wait(); assert.equal((await reader.read(id, 1)).status, 'ready');
  control.report = { ...control.report, policy_version: 'cloud-visible/next' };
  reader.start(id, 1); await reader.wait(); assert.equal((await reader.read(id, 1)).status, 'stale');
  control.missing = true; reader.start(id, 1); await reader.wait(); assert.equal((await reader.read(id, 1)).status, 'missing');
  control.missing = false; control.report = { ...control.report, password: 'synthetic-sentinel' };
  reader.start(id, 1); await reader.wait(); assert.equal((await reader.read(id, 1)).status, 'error');
});
test('shutdown suppresses a late fetch result instead of publishing a cache', async t => {
  const { reader, id, control, dataDir, replay } = await setup(t);
  let release; const pending = new Promise(done => { release = done; }); control.duringFetch = async () => pending;
  reader.start(id, 1); const close = reader.close(); release(); await close;
  assert.equal(reader.start(id, 1).code, 503);
  const other = createCloudReviewReader({ dataDir, loadReplay: async () => replay });
  assert.equal((await other.read(id, 1)).status, 'missing'); await other.close();
});
test('sidecar symlink is rejected instead of opening another database', async t => {
  const { reader, id, dataDir } = await setup(t);
  await symlink(join(dataDir, 'unrelated.sqlite3'), join(dataDir, 'reviews.sqlite3'));
  await assert.rejects(reader.read(id, 1), /cache-file/);
});

test('deck, starting hand, other game and historical context changes invalidate the full local input', async t => {
  const { reader, id, replay } = await setup(t);
  reader.start(id, 1); await reader.wait(); assert.equal((await reader.read(id, 1)).status, 'ready');
  const original = structuredClone(replay);
  for (const mutate of [r => { r.deck[0].quantity--; }, r => { r.games[0].starting_hand.push({ name: 'Island' }); },
    r => { r.coachNotes = [{ text: '新的历史背景' }]; }, r => { r.games.push({ game_number: 2, steps: [] }); }]) {
    for (const key of Object.keys(replay)) delete replay[key]; Object.assign(replay, structuredClone(original)); mutate(replay);
    assert.equal((await reader.read(id, 1)).status, 'stale');
  }
});

test('deck mutation between validated bundle and cache publication is rejected', async t => {
  const { reader, id, replay, control, dataDir } = await setup(t); let reads = 0;
  control.onLoad = () => { if (++reads === 2) replay.deck[0].quantity--; };
  reader.start(id, 1); await reader.wait(); assert.equal((await reader.read(id, 1)).status, 'stale');
  const other = createCloudReviewReader({ dataDir, loadReplay: async () => replay });
  assert.equal((await other.read(id, 1)).status, 'stale'); await other.close();
});

test('a newly verified branch cannot fall back to another branch cache after error or restart', async t => {
  const { reader, id, control, replay, dataDir } = await setup(t);
  reader.start(id, 1); await reader.wait(); assert.equal((await reader.read(id, 1)).status, 'ready');
  control.branch = 'new-main'; control.report = { ...control.report, unknown_field: 'reject' };
  reader.start(id, 1); await reader.wait(); assert.equal((await reader.read(id, 1)).status, 'error');
  const other = createCloudReviewReader({ dataDir, loadReplay: async () => replay });
  assert.equal((await other.read(id, 1)).status, 'missing'); await other.close();
});

test('a remotely observed stale report cannot become ready again after restart with unchanged local input', async t => {
  const { reader, id, control, replay, dataDir } = await setup(t);
  reader.start(id, 1); await reader.wait(); assert.equal((await reader.read(id, 1)).status, 'ready');
  control.report = { ...control.report, source_content_hash: 'f'.repeat(64) };
  reader.start(id, 1); await reader.wait(); assert.equal((await reader.read(id, 1)).status, 'stale');
  const cold = createCloudReviewReader({ dataDir, loadReplay: async () => replay });
  assert.equal((await cold.read(id, 1)).status, 'stale'); await cold.close();
});

test('same-branch late worker cannot overwrite a newer observed report revision', async t => {
  const h = await setup(t), { replay, dataDir, id, source, report } = h;
  const second = readPublishedReviewSource({ files: filesForBundle(await bundle({ richer: true, coachOptions: { multipart: true } })), matchId: id, revision: 'b'.repeat(40) });
  let enter, release; const entered = new Promise(done => { enter = done; }), blocked = new Promise(done => { release = done; });
  const pool = createComputePool(); t.after(() => pool.close());
  const fetcher = (value, headline) => async (_id, _game, hooks) => {
    const scope = { repository: 'fixture-owner/private-coaching', branch: 'main' };
    await hooks.onVerifiedTarget(scope); await hooks.onVerifiedRevision({ ...scope, matchId: id, gameNumber: 1, revision: value.revision });
    return { ...scope, source: value, report: { ...reportForSource(value), summary: { ...report.summary, headline } } };
  };
  const slow = createCloudReviewReader({ dataDir, loadReplay: async () => replay, fetchReview: fetcher(source, '较早报告'), computePool: {
    run: async (operation, input) => { if (operation === 'cloudReviewLocal') { enter(); await blocked; } return pool.run(operation, input); }
  } });
  const fast = createCloudReviewReader({ dataDir, loadReplay: async () => replay, fetchReview: fetcher(second, '最新报告') });
  t.after(() => Promise.all([slow.close(), fast.close()]));
  slow.start(id, 1); await entered; fast.start(id, 1); await fast.wait();
  assert.equal((await fast.read(id, 1)).review.summary.headline, '最新报告');
  release(); await slow.wait();
  const cold = createCloudReviewReader({ dataDir, loadReplay: async () => replay });
  assert.equal((await cold.read(id, 1)).review.summary.headline, '最新报告'); await cold.close();
});

test('revision receipts are scoped per match and do not invalidate another match cache', async t => {
  const h = await setup(t); h.reader.start(h.id, 1); await h.reader.wait();
  let replay;
  const value = await bundle({ id: 'synthetic-other-match', richer: true, coachOptions: { multipart: true }, onReplay: raw => { replay = raw; } });
  const source = readPublishedReviewSource({ files: filesForBundle(value), matchId: value.summary.match_id, revision: 'c'.repeat(40) });
  const statePath = join(h.dataDir, 'coach-sync/state.json'), state = JSON.parse(await readFile(statePath));
  state.synced[source.match_id] = { content_hash: source.content_hash }; await writeFile(statePath, JSON.stringify(state));
  const other = createCloudReviewReader({ dataDir: h.dataDir, loadReplay: async () => replay, fetchReview: async (_id, _game, hooks) => {
    const scope = { repository: state.repository, branch: 'main' };
    await hooks.onVerifiedTarget(scope); await hooks.onVerifiedRevision({ ...scope, matchId: source.match_id, gameNumber: 1, revision: source.revision });
    return { ...scope, source, report: reportForSource(source) };
  } });
  other.start(source.match_id, 1); await other.wait(); assert.equal((await other.read(source.match_id, 1)).status, 'ready');
  assert.equal((await h.reader.read(h.id, 1)).status, 'ready'); await other.close();
});

test('a read worker cannot return ready after another reader has persisted remote stale', async t => {
  const h = await setup(t); h.reader.start(h.id, 1); await h.reader.wait();
  let enter, release; const entered = new Promise(done => { enter = done; }), blocked = new Promise(done => { release = done; });
  const pool = createComputePool(); t.after(() => pool.close());
  const slow = createCloudReviewReader({ dataDir: h.dataDir, loadReplay: async () => h.replay, computePool: {
    run: async (operation, input) => { const result = await pool.run(operation, input); if (operation === 'cloudReviewRead') { enter(); await blocked; } return result; }
  } }); t.after(() => slow.close());
  const pending = slow.read(h.id, 1); await entered;
  h.control.report = { ...h.control.report, source_content_hash: 'f'.repeat(64) };
  h.reader.start(h.id, 1); await h.reader.wait(); release();
  assert.equal((await pending).status, 'stale');
});
