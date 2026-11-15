import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { startCloudReplay } from '../scripts/cloud-dev.mjs';

test('cloud entry serves a synthetic disposable archive with external operations disabled', async t => {
  const running = await startCloudReplay({ port: 0 }); t.after(() => running.close());
  assert.equal((await fetch(`${running.url}api/health`).then(r => r.json())).capabilities.includes('replay-sync'), false);
  assert.equal((await fetch(`${running.url}api/local-history`).then(r => r.json())).status, 'disabled');
  assert.equal((await fetch(`${running.url}api/collection`)).status, 403);
  const matches = await fetch(`${running.url}api/matches`).then(r => r.json());
  assert.equal(matches.length, 1); assert.equal(matches[0].id, 'synthetic-cloud-match');
  assert.equal((await fetch(`${running.url}api/matches/synthetic-cloud-match`)).status, 200);
  assert.equal((await fetch(`${running.url}api/sync`)).status, 403);
  assert.equal((await fetch(running.url, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  await running.close(); await assert.rejects(access(running.directory), { code: 'ENOENT' });
});
