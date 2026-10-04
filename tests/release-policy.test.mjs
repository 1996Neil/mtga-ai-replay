import test from 'node:test';
import assert from 'node:assert/strict';
import { forbiddenPath, inspectRecord } from '../scripts/check-release.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { materializeViewer } from '../scripts/materialize-viewer.mjs';

test('release policy rejects restricted files, runtime data and credential-shaped content', () => {
  for (const path of ['viewer/src/components/GameBoard.tsx', 'viewer/src/index.css', 'credentials.json', '.env', 'history/replays.sqlite3', 'Player.log', 'viewer/dist/index.html', 'audio/raw.mp3', 'assets/card.png']) assert.equal(forbiddenPath(path), true, path);
  assert.equal(forbiddenPath('src/live-coach/providers/deepseek.mjs'), false);
  const secretLike = 'ghp_' + 'A'.repeat(32);
  assert.deepEqual(inspectRecord('src/example.mjs', Buffer.from(secretLike)), ['credential-shaped value']);
  assert.deepEqual(inspectRecord('tests/example.test.mjs', Buffer.from('ghp_SYNTHETIC_SUPER_SECRET')), []);
  assert.deepEqual(inspectRecord('src/example.mjs', Buffer.from('ghp_SYNTHETIC_SUPER_SECRET')), ['credential-shaped value']);
});
test('materializer requires explicit local source and does not fall back to a network download', () => {
  const result = spawnSync(process.execPath, ['scripts/materialize-viewer.mjs'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /explicit authorized local --source-dir/);
});
test('materializer accepts exact synthetic hashes and rejects changed or symlink targets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mtga-materializer-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), target = join(dir, 'target'), path = 'viewer/src/components/GameBoard.tsx';
  await mkdir(dirname(join(source, path)), { recursive: true }); await mkdir(target);
  const bytes = Buffer.from('Synthetic independently authored fixture, not upstream code.');
  await writeFile(join(source, path), bytes);
  const entries = [{ path, sha256: createHash('sha256').update(bytes).digest('hex') }];
  const options = { sourceDir: source, destinationRoot: target, entries };
  assert.equal(await materializeViewer(options), 1); assert.equal(await materializeViewer(options), 1);
  await writeFile(join(target, path), 'Concurrent changed contents');
  await assert.rejects(materializeViewer(options), /different local file/);
  assert.equal(await readFile(join(target, path), 'utf8'), 'Concurrent changed contents');
  await rm(join(target, path)); await symlink(join(source, path), join(target, path));
  await assert.rejects(materializeViewer(options), /different local file/);
});
test('materializer validates the whole input before writes and rejects source symlink ancestors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mtga-materializer-source-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), target = join(dir, 'target'), path = 'viewer/src/index.css';
  await mkdir(dirname(join(source, path)), { recursive: true }); await mkdir(target);
  await writeFile(join(source, path), 'Synthetic stylesheet');
  await assert.rejects(materializeViewer({ sourceDir: source, destinationRoot: target, entries: [{ path, sha256: '0'.repeat(64) }] }), /hash mismatch/);
  await assert.rejects(readFile(join(target, path)), { code: 'ENOENT' });
  const alias = join(dir, 'aliased-source'); await mkdir(alias); await symlink(join(source, 'viewer'), join(alias, 'viewer'));
  await assert.rejects(materializeViewer({ sourceDir: alias, destinationRoot: target, entries: [{ path, sha256: '0'.repeat(64) }] }), /without symlink ancestors/);
});
