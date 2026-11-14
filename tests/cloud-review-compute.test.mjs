import test from 'node:test';
import assert from 'node:assert/strict';
import { createComputePool } from '../src/compute-pool.mjs';
import { bundle, filesForBundle, reportForSource } from './helpers/cloud-review-fixture.mjs';
import { readPublishedReviewSource } from '../src/review/cloud-review.mjs';
const revision = 'a'.repeat(40);
const input = ({ replay, report, sourceInput }) => ({ replay, report, sourceInput });
async function fixture(t) {
  const pool = createComputePool(); t.after(() => pool.close()); let replay;
  const value = await bundle({ richer: true, coachOptions: { multipart: true }, onReplay: raw => { replay = raw; } });
  const sourceInput = { files: filesForBundle(value), matchId: value.summary.match_id, revision };
  const source = readPublishedReviewSource(sourceInput), report = reportForSource(source);
  return { pool, replay, report, sourceInput };
}
test('worker re-verifies source bytes and local bundle before fingerprint/presentation', async t => {
  const h = await fixture(t), result = await h.pool.run('cloudReviewSync', input(h));
  assert.equal(result.status, 'ready');
  const ready = await h.pool.run('cloudReviewRead', { ...input(h), expectedFingerprint: result.fingerprint });
  assert.equal(ready.status, 'ready'); assert.equal(ready.review.notes[0].cards[0], 'Forest');
  h.replay.deck[0].quantity--;
  assert.equal((await h.pool.run('cloudReviewRead', { ...input(h), expectedFingerprint: result.fingerprint })).status, 'stale');
  assert.equal((await h.pool.run('cloudReviewSync', input(h))).status, 'stale');
});
test('missing report does not skip source manifest/parts verification in the worker', async t => {
  const h = await fixture(t);
  assert.equal((await h.pool.run('cloudReviewSync', { sourceInput: h.sourceInput, report: null })).status, 'missing');
  const path = [...h.sourceInput.files.keys()].find(name => name.endsWith('/coach.json'));
  h.sourceInput.files.set(path, '{}');
  await assert.rejects(h.pool.run('cloudReviewSync', { sourceInput: h.sourceInput, report: null }), /CPU task failed/);
});
test('stale source and unresolved evidence never acquire a ready worker verdict', async t => {
  const h = await fixture(t);
  h.report.source_content_hash = 'f'.repeat(64);
  assert.equal((await h.pool.run('cloudReviewSync', input(h))).status, 'stale');
  h.report.source_content_hash = readPublishedReviewSource(h.sourceInput).content_hash;
  h.report.notes[0].anchor = 'T999-A999';
  await assert.rejects(h.pool.run('cloudReviewSync', input(h)), /CPU task failed/);
});
test('successful bulky worker recycling does not consume the crash budget or strand queued tasks', async t => {
  const h = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await h.pool.run('cloudReviewSync', input(h))).status, 'ready');
  const fingerprint = await h.pool.run('cloudReviewFingerprint', { replay: h.replay });
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
});
