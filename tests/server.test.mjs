import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveReplays } from '../src/history.mjs';
import { startReplayServer } from '../src/server.mjs';

async function setup(t, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'mtga-server-'));
  const viewerDir = join(temporary, 'viewer'), dataDir = join(temporary, 'data');
  await mkdir(viewerDir);
  await writeFile(join(viewerDir, 'index.html'), '<!doctype html><title>Synthetic Replay Viewer</title>');
  await archiveReplays([{ match: { id: 'synthetic-match', started_at: '2026-10-02T00:00:00Z', event: 'Jump In', is_jump_in: true, result: 'Win' },
    games: [{ turns: [{ turn_number: 1, events: [{ type: 'land', card: { arena_id: 100, name: 'Synthetic Forest', visibility: 'public' } }] }] }],
  }], { dataDir });
  const running = await startReplayServer({ dataDir, viewerDir, ...options });
  t.after(async () => { await running.close(); await rm(temporary, { recursive: true, force: true }); });
  return { ...running, temporary, dataDir, viewerDir };
}
function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
}

function syncPost(url, options = {}) {
  return fetch(url + 'api/sync', { method: 'POST', headers: { Origin: new URL(url).origin, 'X-MTGA-Replay-Action': 'sync', ...options.headers }, ...options });
}
async function finishedJob(url) {
  for (let i = 0; i < 100; i++) {
    const job = await fetch(url + 'api/sync').then(r => r.json());
    if (job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Synthetic sync did not finish');
}

test('fixed local sync rejects foreign origins, missing action header and arbitrary parameters', async t => {
  let calls = 0;
  const { url } = await setup(t, { syncWorkflow: async () => { calls++; return { status: 'succeeded' }; } });
  const origin = new URL(url).origin;
  for (const headers of [ {}, { Origin: origin }, { 'X-MTGA-Replay-Action': 'sync' },
    { Origin: 'https://evil.example', 'X-MTGA-Replay-Action': 'sync' },
    { Origin: origin.replace('127.0.0.1', 'localhost'), 'X-MTGA-Replay-Action': 'sync' },
    { Origin: origin, 'X-MTGA-Replay-Action': 'sync', 'Sec-Fetch-Site': 'cross-site' } ]) {
    assert.equal((await fetch(url + 'api/sync', { method: 'POST', headers })).status, 403);
  }
  assert.equal((await syncPost(url, { body: JSON.stringify({ command: 'arbitrary', repository: 'public/repo', path: '/private' }) })).status, 400);
  assert.equal((await fetch(url + 'api/sync?command=arbitrary', { method: 'POST', headers: { Origin: origin, 'X-MTGA-Replay-Action': 'sync' } })).status, 400);
  assert.equal((await fetch(url + 'api/sync', { method: 'OPTIONS' })).status, 405);
  assert.equal(calls, 0);
});

test('rapid sync requests share one job, expose progress and structured partial results', async t => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const result = { status: 'partial', local_matches: 3, already_published: 1, missing: 2, published: 1, failed: 1,
    skipped: 0, github_matches: 2, new_matches: 2, error: 'One synthetic replay failed.', failures: [{ match_id: 'synthetic-bad', reason: 'No replay steps.' }] };
  const { url } = await setup(t, { syncWorkflow: async ({ onProgress }) => {
    calls++; onProgress({ phase: 'generating', completed: 1, total: 2 }); await gate; return result;
  } });
  const [a, b] = await Promise.all([syncPost(url).then(r => r.json()), syncPost(url).then(r => r.json())]);
  assert.equal(a.id, b.id); assert.equal(a.status, 'running'); assert.equal(calls, 1);
  const progress = await fetch(url + 'api/sync').then(r => r.json());
  assert.deepEqual(progress.progress, { phase: 'generating', completed: 1, total: 2 });
  release(); const finished = await finishedJob(url);
  assert.equal(finished.status, 'partial'); assert.deepEqual(finished.result, result);
  assert.notEqual((await syncPost(url).then(r => r.json())).id, a.id);
  await finishedJob(url); assert.equal(calls, 2);
});

test('unexpected sync exceptions never expose raw credentials or local paths', async t => {
  const { url } = await setup(t, { syncWorkflow: async () => { throw new Error('ghp_SyntheticSecret /Users/synthetic/private.log'); } });
  await syncPost(url); const job = await finishedJob(url);
  assert.equal(job.status, 'failed'); assert.ok(job.error);
  assert.doesNotMatch(JSON.stringify(job), /SyntheticSecret|private.log|Users/);
});

test('voice Viewer retains manual sync and newly archived history while the locked source stays authoritative', async t => {
  const locked = { match: { id: 'synthetic-match', started_at: '2026-10-02T00:00:00Z', event: 'Jump In', result: 'Loss' }, games: [] };
  const summary = { id: locked.match.id, started_at: locked.match.started_at, event: locked.match.event, result: locked.match.result };
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const running = await setup(t, { enableReplaySync: true,
    replayProvider: { list: async () => [summary], get: async id => id === locked.match.id ? locked : null, latest: async () => locked },
    syncWorkflow: async ({ dataDir }) => {
      calls++; await gate;
      await archiveReplays(['new-B','new-C'].map((id, i) => ({
        match: { id, started_at: `2026-10-03T00:0${i}:00Z`, event: 'Jump In', is_jump_in: true, result: 'Win' },
        games: [{ game_number: 1, states: { S1: { turn: 1, players: {} } }, steps: [{ anchor: 'T1-A1', state_id: 'S1', event: { type: 'phase' } }] }],
      })), { dataDir });
      return { status: 'succeeded', local_matches: 3, already_published: 1, missing: 2, published: 2, failed: 0,
        skipped: 0, github_matches: 3, new_matches: 2, failures: [], error: null };
    } });
  const { url } = running;
  assert.ok((await fetch(url + 'api/health').then(r => r.json())).capabilities.includes('replay-sync'));
  assert.equal(calls, 0, 'reading health or history never automatically publishes');
  assert.equal((await fetch(url + 'api/matches').then(r => r.json()))[0].result, 'Loss');
  const [a,b] = await Promise.all([syncPost(url).then(r=>r.json()),syncPost(url).then(r=>r.json())]);
  assert.equal(a.id,b.id); assert.equal(calls,1); release();
  const job = await finishedJob(url); assert.equal(job.result.published,2);
  assert.deepEqual((await fetch(url + 'api/matches').then(r => r.json())).map(e=>e.id), ['new-C','new-B','synthetic-match']);
  assert.deepEqual(await fetch(url + 'api/matches/synthetic-match').then(r => r.json()), locked);
  assert.equal((await fetch(url + 'api/matches/latest').then(r => r.json())).match.id, 'new-C');
  assert.equal((await fetch(url + 'api/matches/new-B/context?game=1&anchor=T1-A1')).status, 200);
  assert.equal(calls,1);
});

test('loopback API serves persisted history and viewer while refusing foreign origins and private paths', async (t) => {
  const running = await setup(t, { fetchFn: async () => { throw new Error('Offline synthetic test'); } });
  const { url } = running;
  assert.equal(running.server.address().address, '127.0.0.1');
  assert.equal((await fetch(url + 'api/health').then(response => response.json())).service, 'mtga-gpt-replay');
  assert.equal((await fetch(url + 'api/matches').then(response => response.json()))[0].id, 'synthetic-match');
  assert.equal((await fetch(url + 'api/matches/latest').then(response => response.json())).match.id, 'synthetic-match');
  assert.equal((await fetch(url + 'api/matches/synthetic-match').then(response => response.json())).match.result, 'Win');
  assert.equal((await fetch(url + 'api/matches/missing')).status, 404);
  assert.match(await fetch(url).then(response => response.text()), /Synthetic Replay Viewer/);
  assert.equal((await fetch(url + 'api/matches', { method: 'POST' })).status, 405);
  assert.equal((await rawGet(url + 'api/matches', { Host: `evil.example:${running.port}` })).status, 403);
  assert.equal((await rawGet(url + 'api/matches', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(url + '%2e%2e%2fprivate.txt')).status, 400);
  await writeFile(join(running.temporary, 'private.txt'), 'Synthetic private text');
  await symlink(join(running.temporary, 'private.txt'), join(running.viewerDir, 'escape.txt'));
  assert.equal((await fetch(url + 'escape.txt')).status, 403);
  const info = JSON.parse(await readFile(join(running.dataDir, 'server.json'), 'utf8'));
  assert.equal(info.port, running.port);
  assert.equal(info.url, url);
});

test('offline card image failure returns card text and never blocks replay endpoints', async (t) => {
  let requests = 0;
  const running = await setup(t, { fetchFn: async () => { requests++; throw new Error('Synthetic offline'); } });
  const metadata = await fetch(running.url + 'api/cards/100').then(response => response.json());
  assert.equal(metadata.name, 'Synthetic Forest');
  assert.equal(metadata.image_available, false);
  assert.equal(metadata.image_url, null);
  assert.equal((await fetch(running.url + 'api/cards/100/image')).status, 404);
  assert.equal((await fetch(running.url + 'api/matches/latest')).status, 200);
  assert.equal(requests, 1); // Failed metadata is cached briefly, so playback does not retry every step.
});

test('public Scryfall metadata and DFC images are cached locally, preserving MIME type without repeat network', async (t) => {
  const requests = [];
  const fetchFn = async (url) => {
    requests.push(String(url));
    if (String(url).startsWith('https://api.scryfall.com/cards/arena/')) return new Response(JSON.stringify({
      id: 'synthetic-scryfall-id', name: 'Synthetic Transform // Other Face', card_faces: [
        { name: 'Synthetic Transform', mana_cost: '{2}{G}', type_line: 'Creature', power: '3', toughness: '3', image_uris: { normal: 'https://cards.scryfall.io/normal/front/synthetic.jpg' } },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(Buffer.from('synthetic-image-bytes'), { status: 200, headers: { 'Content-Type': 'image/png' } });
  };
  const running = await setup(t, { fetchFn });
  const metadata = await fetch(running.url + 'api/cards/100').then(response => response.json());
  assert.equal(metadata.mana_cost, '{2}{G}');
  assert.equal(metadata.image_url, '/api/cards/100/image');
  const imageUrl = new URL(metadata.image_url, running.url);
  const image = await fetch(imageUrl);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(await image.text(), 'synthetic-image-bytes');
  assert.equal((await fetch(imageUrl)).headers.get('content-type'), 'image/png');
  const cached = await fetch(running.url + 'api/cards/100').then(response => response.json());
  assert.equal(cached.image_cached, true);
  assert.equal(requests.length, 2);
  assert.equal(requests.some(url => /synthetic-match|started_at|Jump_In/.test(url)), false);
});

test('Coach Context is a native JSON attachment with exact before hand, no future reveal, and missing-anchor 404', async (t) => {
  const running = await setup(t, { fetchFn: async () => { throw new Error('No context network request'); } });
  const own = { name: 'Synthetic Own Card', arena_id: 120, instance_id: 220, visibility: 'player_known' };
  const future = { name: 'Synthetic Future Public Spell', arena_id: 990, instance_id: 330, visibility: 'public' };
  const player = hand => ({ life: 9, hand, handSize: hand.length, battlefield: [], graveyard: [], exile: [] });
  const before = { turn: 12, players: { me: player([own]), opponent: { ...player([]), handSize: 2 } }, stack: [] };
  const after = structuredClone(before); after.players.me.hand = []; after.players.me.handSize = 0; after.stack = [future];
  await archiveReplays([{ schema_version: '2.0', match: { id: 'coach-match', started_at: '2026-10-02T00:00:00Z', event: 'Jump In' },
    games: [{ game_number: 1, states: { S0: before, S1: after }, steps: [
      { anchor: 'T12-A19', state_id: 'S1', before_state_id: 'S0', event: { type: 'cast', actor: 'opponent', card: future, targets: [future], details: future.name } },
    ] }],
  }], { dataDir: running.dataDir });
  const contextUrl = `${running.url}api/matches/coach-match/context?game=1&anchor=T12-A19&boundary=before`;
  const response = await fetch(contextUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="coach-match-G1-T12-A19-before-coach.json"');
  const context = await response.json();
  assert.equal(context.state_boundary, 'before_gre_message');
  assert.deepEqual(context.state.players.me.hand, [own]);
  assert.deepEqual(context.event, { type: 'cast', actor: 'opponent' });
  assert.doesNotMatch(JSON.stringify(context), /Synthetic Future Public Spell|990|330/);
  const afterContext = await fetch(contextUrl.replace('boundary=before', 'boundary=after')).then(r => r.json());
  assert.deepEqual(afterContext.state.players.me.hand, []);
  assert.equal(afterContext.event.card.name, future.name);
  const head = await fetch(contextUrl, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.match(head.headers.get('content-disposition'), /^attachment;/);
  assert.equal((await fetch(contextUrl.replace('T12-A19', 'T99-A99'))).status, 404);
  assert.equal((await fetch(contextUrl.replace('coach-match', 'missing-match'))).status, 404);
  assert.equal((await fetch(contextUrl.replace('game=1', 'game=0'))).status, 400);
  assert.equal((await fetch(contextUrl.replace('boundary=before', 'boundary=future'))).status, 400);
});
