import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCoachBundles } from '../src/coach-sync.mjs';

test('publication scope is checked under the sync lock before writes or external calls, preserving a concurrent foreign queue', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scoped-coach-sync-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'coach-sync'));
  const path = join(dataDir, 'coach-sync/state.json');
  const text = JSON.stringify({ schema: 'MTGA_LOCAL_SYNC_V1', enabled: true,
    repository: 'synthetic-owner/private', synced: {}, pending: [
      { match_id: 'requested-match' }, { match_id: 'concurrent-unrelated-match' },
    ], last_synced: null });
  await writeFile(path, text);
  let calls = 0;
  await assert.rejects(syncCoachBundles({ dataDir, allowedMatchIds: ['requested-match'],
    runCommand: () => { calls++; throw Error('Should not run'); } }), { code: 'SYNC_FOREIGN_PENDING' });
  assert.equal(calls, 0);
  assert.equal(await readFile(path, 'utf8'), text);
  for (const ids of [[], ['duplicate', 'duplicate'], [null], 'not-an-array']) {
    await assert.rejects(syncCoachBundles({ dataDir, allowedMatchIds: ids }), { code: 'SYNC_SCOPE' });
    assert.equal(await readFile(path, 'utf8'), text);
  }
});

test('an empty scoped queue remains a no-op and ordinary unscoped behavior is unchanged', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scoped-coach-empty-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'coach-sync'));
  await writeFile(join(dataDir, 'coach-sync/state.json'), JSON.stringify({
    schema: 'MTGA_LOCAL_SYNC_V1', enabled: true, repository: 'synthetic-owner/private',
    synced: {}, pending: [], last_synced: null,
  }));
  const scoped = await syncCoachBundles({ dataDir, allowedMatchIds: ['requested-match'] });
  const ordinary = await syncCoachBundles({ dataDir });
  assert.equal(scoped.committed, 0);
  assert.deepEqual(scoped, ordinary);
});

test('changed pending bytes and local revisions refuse scoped publication without touching the queue', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scoped-coach-versions-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'coach-sync'));
  const path = join(dataDir, 'coach-sync/state.json');
  const text = JSON.stringify({ schema: 'MTGA_LOCAL_SYNC_V1', enabled: true,
    repository: 'synthetic-owner/private', synced: {},
    pending: [{ match_id: 'requested-match', content_hash: 'a'.repeat(64) }], last_synced: null });
  await writeFile(path, text);
  await assert.rejects(syncCoachBundles({ dataDir, allowedMatchIds: ['requested-match'],
    expectedPendingContentHashes: { 'requested-match': 'b'.repeat(64) } }), { code: 'SYNC_PENDING_CHANGED' });
  await assert.rejects(syncCoachBundles({ dataDir, allowedMatchIds: ['requested-match'],
    expectedReplayRevisions: { 'requested-match': 'b'.repeat(64) } }), { code: 'SYNC_INPUT_CHANGED' });
  await assert.rejects(syncCoachBundles({ dataDir, allowedMatchIds: ['requested-match'],
    expectedReplayRevisions: {} }), { code: 'SYNC_SCOPE' });
  assert.equal(await readFile(path, 'utf8'), text);
});
