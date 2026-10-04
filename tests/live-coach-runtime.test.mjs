import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoachController } from '../src/live-coach/controller.mjs';
import { LiveCoachRuntime } from '../src/live-coach/runtime.mjs';
import { startReplayServer } from '../src/server.mjs';

const repoDir = process.env.MTGA_PRIVATE_CORPUS_DIR ?? fileURLToPath(new URL('../../../', import.meta.url));
const seed = '32cdbcfa-61f6-4a18-a0a1-afad6dab3062';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const view = (match = 'synthetic-one', game = 1, anchor = 'T1-A1', seq = 1, boundary = 'after') =>
  ({ match_id: match, game_number: game, anchor, view_seq: seq, boundary });
const state = (match = 'synthetic-one', game = 1, seq = 1) => ({ schema: 'MTGA_LIVE_STATE_V1', session_id: 'synthetic-source',
  source_mode: 'replay', match_id: match, game_id: String(game), seq, state_id: `S${seq}`, turn: 1,
  phase: 'Phase_Main1', step: null, active_player: 'me', terminal: false, coverage: { state_complete: true, missing: [] }, opportunity: true });

// Transport-only bytes intentionally are not MP3 and are never acoustically
// rendered. These fixtures test leases/cancellation, not real speech acceptance.
function contractController() {
  const option = { action_id: 'verified-transport-fixture', kind: 'explanation', speech_core: '测试撤销令牌。',
    speech_followup: '', subtitle: 'Transport contract only', immutable_facts: { number: 3 }, score: 1 };
  return new CoachController({ voiceId: 'transport-fixture-voice', candidates: s => s.opportunity ? [option] : [],
    verify: (_, s) => ({ valid: s.opportunity === true }), makeAdvice: (candidate, s) => ({ ...candidate,
      session_id: s.session_id, match_id: s.match_id, game_id: s.game_id, seq: s.seq }),
    voice: { async *synthesize() { yield Buffer.from('not-real-speech-transport-fixture'); } } });
}
async function playingRuntime() {
  const controller = contractController(), runtime = new LiveCoachRuntime({ repoDir, controller });
  runtime.source = async match => ({ stateForAnchor: (_, { gameNumber }) => state(match, gameNumber) });
  await runtime.start(); await runtime.observeView(view()); await tick();
  const adviceId = controller.current?.advice?.advice_id;
  assert.ok(adviceId); assert.ok(controller.audio(adviceId));
  return { runtime, controller, adviceId };
}
async function server(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mtga-coach-route-')), viewerDir = join(dir, 'viewer');
  await mkdir(viewerDir); await writeFile(join(viewerDir, 'index.html'), '<!doctype html><title>Offline contract viewer</title>');
  const running = await startReplayServer({ viewerDir, dataDir: join(dir, 'data'), writeInfo: false,
    displayNamesZh: new Map(), fetchFn: async () => { throw new Error('No cloud calls in route tests'); }, ...options });
  t.after(async () => { await running.close(); await rm(dir, { recursive: true, force: true }); });
  const post = (action, input = {}, override = {}) => fetch(`${running.url}api/live-coach/${action}`, { method: 'POST',
    headers: { Origin: new URL(running.url).origin, 'Content-Type': 'application/json', 'X-MTGA-Coach-Action': 'session', ...override }, body: JSON.stringify(input) });
  return { ...running, post };
}

test('feature-off old server exposes neither coach capability nor coach data/actions', async t => {
  const running = await server(t);
  const health = await fetch(`${running.url}api/health`).then(r => r.json());
  assert.equal(health.capabilities.includes('live-coach'), false);
  assert.equal((await fetch(`${running.url}api/live-coach/status`)).status, 404);
  assert.equal((await fetch(`${running.url}api/live-coach/events`)).status, 404);
  assert.equal((await running.post('start')).status, 405);
  assert.deepEqual(await fetch(`${running.url}api/matches`).then(r => r.json()), []);
});

test('coach history lists the whole real local corpus and every selected match shares its inference source', { skip: (!process.env.MTGA_PRIVATE_CORPUS_DIR) ? 'Private locked corpus is excluded from this source export' : false }, async t => {
  const controller = new CoachController({ candidates: () => [] }), runtime = new LiveCoachRuntime({ repoDir, controller });
  const replayProvider = await runtime.replayProvider(), running = await server(t, { liveCoach: runtime, replayProvider });
  const history = await fetch(`${running.url}api/matches`).then(r => r.json());
  assert.equal(history.length, 10); assert.equal(new Set(history.map(entry => entry.id)).size, 10);
  assert.ok(history.some(entry => entry.id === seed));
  assert.ok(history.every((entry, i) => i === 0 || Date.parse(history[i - 1].started_at) >= Date.parse(entry.started_at)));
  const older = history.at(-1).id;
  assert.notEqual(older, seed);
  const replay = await fetch(`${running.url}api/matches/${older}`).then(r => r.json());
  const source = await runtime.source(older);
  assert.deepEqual(replay, source.viewerReplay());
  const step = replay.games[0].steps.find(step => step.state_id);
  await runtime.observeView({ match_id: older, game_number: replay.games[0].game_number ?? 1,
    anchor: step.anchor, boundary: 'after', view_seq: 1 });
  assert.equal(runtime.previous.match_id, older); assert.equal(runtime.previous.state_id, step.state_id);
  const latest = await fetch(`${running.url}api/matches/latest`).then(r => r.json());
  assert.equal(latest.match.id ?? latest.match.match_id, history[0].id);
  assert.equal((await fetch(`${running.url}api/matches/not-in-the-local-corpus`)).status, 404);
  assert.equal((await fetch(`${running.url}api/sync`)).status, 403);
  assert.equal(controller.current, null); assert.equal(controller.muted, true);
});

test('coach mutations require exact same origin and custom header; malformed or oversized views never reach inference', async t => {
  const controller = contractController(), runtime = new LiveCoachRuntime({ repoDir, controller });
  let sourceCalls = 0; runtime.source = async () => { sourceCalls++; throw new Error('must not reach source'); };
  const running = await server(t, { liveCoach: runtime }), origin = new URL(running.url).origin;
  for (const headers of [{}, { Origin: origin }, { 'X-MTGA-Coach-Action': 'session' },
    { Origin: 'https://foreign.example', 'X-MTGA-Coach-Action': 'session' },
    { Origin: origin.replace('127.0.0.1', 'localhost'), 'X-MTGA-Coach-Action': 'session' },
    { Origin: origin, 'X-MTGA-Coach-Action': 'session', 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await fetch(`${running.url}api/live-coach/start`, { method: 'POST', headers });
    assert.equal(response.status, 403);
  }
  assert.equal(controller.enabled, false);
  assert.equal((await fetch(`${running.url}api/live-coach/status`, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  for (const input of [{ ...view(), match_id: '../private' }, { ...view(), anchor: 'S110' },
    { ...view(), game_number: 0 }, { ...view(), boundary: 'future' }]) assert.equal((await running.post('observe', input)).status, 400);
  assert.equal((await running.post('observe', { ...view(), padding: 'x'.repeat(5000) })).status, 400);
  assert.equal(sourceCalls, 0); assert.equal(controller.current, null);
});

test('loopback integration observes the locked current frame while UI can access recorded replay separately', { skip: (!process.env.MTGA_PRIVATE_CORPUS_DIR) ? 'Private locked corpus is excluded from this source export' : false }, async t => {
  const controller = new CoachController({ candidates: () => [] }), runtime = new LiveCoachRuntime({ repoDir, controller });
  const source = await runtime.source(seed), replay = source.viewerReplay();
  const anchor = replay.games[0].steps.find(s => s.state_id === 'S110').anchor;
  const running = await server(t, { liveCoach: runtime, replayProvider: {
    list: async () => [{ id: seed }], get: async id => id === seed ? source.viewerReplay() : null,
    latest: async () => source.viewerReplay() } });
  assert.equal((await running.post('start')).status, 200);
  assert.equal((await running.post('observe', view(seed, 1, anchor, 1))).status, 200);
  const current = controller.state;
  assert.equal(current.state_id, 'S110'); assert.equal(current.turn, 6); assert.equal(current.terminal, false);
  assert.equal(current.result, undefined); assert.equal(current.coachNotes, undefined);
  assert.deepEqual(current.board.players.opponent.hand, []); assert.equal(current.board.players.opponent.name, 'Opponent');
  const allowed = new Set([...replay.deck.map(c => c.arena_id), ...['me', 'opponent'].flatMap(side =>
    ['hand', 'battlefield', 'graveyard', 'exile'].flatMap(zone => current.board.players[side][zone].map(c => c.arena_id))),
    ...current.board.stack.map(c => c.arena_id)]);
  assert.ok(current.rules.every(rule => allowed.has(rule.arena_id)), 'future-only opponent dictionary is excluded');
  const uiReplay = await fetch(`${running.url}api/matches/${seed}`).then(r => r.json());
  assert.equal(Object.keys(uiReplay.games[0].states).length, 265);
  assert.equal((await fetch(`${running.url}api/live-coach/status`).then(r => r.json())).state_id, 'S110');
});

test('cross-match and cross-game navigation revoke old audio before asynchronous source loading completes', async () => {
  for (const next of [view('synthetic-two', 1, 'T1-A1', 2), view('synthetic-one', 2, 'T1-A1', 2)]) {
    const { runtime, controller, adviceId } = await playingRuntime(), gate = deferred();
    runtime.source = async () => gate.promise;
    const pending = runtime.observeView(next);
    assert.equal(controller.current, null); assert.equal(controller.state, null);
    assert.equal(controller.audio(adviceId), null, 'an old audio lease must be inaccessible during new-game loading');
    gate.resolve({ stateForAnchor: () => state(next.match_id, next.game_number) }); await pending; await tick();
    assert.equal(controller.state.match_id, next.match_id); assert.equal(controller.state.game_id, String(next.game_number));
    assert.notEqual(controller.current?.advice?.advice_id, adviceId); await runtime.stop();
  }
});

test('starting a Viewer download invalidates old audio before that download completes without muting the session', async t => {
  const { runtime, controller, adviceId } = await playingRuntime(), download = deferred();
  const running = await server(t, { liveCoach: runtime, replayProvider: {
    list: async () => [], get: async () => download.promise, latest: async () => null } });
  const response = fetch(`${running.url}api/matches/synthetic-two`);
  assert.ok(controller.audio(adviceId));
  const invalidated = await running.post('invalidate', { view_seq: 2 });
  assert.equal(invalidated.status, 200);
  assert.equal(controller.current, null); assert.equal(controller.state, null);
  assert.equal(controller.enabled, true); assert.equal(controller.muted, false);
  assert.equal((await fetch(`${running.url}api/live-coach/audio/${adviceId}`)).status, 410);
  download.resolve({ match: { id: 'synthetic-two' }, games: [] });
  assert.equal((await response).status, 200);
  await runtime.observeView(view('synthetic-two', 1, 'T1-A1', 3)); await tick();
  assert.equal(controller.state.match_id, 'synthetic-two');
  assert.notEqual(controller.current?.advice?.advice_id, adviceId);
  assert.equal((await running.post('invalidate', { view_seq: 0 })).status, 400);
  assert.equal(controller.state.match_id, 'synthetic-two');
});

test('Viewer invalidation makes an already pending source obsolete and ignores stale invalidations', async () => {
  const { runtime, controller } = await playingRuntime(), source = deferred();
  runtime.source = async () => source.promise;
  const pending = runtime.observeView(view('synthetic-one', 1, 'T2-A1', 2));
  runtime.invalidateView(3);
  source.resolve({ stateForAnchor: () => state('synthetic-one', 1, 2) }); await pending; await tick();
  assert.equal(controller.state, null); assert.equal(controller.current, null); assert.equal(runtime.previous, null);
  runtime.source = async match => ({ stateForAnchor: () => state(match) });
  await runtime.observeView(view('synthetic-two', 1, 'T1-A1', 4)); await tick();
  const current = controller.current;
  runtime.invalidateView(3);
  assert.equal(controller.current, current); assert.equal(controller.state.match_id, 'synthetic-two');
  await runtime.stop();
});

test('late navigation completion cannot replace the newest requested view or restart an old voice', async () => {
  const controller = contractController(), runtime = new LiveCoachRuntime({ repoDir, controller }), old = deferred(), latest = deferred();
  runtime.source = async () => ({ stateForAnchor: anchor => anchor === 'T1-A1' ? old.promise : latest.promise });
  await runtime.start();
  const first = runtime.observeView(view('synthetic-one', 1, 'T1-A1', 1));
  const second = runtime.observeView(view('synthetic-one', 1, 'T2-A1', 2));
  latest.resolve(state('synthetic-one', 1, 2)); await second; await tick();
  const audio = controller.current.advice.advice_id;
  old.resolve(state('synthetic-one', 1, 1)); await first; await tick();
  assert.equal(controller.state.state_id, 'S2'); assert.equal(controller.current.advice.advice_id, audio);
  await runtime.observeView(view('synthetic-one', 1, 'T1-A1', 2));
  assert.equal(controller.state.state_id, 'S2', 'duplicate viewer sequence is ignored');
  await runtime.stop();
});

test('backward seek and after-to-before navigation revoke any future audio before prefix loading', async () => {
  for (const target of [view('synthetic-one', 1, 'T1-A1', 3), view('synthetic-one', 1, 'T2-A1', 3, 'before')]) {
    const { runtime, controller } = await playingRuntime();
    runtime.source = async () => ({ stateForAnchor: () => state('synthetic-one', 1, 2) });
    await runtime.observeView(view('synthetic-one', 1, 'T2-A1', 2)); await tick();
    const adviceId = controller.current?.advice?.advice_id;
    const gate = deferred(); runtime.source = async () => gate.promise;
    const pending = runtime.observeView(target);
    assert.equal(controller.audio(adviceId), null, 'rewind may not voice the later frame while loading');
    gate.resolve({ stateForAnchor: () => state('synthetic-one', 1, 1) }); await pending; await runtime.stop();
  }
});

test('source failures and missing anchors discard current leases and return a sanitized route error', async t => {
  const { runtime, controller, adviceId } = await playingRuntime();
  const running = await server(t, { liveCoach: runtime });
  runtime.source = async () => { throw new Error('PrivateFailure /Users/secret.log ghp_secret-token'); };
  const response = await running.post('observe', view('synthetic-one', 1, 'T2-A1', 2));
  assert.equal(response.status, 400); assert.doesNotMatch(await response.text(), /PrivateFailure|secret|Users/);
  assert.equal(controller.audio(adviceId), null); assert.equal(controller.current, null); assert.equal(controller.state, null);
  runtime.source = async () => ({ stateForAnchor: () => null });
  assert.equal((await running.post('observe', view('synthetic-one', 1, 'T3-A1', 3))).status, 200);
  assert.equal(controller.state, null);
});

test('mute and stop routes delete buffers, reject late playback acknowledgements, and leave old audio gone', async t => {
  const { runtime, controller, adviceId } = await playingRuntime();
  const running = await server(t, { liveCoach: runtime }), generation = controller.current.generation;
  const audio = await fetch(`${running.url}api/live-coach/audio/${adviceId}`);
  assert.equal(audio.status, 200); assert.equal(await audio.text(), 'not-real-speech-transport-fixture');
  assert.equal((await running.post('mute')).status, 200); assert.equal(controller.muted, true);
  assert.equal((await fetch(`${running.url}api/live-coach/audio/${adviceId}`)).status, 410);
  assert.equal(controller.acknowledge({ advice_id: adviceId, generation, event: 'first_sound', client_time: 1 }), false);
  assert.equal((await running.post('unmute')).status, 200); assert.equal(controller.muted, false);
  assert.equal((await running.post('stop')).status, 200); assert.equal(controller.enabled, false); assert.equal(controller.state, null);
  assert.equal((await fetch(`${running.url}api/live-coach/audio/${adviceId}`)).status, 410);
});
