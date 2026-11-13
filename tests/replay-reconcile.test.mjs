import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPublishedCheckpointCommit, settlePublishedPending } from '../src/coach-sync.mjs';

const execute = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => execute('git', args, { cwd, env }).then(result => result.stdout.trim());

/** A later writer (the draft publisher) can push on top of a replay checkpoint. */
async function publishedCheckout(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'replay-reconcile-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repo = join(dataDir, 'coach-sync', 'repository');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Synthetic');
  await git(repo, 'config', 'user.email', 'synthetic@example.invalid');
  await writeFile(join(repo, 'index.json'), '{}\n');
  await git(repo, 'add', 'index.json');
  await git(repo, 'commit', '-m', 'checkpoint');
  const checkpoint = await git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'drafts.json'), '{}\n');
  await git(repo, 'add', 'drafts.json');
  await git(repo, 'commit', '-m', 'later draft publish');
  const head = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'update-ref', 'refs/remotes/origin/main', head);
  return { dataDir, repo, checkpoint, head };
}

test('a checkpoint published under a later branch head is still confirmed', async t => {
  const { dataDir, repo, checkpoint } = await publishedCheckout(t);
  await assertPublishedCheckpointCommit(checkpoint, { dataDir, branch: 'main' });
  const orphan = await git(repo, 'commit-tree', `${checkpoint}^{tree}`, '-m', 'unpublished');
  await assert.rejects(assertPublishedCheckpointCommit(orphan, { dataDir, branch: 'main' }),
    error => error.code === 'SYNC_REMOTE_VERIFY');
});

test('verified published queue entries settle; unpublished ones stay pending', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'replay-settle-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'coach-sync'), { recursive: true });
  const published = 'a'.repeat(64), queued = 'b'.repeat(64);
  await writeFile(join(dataDir, 'coach-sync', 'state.json'), JSON.stringify({
    schema: 'MTGA_LOCAL_SYNC_V1', enabled: true, repository: 'owner/repo', synced: {},
    pending: [
      { match_id: 'published-match', started_at: '2026-11-12T13:53:28.339Z', history_key: '2026-11-12T13-53-28-339Z_published-match', content_hash: published },
      { match_id: 'queued-match', started_at: '2026-11-12T14:00:00.000Z', history_key: '2026-11-12T14-00-00-000Z_queued-match', content_hash: queued },
    ],
    last_error: { code: 'GITHUB_UNAVAILABLE', message: 'synthetic', at: '2026-11-12T14:03:39.785Z' },
  }));
  const settled = await settlePublishedPending({ dataDir, index: { matches: [
    { match_id: 'published-match', content_hash: published, history_key: 'k', started_at: '2026-11-12T13:53:28.339Z' },
  ] } });
  assert.deepEqual(settled, { settled: 1 });
  const state = JSON.parse(await readFile(join(dataDir, 'coach-sync', 'state.json'), 'utf8'));
  assert.deepEqual(state.pending.map(item => item.match_id), ['queued-match']);
  assert.equal(state.synced['published-match'].content_hash, published);
  assert.notEqual(state.last_error, null);
});
