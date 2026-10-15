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
  const { createComputePool } = await import('../src/compute-pool.mjs');
  const pool = createComputePool();
  try { await assert.rejects(fetchCloudReview(input.report.match_id, 1, { ...h.options, computePool: pool }), error => error.code === 'MTGA_SYNC_SECURITY'); }
  finally { await pool.close(); }
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

test('explicit historical published session stays pinned after remote source advances and never touches local archive/cache', async t => {
  const { openPublishedReplaySession } = await import('../src/review/published-replay-session.mjs');
  const { startReplayServer } = await import('../src/server.mjs');
  const { h, input, first } = await setup(t), receipt = await publishCloudReview(input, localAgentClient(h));
  const beforeSettings = await readFile(join(h.dataDir, 'coach-sync/state.json'));
  const timings = [], session = await openPublishedReplaySession({ ...h.options, matchId: input.report.match_id, gameNumber: 1, revision: receipt.commitOid, onTiming: value => timings.push(value.stage) });
  assert.equal(session.identity.revision, receipt.commitOid); assert.equal(session.identity.local_archive, false);
  const ready = await session.reviewReader.read(input.report.match_id, 1);
  assert.equal(ready.status, 'ready'); assert.equal(ready.can_sync, false); assert.equal(ready.review.notes.length, 1);
  assert.equal(session.reviewReader.start().code, 403);
  assert.throws(() => { session.replay.games[0].states.S1.players.me.life = 0; }, TypeError);
  assert.throws(() => { session.review.notes[0].title = 'changed'; }, TypeError);
  const wire = await session.replayProvider.bytes(input.report.match_id);
  assert.deepEqual(JSON.parse(wire), session.replay);
  wire.fill(0);
  assert.deepEqual(JSON.parse(await session.replayProvider.bytes(input.report.match_id)), session.replay);
  assert.deepEqual(await readFile(join(h.dataDir, 'coach-sync/state.json')), beforeSettings);
  const { access } = await import('node:fs/promises');
  await assert.rejects(access(join(h.dataDir, 'reviews.sqlite3')), { code: 'ENOENT' });
  await assert.rejects(access(join(h.dataDir, 'replays.sqlite3')), { code: 'ENOENT' });
  assert.deepEqual(timings, ['private-repository','git-fetch','history-safety','published-files','source-verification','session-freeze']);
  let externalCalls = 0;
  const runtime = await startReplayServer({ dataDir: h.dataDir, port: 0, writeInfo: false, displayNamesZh: new Map(),
    replayProvider: session.replayProvider, reviewReader: session.reviewReader, sourceIdentity: session.identity,
    cardMetadata: new Map(session.cards.map(card => [card.arena_id, card])), fetchFn: async () => { externalCalls++; throw Error('No historical network'); },
    includeLocalHistory: false, observeLocalLogs: false, enableReplaySync: false, enableCollection: false });
  t.after(() => runtime.close());
  assert.deepEqual(await (await fetch(runtime.url+'api/source')).json(), session.identity);
  assert.deepEqual(await (await fetch(runtime.url+'api/matches/'+input.report.match_id)).json(), session.replay);
  assert.deepEqual(await (await fetch(runtime.url+'api/matches/latest')).json(), session.replay);
  assert.equal((await fetch(runtime.url+'api/matches/unknown-match')).status, 404);
  assert.equal((await (await fetch(runtime.url+'api/local-history')).json()).status, 'disabled');
  const card = await (await fetch(runtime.url+'api/cards/1')).json();
  for (const [key, value] of Object.entries(session.cards[0])) if (key !== 'display_name_zh') assert.deepEqual(card[key], value);
  assert.equal(card.display_name_zh, null);
  assert.equal((await fetch(runtime.url+'api/cards/999')).status, 404);
  assert.equal((await fetch(runtime.url+'api/cards/1/image')).status, 404);
  assert.equal(externalCalls, 0);
  const changed = structuredClone(first.coach); changed.games[0].result.reason = 'remote evidence update';
  const { buildCoachBundle } = await import('../src/coach-bundle.mjs');
  await enqueueCoachBundle(await buildCoachBundle(changed, { cards: first.cards, historyKey: first.historyKey, multipart: true }), h.options);
  assert.equal((await syncCoachBundles(h.options)).synced, true);
  const latest = await fetchCloudReview(input.report.match_id, 1, h.options);
  assert.equal(validateCloudReviewBinding(latest.report, latest.source).status, 'stale');
  const pinned = await fetchCloudReview(input.report.match_id, 1, { ...h.options, revision: receipt.commitOid });
  assert.equal(validateCloudReviewBinding(pinned.report, pinned.source).status, 'ready');
  assert.equal((await session.reviewReader.read(input.report.match_id, 1)).status, 'ready');
  await assert.rejects(fetchCloudReview(input.report.match_id, 1, { ...h.options, revision: 'f'.repeat(40) }));
  await assert.rejects(openPublishedReplaySession({ ...h.options, matchId: input.report.match_id, gameNumber: 1, revision: 'HEAD' }), /historical-explicit-source/);
  const { historicalPublishedView } = await import('../src/review/published-replay-session.mjs');
  const files = await readTree(h, receipt.commitOid); const part = `matches/${input.source.history_key}/coach.json`;
  files.set(part, Buffer.from('{}'));
  await assert.rejects(historicalPublishedView({ sourceInput: { files, matchId: input.report.match_id, revision: receipt.commitOid }, report: input.report }), /source-file-hash/);
});
