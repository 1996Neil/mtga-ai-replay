import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaySyncSnapshot, probeReplaySyncRevision } from '../src/replay-sync-snapshot.mjs';
test('unchanged exact private remote commit reuses index after one query; public target is refused', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'replay-snapshot-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const repository = 'fixture-owner/private-coaching', commit = 'a'.repeat(40);
  const index = { matches: [{ match_id: 'fixture-match' }] };
  await writeFile(join(dataDir, 'replay-sync-snapshot.json'), JSON.stringify({ repository, commit, index, branch: 'custom-branch' }));
  let calls = 0;
  const probeRemote = async () => { calls++; return { nameWithOwner: repository, isPrivate: true,
    defaultBranchRef: { name: 'custom-branch', target: { oid: commit } } }; };
  const snapshot = await replaySyncSnapshot({ dataDir, state: { repository, pending: [] }, probeRemote });
  assert.equal(calls, 1); assert.deepEqual(snapshot.index, index); assert.equal(snapshot.source, 'remote');
  await assert.rejects(replaySyncSnapshot({ dataDir, state: { repository, pending: [] },
    probeRemote: async () => ({ nameWithOwner: repository, isPrivate: false }) }));
});
test('remote probe sends one authenticated query without reading replay blobs', async () => {
  let calls = 0;
  const value = await probeReplaySyncRevision('fixture-owner/private-coaching', { runCommand: async (file, args) => {
    calls++; assert.equal(file, 'gh'); assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
    return JSON.stringify({ data: { repository: { isPrivate: true } } });
  } });
  assert.equal(calls, 1); assert.equal(value.isPrivate, true);
});
