import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

test('memory observer refuses an existing output without overwriting failure evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-memory-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = join(root, 'remote.git'), output = join(root, 'existing'), dataDir = join(root, 'seed-data');
  await mkdir(bare); await mkdir(output); await mkdir(dataDir);
  await writeFile(join(output, 'failed.json'), 'preserve-existing-evidence');
  const fixture = join(root, 'fixture.json');
  await writeFile(fixture, JSON.stringify({ repository: 'fixture-owner/private-coaching', branch: 'main', bare, dataDir }));
  await assert.rejects(execute(process.execPath, ['scripts/profile-cloud-memory.mjs', `--fixture=${fixture}`, `--output=${output}`, '--settle=0']));
  assert.equal(await readFile(join(output, 'failed.json'), 'utf8'), 'preserve-existing-evidence');
  await assert.rejects(access(join(output, 'data')));
});

test('memory observer resolves output-parent aliases before checking source containment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-memory-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), alias = join(root, 'alias');
  await mkdir(source); await symlink(source, alias);
  await assert.rejects(execute(process.execPath, ['scripts/profile-cloud-memory.mjs', '--fixture=not-read', `--source=${source}`, `--output=${join(alias, 'private-data')}`, '--settle=0']));
  await assert.rejects(access(join(source, 'private-data')));
});

test('memory observer refuses private outputs inside its source checkout before creating anything', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-memory-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'private-data');
  await assert.rejects(execute(process.execPath, ['scripts/profile-cloud-memory.mjs', '--fixture=not-read', `--source=${root}`, `--output=${output}`, '--settle=0']));
  await assert.rejects(access(output));
});
