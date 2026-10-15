import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReplayServer } from '../src/server.mjs';

test('Replay HTTP is cloud-read-only even if a legacy local generator/key is supplied', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'replay-cloud-http-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const replay = { match: { id: 'synthetic-review-http' }, games: [{ game_number: 1, steps: [] }] };
  let localModelCalls = 0, syncs = 0;
  const runtime = await startReplayServer({ dataDir, viewerDir: dataDir, writeInfo: false, displayNamesZh: new Map(),
    enableReplaySync: false, enableCollection: false, includeLocalHistory: false, observeLocalLogs: false,
    replayProvider: { list: async () => [], get: async id => id === replay.match.id ? replay : null },
    reviewGenerator: async () => { localModelCalls++; throw Error('must not be called'); },
    reviewReader: { read: async () => ({ status: 'missing', can_sync: true }),
      start: () => { syncs++; return { status: 'syncing', code: 202 }; }, close: async () => {} } });
  t.after(() => runtime.close());
  const target = `${runtime.url}api/matches/${replay.match.id}/review?game=1`;
  const post = (url, headers = {}, body) => fetch(url, { method: 'POST', headers: { Origin: runtime.url.slice(0, -1), ...headers }, body });
  assert.equal((await (await fetch(target)).json()).status, 'missing');
  assert.equal((await post(target.replace('/review?', '/review/generate?'), { 'X-MTGA-Replay-Action': 'review-generate' })).status, 410);
  const sync = target.replace('/review?', '/review/sync?');
  assert.equal((await post(sync)).status, 403);
  assert.equal((await post(sync, { Origin: 'https://example.invalid', 'X-MTGA-Replay-Action': 'review-sync' })).status, 403);
  assert.equal((await post(sync, { 'X-MTGA-Replay-Action': 'review-sync' }, '{}')).status, 400);
  assert.equal((await post(sync + '&game=2', { 'X-MTGA-Replay-Action': 'review-sync' })).status, 400);
  assert.equal((await post(sync.replace('game=1', 'game=2'), { 'X-MTGA-Replay-Action': 'review-sync' })).status, 404);
  assert.equal((await post(sync, { 'X-MTGA-Replay-Action': 'review-sync' })).status, 202);
  const health = await (await fetch(`${runtime.url}api/health`)).json();
  assert.ok(health.capabilities.includes('cloud-review-read')); assert.ok(!health.capabilities.includes('replay-review-generate'));
  assert.equal(syncs, 1); assert.equal(localModelCalls, 0);
});
