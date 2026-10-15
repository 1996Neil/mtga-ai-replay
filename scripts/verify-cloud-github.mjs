// Explicit opt-in network experiment. Only a synthetic-only P1 sandbox may be
// admitted. Never point this harness at a production data or source repository.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundle, reportForSource } from '../tests/helpers/cloud-review-fixture.mjs';
import { configureCoachSync, enqueueCoachBundle, syncCoachBundles } from '../src/coach-sync.mjs';
import { fetchCloudReview, createCloudReviewReader } from '../src/review/review-sync.mjs';
import { createGitHubReviewWriter } from '../src/review/github-review-writer.mjs';
import { publishCloudReview } from '../src/review/cloud-review-writer.mjs';
import { validateCloudReviewBinding } from '../src/review/cloud-review.mjs';
import { buildCoachBundle } from '../src/coach-bundle.mjs';

async function api(method, endpoint, body) {
  return new Promise((yes, no) => {
    const child = execFile('gh', ['api', '--hostname', 'github.com', '--method', method, endpoint, ...(body ? ['--input', '-'] : [])],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, text) => {
        if (error) return no(Error('Isolated GitHub experiment request unconfirmed'));
        try { const value = JSON.parse(text); if (value.errors?.length) throw Error(); yes(value); } catch { no(Error('Isolated GitHub experiment response unconfirmed')); }
      });
    child.stdin.on('error', () => no(Error('Isolated GitHub experiment request unconfirmed'))); child.stdin.end(body ? JSON.stringify(body) : undefined);
  });
}
const repository = process.argv[2], dataDir = resolve(process.argv[3] ?? '');
if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/mtga-replay-p1-sandbox-[0-9-]{8,32}$/.test(repository ?? '') || !process.argv[3]) throw Error('Explicit synthetic sandbox repository and NEW data directory required.');
await mkdir(dataDir, { mode: 0o700 }); // Existing stores cannot be reused.
const meta = await api('GET', `repos/${repository}`);
assert.equal(meta.private, true); assert.equal(meta.full_name, repository);
assert.equal(meta.description, 'Synthetic-only isolated Replay cloud review P1 acceptance; no real matches or notes');
assert.equal(meta.size, 0); // A nonempty remote is never overwritten by this harness.
const options = { dataDir }; let replay;
const first = await bundle({ richer: true, coachOptions: { multipart: true }, onReplay: raw => { replay = raw; } });
assert.ok(replay.match.id.startsWith('synthetic-'));
await configureCoachSync(repository, options); await enqueueCoachBundle(first, options);
assert.equal((await syncCoachBundles(options)).synced, true);
const remote = await fetchCloudReview(replay.match.id, 1, options);
const report = reportForSource(remote.source); report.schema = 'MTGA_AI_REVIEW_V2';
delete report.notes[0].severity; Object.assign(report.notes[0], { importance: 'critical', assessment: 'possible_error', confidence: 'low' });
const target = { repository, repositoryId: meta.id, nodeId: meta.node_id, branch: remote.branch, matchId: replay.match.id, gameNumber: 1 };
const input = { repository, branch: remote.branch, expectedHeadOid: remote.source.revision, expectedBlobOid: null, source: remote.source, report };
const receipt = await publishCloudReview(input, createGitHubReviewWriter(target));
const afterFirst = await fetchCloudReview(replay.match.id, 1, options);
assert.equal(validateCloudReviewBinding(afterFirst.report, afterFirst.source).status, 'ready');
const firstCommit = await api('GET', `repos/${repository}/git/commits/${receipt.commitOid}`);
assert.equal(firstCommit.author.email, 'mtga-cloud-review@users.noreply.github.com'); assert.equal(firstCommit.committer.email, firstCommit.author.email);
const original = await createGitHubReviewWriter(target).readTarget({ repository, branch: remote.branch, path: receipt.path });
await assert.rejects(publishCloudReview({ ...input, source: afterFirst.source, expectedHeadOid: afterFirst.source.revision,
  expectedBlobOid: 'f'.repeat(40), report: { ...report, provenance: { ...report.provenance, source_revision: afterFirst.source.revision } } }, createGitHubReviewWriter(target)), /write-conflict/);

let arrivals = 0, release; const barrier = new Promise(done => { release = done; });
const racingRequest = async ({ method, endpoint, body }) => {
  if (endpoint === 'graphql') {
    if (++arrivals === 2) release();
    let timeout;
    try { await Promise.race([barrier, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Concurrent candidate did not reach CAS')), 30000); })]); }
    finally { clearTimeout(timeout); }
  }
  return api(method, endpoint, body);
};
const raceInput = { ...input, source: afterFirst.source, expectedHeadOid: afterFirst.source.revision, expectedBlobOid: original.blobOid };
const contenders = [0, 1].map(i => publishCloudReview({ ...raceInput, report: { ...report,
  provenance: { ...report.provenance, source_revision: afterFirst.source.revision }, summary: { ...report.summary, headline: `合成并发验收第${i + 1}份` } } },
  createGitHubReviewWriter({ ...target, request: racingRequest })));
const outcomes = await Promise.allSettled(contenders);
assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
assert.equal(arrivals, 2);
const afterRace = await fetchCloudReview(replay.match.id, 1, options);
const beforeUpdate = await createGitHubReviewWriter(target).readTarget({ repository, branch: remote.branch, path: receipt.path });
const lostReport = { ...report, provenance: { ...report.provenance, source_revision: afterRace.source.revision }, summary: { ...report.summary, headline: '合成回执丢失验收' } };
let ambiguousUpdates = 0;
await assert.rejects(publishCloudReview({ ...input, source: afterRace.source, report: lostReport, expectedHeadOid: afterRace.source.revision, expectedBlobOid: beforeUpdate.blobOid },
  createGitHubReviewWriter({ ...target, request: async ({ method, endpoint, body }) => {
    const value = await api(method, endpoint, body); if (endpoint === 'graphql') { ambiguousUpdates++; throw Error('Synthetic lost acknowledgement'); } return value;
  } })), /write-conflict-or-unconfirmed/);
assert.equal(ambiguousUpdates, 1);
const lostReceipt = await createGitHubReviewWriter(target).readTarget({ repository, branch: remote.branch, path: receipt.path });
assert.notEqual(lostReceipt.headOid, afterRace.source.revision); assert.equal(JSON.parse(lostReceipt.contents).summary.headline, lostReport.summary.headline);

const reader = createCloudReviewReader({ ...options, loadReplay: async () => replay });
try {
  reader.start(replay.match.id, 1); await reader.wait(); assert.equal((await reader.read(replay.match.id, 1)).status, 'ready');
  replay.games[0].result.reason = 'synthetic remote evidence updated';
  const updated = await buildCoachBundle(replay, { cards: first.cards, historyKey: first.historyKey, multipart: true });
  await enqueueCoachBundle(updated, options); assert.equal((await syncCoachBundles(options)).synced, true);
  const afterUpload = await createGitHubReviewWriter(target).readTarget({ repository, branch: remote.branch, path: receipt.path });
  assert.equal(afterUpload.contents, lostReceipt.contents);
  reader.start(replay.match.id, 1); await reader.wait(); assert.equal((await reader.read(replay.match.id, 1)).status, 'stale');
  const finalSource = await fetchCloudReview(replay.match.id, 1, options);
  assert.equal(validateCloudReviewBinding(finalSource.report, finalSource.source).status, 'stale');
  const result = { repository, synthetic_only: true, production_data_writes: 0, paid_model_calls: 0,
    initial_upload: true, review_commit: receipt.commitOid, explicit_author_and_committer: true,
    concurrent_cas: { attempts: 2, accepted: 1, rejected: 1, force: false }, wrong_original_blob_rejected: true,
    ambiguous_acknowledgement: { mutations: ambiguousUpdates, automatic_retries: 0, persisted_commit_confirmed_independently: true },
    read_only_sync_ready: true, subsequent_match_upload: true, review_bytes_preserved: true, changed_source_stale: true };
  await writeFile(resolve(dataDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result));
} finally { await reader.close(); }
