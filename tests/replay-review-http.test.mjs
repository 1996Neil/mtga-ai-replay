import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReplayServer } from '../src/server.mjs';

const state = { turn: 2, phase: 'Phase_Main1', players: {
  me: { life: 16, hand: [{ name: 'Island', arena_id: 1 }], battlefield: [], graveyard: [], exile: [] },
  opponent: { life: 20, hand: [], battlefield: [], graveyard: [], exile: [] } }, stack: [] };
const replay = () => ({ match: { id: 'synthetic-review-http', started_at: new Date(0).toISOString() },
  games: [{ game_number: 1, steps: [{ anchor: 'T2-A1', turn: 2,
    event: { actor: 'me', type: 'land', card: { name: 'Island' } },
    state_before: state, state: state }], states: {}, result: { outcome: 'Win' } }],
  warnings: [] });
const result = { summary: { headline: '土地选择', overview: '这局只有一个合成动作。',
  strengths: [], improvements: [], limitations: [] },
  notes: [{ anchor: 'T2-A1', boundary: 'before', severity: 'tip', confidence: 'low',
    title: '观察地牌', observation: '当前可见 Island。', suggestion: '检查法术力需求。',
    cards: ['Island'] }] };

test('review HTTP endpoints are same-origin opt-in, cached, game-specific and stale-safe', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'replay-review-http-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let recorded = replay(), calls = 0;
  const runtime = await startReplayServer({ dataDir, viewerDir: dataDir,
    writeInfo: false, displayNamesZh: new Map(), enableReplaySync: false,
    enableCollection: false, includeLocalHistory: false, observeLocalLogs: false,
    replayProvider: { list: async () => [], get: async id =>
      id === recorded.match.id ? recorded : null, latest: async () => recorded },
    reviewGenerator: async () => { calls++; return result; } });
  t.after(() => runtime.close());
  const target = `${runtime.url}api/matches/synthetic-review-http/review?game=1`;
  const ask = async (url, options) => fetch(url, options).then(async res =>
    ({ status: res.status, value: await res.json() }));
  assert.equal((await ask(target)).value.status, 'missing');
  const generate = target.replace('/review?', '/review/generate?');
  const blocked = await ask(generate, { method: 'POST', headers: {
    'Origin': 'http://example.invalid', 'X-MTGA-Replay-Action': 'review-generate' } });
  assert.equal(blocked.status, 403); assert.equal(calls, 0);
  const options = { method: 'POST', headers: {
    'Origin': runtime.url.slice(0, -1), 'X-MTGA-Replay-Action': 'review-generate' } };
  const first = await ask(generate, options);
  assert.equal(first.status, 200); assert.equal(first.value.review.notes[0].anchor, 'T2-A1');
  assert.equal(calls, 1);
  assert.equal((await ask(generate, options)).value.cached, true);
  assert.equal(calls, 1);
  assert.equal((await ask(target)).value.status, 'ready');
  recorded = structuredClone(recorded);
  recorded.games[0].steps[0].state_before.turn = 99;
  assert.equal((await ask(target)).value.status, 'stale');
});
