import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bundle, harness, reportForSource } from './helpers/cloud-review-fixture.mjs';
import { configureCoachSync, enqueueCoachBundle, syncCoachBundles } from '../src/coach-sync.mjs';
import { readPublishedReviewSource, validateCloudReviewBinding } from '../src/review/cloud-review.mjs';
import { publishCloudReview, prepareCloudReviewWrite } from '../src/review/cloud-review-writer.mjs';
import { validateStagedRepository, createSyncValidationSession } from '../src/sync-security.mjs';
import { fetchCloudReview, createCloudReviewReader } from '../src/review/review-sync.mjs';

const repository = 'fixture-owner/private-coaching';
const execute = (h, args, { input, env = {} } = {}) => new Promise((yes, no) => {
  const child = execFile('git', ['--git-dir', h.bare, ...args], { encoding: 'buffer',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env }, maxBuffer: 32 * 1024 * 1024 },
  (error, stdout) => error ? no(error) : yes(stdout));
  child.stdin.on('error', no); child.stdin.end(input);
});
async function readTree(h, revision) {
  const entries = (await execute(h, ['ls-tree', '-rz', revision])).toString().split('\0').filter(Boolean), files = new Map();
  for (const entry of entries) {
    const [meta, path] = entry.split('\t'), [, type, oid] = meta.split(' ');
    assert.equal(type, 'blob'); files.set(path, await execute(h, ['cat-file', 'blob', oid]));
  }
  return files;
}
export function localAgentClient(h, control = {}) {
  return {
    async readTarget({ path }) {
      const headOid = (await execute(h, ['rev-parse', 'refs/heads/main'])).toString().trim();
      let blobOid = null, contents;
      try { blobOid = (await execute(h, ['rev-parse', `${headOid}:${path}`])).toString().trim(); contents = (await execute(h, ['cat-file', 'blob', blobOid])).toString(); } catch { /* Absent review. */ }
      return { repository, visibility: 'PRIVATE', headOid, blobOid, contents };
    },
    async compareAndSwapReview(plan) {
      await control.beforeCAS?.();
      const index = join(h.dataDir, 'agent-index'), env = { GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: plan.identity.name, GIT_AUTHOR_EMAIL: plan.identity.email,
        GIT_COMMITTER_NAME: plan.identity.name, GIT_COMMITTER_EMAIL: plan.identity.email };
      await execute(h, ['read-tree', plan.expectedHeadOid], { env });
      const blob = (await execute(h, ['hash-object', '-w', '--stdin'], { input: plan.contents })).toString().trim();
      await execute(h, ['update-index', '--add', '--cacheinfo', `100644,${blob},${plan.path}`], { env });
      const tree = (await execute(h, ['write-tree'], { env })).toString().trim();
      const oid = (await execute(h, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', plan.expectedHeadOid], { input: plan.message, env })).toString().trim();
      await execute(h, ['update-ref', 'refs/heads/main', oid, plan.expectedHeadOid]);
      return { commitOid: oid };
    },
  };
}
async function setup(t) {
  const h = await harness(t); let rawReplay;
  const first = await bundle({ richer: true, coachOptions: { multipart: true }, onReplay: raw => { rawReplay = raw; } });
  await configureCoachSync(repository, h.options); await enqueueCoachBundle(first, h.options); await syncCoachBundles(h.options);
  const revision = (await execute(h, ['rev-parse', 'HEAD'])).toString().trim();
  const source = readPublishedReviewSource({ files: await readTree(h, revision), matchId: first.summary.match_id, revision });
  const report = reportForSource(source);
  const input = { repository, branch: 'main', expectedHeadOid: revision, report, source };
  return { h, first, source, report, input, rawReplay };
}

test('actual bare remote: upload → Agent CAS review → replay update preserves review and stale binding', async t => {
  const { h, first, report, input } = await setup(t), beforeIndex = await h.published('index.json');
  const receipt = await publishCloudReview(input, localAgentClient(h));
  assert.equal(await h.published('index.json'), beforeIndex);
  const bytes = await h.published(receipt.path);
  const uploadState = await readFile(join(h.dataDir, 'coach-sync/state.json'), 'utf8');
  const beforeRead = h.control.calls.length;
  const downloaded = await fetchCloudReview(report.match_id, 1, h.options);
  assert.equal(downloaded.report.source_content_hash, report.source_content_hash);
  assert.equal(validateCloudReviewBinding(downloaded.report, downloaded.source).status, 'ready');
  assert.equal(await readFile(join(h.dataDir, 'coach-sync/state.json'), 'utf8'), uploadState);
  assert.ok(h.control.calls.slice(beforeRead).every(call => call.file !== 'git' || !call.args.some(arg => ['checkout', 'merge', 'reset', 'commit', 'push', 'update-ref'].includes(arg))));
  // Generate the changed bundle through the production builder, not manual hash mutation.
  const { buildCoachBundle, resolveCoachBundle } = await import('../src/coach-bundle.mjs');
  const richer = resolveCoachBundle(first.coach, first.parts); richer.games[0].result.reason = 'updated synthetic evidence';
  const updated = await buildCoachBundle(richer, { cards: first.cards, historyKey: first.historyKey, multipart: true });
  assert.notEqual(updated.contentHash, first.contentHash);
  await enqueueCoachBundle(updated, h.options);
  assert.equal((await syncCoachBundles(h.options)).synced, true);
  assert.equal(await h.published(receipt.path), bytes);
  const revision = (await execute(h, ['rev-parse', 'HEAD'])).toString().trim();
  const source = readPublishedReviewSource({ files: await readTree(h, revision), matchId: first.summary.match_id, revision });
  assert.equal(validateCloudReviewBinding(report, source).status, 'stale');
  assert.equal((await validateStagedRepository(h.checkout)).ok, true);
  const outgoing = h.control.calls.filter(call => call.file === 'git' && call.args.includes('push'));
  assert.equal(outgoing.length, 2);
});

test('concurrent Agent writes use atomic head CAS; source advance and wrong original blob reject', async t => {
  const { h, input } = await setup(t);
  await assert.rejects(publishCloudReview(input, { readTarget: async () => { throw Error('synthetic-private-client-error'); } }),
    error => error.code === 'MTGA_CLOUD_REVIEW' && !error.message.includes('synthetic-private-client-error'));
  await assert.rejects(publishCloudReview({ ...input, expectedBlobOid: 'e'.repeat(40) }, localAgentClient(h)), /write-conflict/);
  const first = await publishCloudReview(input, localAgentClient(h));
  await assert.rejects(publishCloudReview(input, localAgentClient(h)), /write-conflict/);
  const revision = first.commitOid, source = readPublishedReviewSource({ files: await readTree(h, revision), matchId: input.report.match_id, revision });
  const report = reportForSource(source), client = localAgentClient(h);
  const target = await client.readTarget({ path: first.path });
  const updated = { ...input, expectedHeadOid: revision, expectedBlobOid: target.blobOid, source, report };
  let signal; const ready = new Promise(resolve => { signal = resolve; }); let enter; const entered = new Promise(resolve => { enter = resolve; });
  const slow = publishCloudReview(updated, localAgentClient(h, { beforeCAS: async () => { enter(); await ready; } }));
  await entered;
  await publishCloudReview(updated, client); signal();
  await assert.rejects(slow, /write-conflict-or-unconfirmed/);
  assert.equal((await validateStagedRepository(h.checkout)).ok, true);
});

test('review paths never gain local outgoing ownership and cloned bytes cannot inherit another path verdict', async t => {
  const { h, input } = await setup(t), receipt = await publishCloudReview(input, localAgentClient(h));
  // Fetch/ff through the production upload pipeline.
  await enqueueCoachBundle(await bundle({ id: 'synthetic-second-match' }), h.options); await syncCoachBundles(h.options);
  const path = join(h.checkout, receipt.path);
  await writeFile(path, (await readFile(path, 'utf8')).replace('合成协议验收', '合成修改验收'));
  const git = async args => (await h.options.runCommand('git', args, { cwd: h.checkout })).stdout;
  await git(['add', '--', receipt.path]);
  const { assertStagedSyncOwnership } = await import('../src/coach-sync.mjs');
  await assert.rejects(assertStagedSyncOwnership(git, 'coach'), error => error.code === 'SYNC_FOREIGN_STAGE');
  await assert.rejects(assertStagedSyncOwnership(git, 'collection'), error => error.code === 'SYNC_FOREIGN_STAGE');
  const session = createSyncValidationSession();
  assert.equal((await validateStagedRepository(h.checkout, { validationSession: session })).ok, true);
  const other = 'reviews/another-match/game-1.json';
  await mkdir(join(h.checkout, 'reviews/another-match'), { recursive: true }); await writeFile(join(h.checkout, other), await readFile(path));
  await git(['add', '--force', '--', other]);
  await assert.rejects(validateStagedRepository(h.checkout, { validationSession: session }), error => error.rule === 'invalid-cloud-review');
});

test('a malicious review on another fetched branch still blocks read and upload history validation', async t => {
  const { h, input } = await setup(t), plan = prepareCloudReviewWrite(input);
  const result = await localAgentClient(h).compareAndSwapReview({ ...plan, contents: '{"unknown":"malicious fixture"}' });
  await execute(h, ['update-ref', 'refs/heads/untrusted-agent', result.commitOid]);
  await execute(h, ['update-ref', 'refs/heads/main', input.expectedHeadOid, result.commitOid]);
  await assert.rejects(fetchCloudReview(input.report.match_id, 1, h.options), error => error.code === 'MTGA_SYNC_SECURITY');
  await enqueueCoachBundle(await bundle({ id: 'synthetic-next-match' }), h.options);
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'MTGA_SYNC_SECURITY');
});

test('review entries reject executable, symlink and gitlink modes before reading payloads', async t => {
  const { h, input } = await setup(t), receipt = await publishCloudReview(input, localAgentClient(h));
  await enqueueCoachBundle(await bundle({ id: 'synthetic-next-match' }), h.options); await syncCoachBundles(h.options);
  const git = async args => (await h.options.runCommand('git', args, { cwd: h.checkout })).stdout;
  const blob = String(await git(['rev-parse', `HEAD:${receipt.path}`])).trim(), head = String(await git(['rev-parse', 'HEAD'])).trim();
  for (const [mode, oid] of [['100755', blob], ['120000', blob], ['160000', head]]) {
    await git(['read-tree', 'HEAD']); await git(['update-index', '--cacheinfo', `${mode},${oid},${receipt.path}`]);
    await assert.rejects(validateStagedRepository(h.checkout), error => ['review-file-mode', 'symlink-or-gitlink'].includes(error.rule));
  }
});

test('real fetch default-branch change with malformed report cannot revive previous branch cache', async t => {
  const { h, input, rawReplay } = await setup(t), receipt = await publishCloudReview(input, localAgentClient(h));
  const reader = createCloudReviewReader({ ...h.options, loadReplay: async () => rawReplay }); t.after(() => reader.close());
  reader.start(input.report.match_id, 1); await reader.wait();
  assert.equal((await reader.read(input.report.match_id, 1)).status, 'ready');
  const current = await localAgentClient(h).readTarget({ path: receipt.path });
  const source = readPublishedReviewSource({ files: await readTree(h, receipt.commitOid), matchId: input.report.match_id, revision: receipt.commitOid });
  const plan = prepareCloudReviewWrite({ ...input, expectedHeadOid: receipt.commitOid, expectedBlobOid: current.blobOid, report: reportForSource(source), source });
  const invalid = await localAgentClient(h).compareAndSwapReview({ ...plan, contents: '{"schema":"invalid"}' });
  await execute(h, ['update-ref', 'refs/heads/new-main', invalid.commitOid]);
  await execute(h, ['update-ref', 'refs/heads/main', receipt.commitOid, invalid.commitOid]);
  h.control.branch = 'new-main'; reader.start(input.report.match_id, 1); await reader.wait();
  const value = await reader.read(input.report.match_id, 1);
  assert.equal(value.status, 'error'); assert.equal(value.review, undefined);
  const cold = createCloudReviewReader({ ...h.options, loadReplay: async () => rawReplay });
  assert.equal((await cold.read(input.report.match_id, 1)).status, 'missing'); await cold.close();
});

test('fetch lease serializes target discovery and target persistence across independent readers', async t => {
  const { h, input } = await setup(t);
  await execute(h, ['update-ref', 'refs/heads/new-main', input.expectedHeadOid]);
  let enter, release; const entered = new Promise(done => { enter = done; }); const blocked = new Promise(done => { release = done; }); const targets = [];
  const first = fetchCloudReview(input.report.match_id, 1, { ...h.options, onVerifiedTarget: async target => { targets.push(target.branch); enter(); await blocked; } });
  await entered; const checks = h.control.visibilityChecks; h.control.branch = 'new-main';
  await assert.rejects(fetchCloudReview(input.report.match_id, 1, h.options), /sync-busy-or-retained-lock/);
  assert.equal(h.control.visibilityChecks, checks); release(); await first;
  await fetchCloudReview(input.report.match_id, 1, { ...h.options, onVerifiedTarget: async target => { targets.push(target.branch); } });
  assert.deepEqual(targets, ['main', 'new-main']);
});
