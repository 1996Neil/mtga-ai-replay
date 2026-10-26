import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncGitFirstReplays } from '../src/git-first-replay.mjs';
import { archiveReplays, listReplays, getReplay, excludeArchivedReplays } from '../src/history.mjs';

const fixture = (id = 'synthetic-git-first') => ({ match: { id, account_key: 'a'.repeat(64),
  started_at: '2026-10-26T00:00:00.000Z', result: 'Win' }, deck: [], games: [] });
const report = (confirmed = [], sync_error = null) => ({ confirmed, sync_error, failed: [], skipped: [],
  index_source: 'remote', published: confirmed.length, updated: 0, github_total: confirmed.length });
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'git-first-replay-'));
  t.after(() => rm(dataDir, { force: true, recursive: true }));
  return { dataDir, importWorkflow: async () => ({ archive: { archived: 0 } }) };
}
test('offline queue stays invisible, later verified snapshot becomes local exactly once', async t => {
  const options = await setup(t), outbox = join(options.dataDir, 'replay-outbox'), replay = fixture();
  await archiveReplays([replay], { dataDir: outbox });
  let result = await syncGitFirstReplays({ ...options, publishWorkflow: async () => report([], 'offline') });
  assert.equal(result.status, 'failed');
  assert.deepEqual(await listReplays({ dataDir: options.dataDir }), []);
  assert.equal((await listReplays({ dataDir: outbox })).length, 1);
  result = await syncGitFirstReplays({ ...options, publishWorkflow: async ({ stagedReplays }) => {
    assert.equal(stagedReplays.get(replay.match.id).match.account_key, replay.match.account_key);
    assert.deepEqual(await listReplays({ dataDir: options.dataDir }), []);
    return report([{ match_id: replay.match.id, content_hash: 'b'.repeat(64), history_key: 'synthetic-key' }]);
  } });
  assert.equal(result.new_matches, 1);
  assert.equal((await listReplays({ dataDir: options.dataDir })).length, 1);
  assert.deepEqual(await listReplays({ dataDir: outbox }), []);
});
test('old remote index or cached success never promotes a new version; deletions and unknown owner stay excluded', async t => {
  const options = await setup(t), outbox = join(options.dataDir, 'replay-outbox');
  const removed = fixture('synthetic-removed'), unknown = fixture('synthetic-unknown'), normal = fixture();
  unknown.match.account_key = null;
  await archiveReplays([removed, unknown, normal], { dataDir: outbox });
  await excludeArchivedReplays([removed.match.id], { dataDir: options.dataDir });
  await syncGitFirstReplays({ ...options, publishWorkflow: async ({ stagedReplays }) => {
    assert.deepEqual([...stagedReplays.keys()], [normal.match.id]);
    return report([]);
  } });
  assert.deepEqual(await listReplays({ dataDir: options.dataDir }), []);
  await syncGitFirstReplays({ ...options, publishWorkflow: async () => ({
    ...report([{ match_id: normal.match.id, content_hash: 'b'.repeat(64), history_key: 'synthetic' }]), index_source: 'cached',
  }) });
  assert.equal(await getReplay(normal.match.id, { dataDir: options.dataDir }), null);
});
test('concurrent button/background requests share one upload and deletion during upload prevents promotion', async t => {
  const options = await setup(t), replay = fixture(), outbox = join(options.dataDir, 'replay-outbox');
  await archiveReplays([replay], { dataDir: outbox });
  let finish, calls = 0;
  const operation = { ...options, publishWorkflow: async () => {
    calls++;
    await new Promise(resolve => { finish = resolve; });
    return report([{ match_id: replay.match.id, content_hash: 'c'.repeat(64), history_key: 'synthetic' }]);
  } };
  const first = syncGitFirstReplays(operation), second = syncGitFirstReplays(operation);
  assert.equal(first, second);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await excludeArchivedReplays([replay.match.id], { dataDir: options.dataDir });
  finish(); await first;
  assert.equal(calls, 1);
  assert.equal(await getReplay(replay.match.id, { dataDir: options.dataDir }), null);
});
test('main archive conflict retains the exact published snapshot in the outbox', async t => {
  const options = await setup(t), outbox = join(options.dataDir, 'replay-outbox');
  const main = fixture(), queued = fixture();
  main.match.result = 'Loss';
  await archiveReplays([main], { dataDir: options.dataDir });
  await archiveReplays([queued], { dataDir: outbox });
  const result = await syncGitFirstReplays({ ...options, publishWorkflow: async () =>
    report([{ match_id: queued.match.id, content_hash: 'd'.repeat(64), history_key: 'synthetic' }]) });
  assert.equal(result.status, 'failed');
  assert.equal((await listReplays({ dataDir: outbox })).length, 1);
  assert.equal((await getReplay(main.match.id, { dataDir: options.dataDir })).match.result, 'Loss');
});
