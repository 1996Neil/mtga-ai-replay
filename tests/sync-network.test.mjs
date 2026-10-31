import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSyncProxy, syncNetworkEnvironment } from '../src/sync-network.mjs';
import { coachSyncRunner } from '../src/coach-sync.mjs';

test('proxy configuration is loopback-only, credential-free, private, optional, and honors existing environment', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sync-network-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.deepEqual(await syncNetworkEnvironment(dataDir, {}), {});
  for (const bad of ['https://127.0.0.1:7897', 'http://example.com:7897',
    'http://user:password@127.0.0.1:7897', 'http://127.0.0.1:7897/path', 'http://127.0.0.1:7897/?secret=x'])
    assert.throws(() => validateSyncProxy(bad));
  assert.equal(validateSyncProxy('http://[::1]:7897'), 'http://[::1]:7897');
  const path = join(dataDir, 'sync-network.json');
  await writeFile(path, JSON.stringify({ https_proxy: 'http://127.0.0.1:7897' }), { mode: 0o600 });
  assert.deepEqual(await syncNetworkEnvironment(dataDir, {}), { HTTPS_PROXY: 'http://127.0.0.1:7897' });
  assert.deepEqual(await syncNetworkEnvironment(dataDir, { HTTPS_PROXY: 'http://127.0.0.1:1234' }), {});
  await chmod(path, 0o644);
  await assert.rejects(syncNetworkEnvironment(dataDir, {}));
  await rm(path);
  await writeFile(join(dataDir, 'target.json'), '{}');
  await symlink(join(dataDir, 'target.json'), path);
  await assert.rejects(syncNetworkEnvironment(dataDir, {}));
});

test('shared Git/GitHub runner preserves child environment and never mutates the process environment', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'sync-runner-network-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const original = process.env.HTTPS_PROXY;
  const settings = [];
  const run = coachSyncRunner({ dataDir, runCommand: async (file, args, options) => {
    settings.push(options.env);
    return 'synthetic';
  } });
  await run('git', ['status'], { env: { GIT_TERMINAL_PROMPT: '0' } });
  await run('gh', ['api', 'synthetic'], { env: { SYNTHETIC_KEEP: 'yes' } });
  assert.equal(settings[0].GIT_TERMINAL_PROMPT, '0');
  assert.equal(settings[1].SYNTHETIC_KEEP, 'yes');
  assert.equal(process.env.HTTPS_PROXY, original);
});
