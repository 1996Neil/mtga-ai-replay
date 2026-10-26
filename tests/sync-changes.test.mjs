import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSyncChanges } from '../src/sync-changes.mjs';
const execute = promisify(execFile);
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'mtga-upload-delta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const git = async (args, encoding = 'utf8') => {
    calls.push(args);
    return (await execute('git', args, { cwd: root, encoding })).stdout;
  };
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Synthetic']);
  await git(['config', 'user.email', 'synthetic@users.noreply.github.com']);
  const commit = () => git(['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic delta']);
  await writeFile(join(root, 'README.md'), 'Synthetic baseline');
  await git(['add', 'README.md']); await commit();
  await git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return { root, git, calls, commit };
}
test('unchanged personal repository reads no blobs; a new staged file reads only its bytes', async t => {
  const h = await setup(t);
  h.calls.length = 0;
  assert.equal((await validateSyncChanges(h.git, { branch: 'main' })).blob_bytes, 0);
  assert.equal(h.calls.some(args => args[0] === 'cat-file'), false);
  await mkdir(join(h.root, 'latest'));
  const content = '{"synthetic":"safe"}';
  await writeFile(join(h.root, 'latest/coach.json'), content);
  await h.git(['add', 'latest/coach.json']);
  const result = await validateSyncChanges(h.git, { branch: 'main' });
  assert.equal(result.blob_bytes, Buffer.byteLength(content));
  assert.equal(result.history_scanned, false);
});
test('a secret in a NEW retry commit cannot be hidden by a later deletion', async t => {
  const h = await setup(t);
  await mkdir(join(h.root, 'latest'));
  await writeFile(join(h.root, 'latest/coach.json'), '{"password":"synthetic-sentinel"}');
  await h.git(['add', 'latest/coach.json']); await h.commit();
  await h.git(['rm', 'latest/coach.json']); await h.commit();
  await assert.rejects(validateSyncChanges(h.git, { branch: 'main' }), error => error.code === 'MTGA_SYNC_SECURITY');
});
test('trusted old history is skipped; NEW commit identity remains anonymous', async t => {
  const h = await setup(t);
  await writeFile(join(h.root, 'README.md'), 'Synthetic outgoing safe change');
  await h.git(['add', 'README.md']);
  await h.git(['-c', 'user.email=synthetic@example.invalid', '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic new identity']);
  await assert.rejects(validateSyncChanges(h.git, { branch: 'main' }), error => error.rule === 'commit-personal-identity');
  await h.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  assert.equal((await validateSyncChanges(h.git, { branch: 'main' })).blob_bytes, 0);
});
