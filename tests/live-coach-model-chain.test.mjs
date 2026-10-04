import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveCoachRuntime } from '../src/live-coach/runtime.mjs';
import { CoachController } from '../src/live-coach/controller.mjs';
import { LiveSource } from '../src/live-coach/sources.mjs';
import { DeepSeekModelProvider, PlanModelProvider, BudgetLedger, PaidModelBudget, DEEPSEEK_CEILINGS } from '../src/live-coach/providers/index.mjs';
import { modelEvaluationCases, evaluateModelCases } from '../src/live-coach/evaluation.mjs';

const repoDir = process.env.MTGA_PRIVATE_CORPUS_DIR ?? fileURLToPath(new URL('../../..', import.meta.url));
const seed = '32cdbcfa-61f6-4a18-a0a1-afad6dab3062';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(res => { resolve = res; }); return { promise, resolve }; };
const grant = { approved: true, provider: 'deepseek', model: 'deepseek-flash', metadata: true, inference: true,
  ...DEEPSEEK_CEILINGS, expiresAt: '2099-01-01T00:00:00Z' };
function provider(name, afterRequest) {
  const seen = [];
  const budget = name === 'deepseek' ? new PaidModelBudget({ grant }) : new BudgetLedger({ grant: { approved: true, plan: true, maxPlanRequests: 20 } });
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return Response.json(name === 'deepseek' ? { object: 'list', data: [{ id: 'deepseek-flash' }] } : { models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }] });
    const body = JSON.parse(options.body), input = JSON.parse(name === 'deepseek' ? body.messages[1].content : body.input[0].content);
    seen.push(input); await afterRequest?.(options.signal);
    const text = JSON.stringify({ action_id: input.candidates[0].action_id, reason: 'offline contract selection' });
    return name === 'deepseek' ? Response.json({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: text } }] }) :
      new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] } })}\n\n`);
  };
  const model = name === 'deepseek' ? new DeepSeekModelProvider({ apiKey: 'synthetic-key', budget, model: 'deepseek-flash', fetchImpl }) :
    new PlanModelProvider({ auth: { accessToken: async () => 'synthetic-token' }, budget, model: 'gpt-5.6-sol', siwc_plan_only_confirmed: true, fetchImpl });
  return { model, budget, seen };
}
const transportVoice = { async *synthesize(text, { signal }) { signal.throwIfAborted(); assert.match(text, /[\u4e00-\u9fff]/); yield Buffer.from('contract bytes, not MP3 or speech'); } };
const view = (anchor, view_seq) => ({ match_id: seed, game_number: 1, anchor, boundary: 'after', view_seq });

test('both model adapters use identical real sanitized cases and never grade mock latency as service quality', async () => {
  const cases = await modelEvaluationCases(), ds = provider('deepseek'), siwc = provider('siwc');
  const reports = [];
  for (const model of [ds.model, siwc.model]) reports.push(await evaluateModelCases(model, { evidenceMode: 'offline_contract', cases }));
  assert.equal(cases.length, 8); assert.equal(reports[0].model_requests, 5); assert.deepEqual(ds.seen, siwc.seen);
  assert.deepEqual(reports[0].results.map(row => row.input_sha256), reports[1].results.map(row => row.input_sha256));
  for (const report of reports) { assert.equal(report.model_quality_verified, false); assert.equal(report.acoustic_metrics_verified, false);
    assert.equal(report.results.filter(row => row.result === 'local_silence').length, 3); assert.ok(report.results.every(row => row.strategy_correct === null)); }
  for (const input of ds.seen) { assert.deepEqual(input.state.board.players.opponent.hand, []);
    for (const field of ['result', 'winner', 'future_actions', 'coachNotes']) assert.equal(Object.hasOwn(input.state, field), false); }
});

test('real replay changes drive checked Chinese advice, contract audio and lease revocation through both model adapters', { skip: (!process.env.MTGA_PRIVATE_CORPUS_DIR) ? 'Private locked corpus is excluded from this source export' : false }, async () => {
  for (const name of ['siwc', 'deepseek']) {
    const { model } = provider(name), controller = new CoachController({ model, voice: transportVoice, voiceId: 'synthetic-voice' });
    const runtime = new LiveCoachRuntime({ repoDir, controller }); await runtime.start();
    await runtime.observeView(view('T6-A4', 1));
    for (let i = 0; i < 20 && controller.current?.phase !== 'ready'; i++) await tick();
    assert.equal(controller.state.state_id, 'S110'); assert.equal(controller.current?.phase, 'ready');
    const advice = controller.current.advice;
    assert.equal(advice.kind, 'explanation'); assert.match(advice.speech_core, /如果|前提|条件|的话|按当前/);
    assert.equal(controller.records.at(-1).selection.source, name); assert.equal(controller.records.at(-1).selection.model, model.model);
    assert.ok(controller.audio(advice.advice_id));
    await runtime.observeView(view('T6-A5', 2)); await tick();
    assert.equal(controller.audio(advice.advice_id), null); assert.notEqual(controller.current?.advice?.advice_id, advice.advice_id);
    assert.equal(controller.records[0].cancel_reason, 'premise_changed'); await runtime.stop();
  }
});

test('real replay change during model selection aborts both providers before any speech, including late successes', { skip: (!process.env.MTGA_PRIVATE_CORPUS_DIR) ? 'Private locked corpus is excluded from this source export' : false }, async () => {
  for (const name of ['siwc', 'deepseek']) {
    const gate = deferred(); let signal; let voiceCalls = 0;
    const { model, budget } = provider(name, requestSignal => { signal = requestSignal; return gate.promise; });
    const controller = new CoachController({ model, voiceId: 'synthetic-voice', voice: { async *synthesize() { voiceCalls++; yield Buffer.from('unused'); } } });
    const runtime = new LiveCoachRuntime({ repoDir, controller }); await runtime.start(); await runtime.observeView(view('T6-A4', 1));
    for (let i = 0; i < 20 && !signal; i++) await tick(); assert.ok(signal);
    await runtime.observeView(view('T6-A5', 2)); assert.equal(signal.aborted, true);
    gate.resolve(); await tick(); await tick(); assert.equal(voiceCalls, 0); assert.equal(controller.current, null);
    assert.equal(budget.data.entries[0].status, 'canceled_usage_unknown'); await runtime.stop();
  }
});

test('temporary official-format log append drives model/audio cancellation through LiveSource and runtime without touching MTGA', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mtga-log-chain-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = join(directory, 'Player.log');
  const room = { matchGameRoomStateChangedEvent: { gameRoomInfo: { gameRoomConfig: { matchId: 'synthetic-live-match' } } } };
  const message = (id, power, full = false) => ({ greToClientEvent: { greToClientMessages: [{ type: 'GREMessageType_GameStateMessage', systemSeatIds: [2], msgId: id,
    gameStateMessage: { type: full ? 'GameStateType_Full' : 'GameStateType_Diff', gameStateId: id,
      ...(full ? { gameInfo: { gameNumber: 1, stage: 'GameStage_Play' }, turnInfo: { turnNumber: 1, activePlayer: 2, phase: 'Phase_Main1' },
        players: [{ systemSeatNumber: 2, lifeTotal: 20 }, { systemSeatNumber: 1, lifeTotal: 20 }],
        zones: [{ zoneId: 20, type: 'ZoneType_Battlefield', visibility: 'Visibility_Public', objectInstanceIds: [101] }] } : {}),
      gameObjects: [{ instanceId: 101, grpId: 1001, zoneId: 20, type: 'GameObjectType_Card', ownerSeatId: 2, controllerSeatId: 2,
        power: { value: power }, toughness: { value: 2 }, cardTypes: ['CardType_Creature'] }] } }] } });
  await writeFile(logPath, [room, message(1, 2, true)].map(row => JSON.stringify(row)).join('\n') + '\n');
  const { model } = provider('deepseek');
  const options = ['checked-A', 'checked-B'].map(action_id => ({ action_id, kind: 'explanation', speech_core: '当前力量为二，条件有效。', immutable_facts: { power: 2 } }));
  const valid = state => state.board.players.me.battlefield[0]?.power === 2;
  const controller = new CoachController({ model, voice: transportVoice, voiceId: 'synthetic-voice', candidates: state => valid(state) ? options : [],
    verify: (_, state) => ({ valid: valid(state) }), makeAdvice: candidate => candidate });
  const runtime = new LiveCoachRuntime({ repoDir, controller, sourceMode: 'live', logPath, livePractice: true,
    names: new Map([[1001, 'Synthetic visible creature']]) });
  assert.ok(runtime.live instanceof LiveSource); await runtime.start(); t.after(() => runtime.stop());
  for (let i = 0; i < 20 && controller.current?.phase !== 'ready'; i++) await tick();
  assert.equal(controller.state.source_mode, 'live'); assert.equal(controller.current?.phase, 'ready');
  const id = controller.current.advice.advice_id; assert.ok(controller.audio(id));
  await appendFile(logPath, JSON.stringify(message(2, 4)) + '\n'); await runtime.live.pollOnce();
  assert.equal(controller.state.board.players.me.battlefield[0].power, 4); assert.equal(controller.audio(id), null); assert.equal(controller.current, null);
});
