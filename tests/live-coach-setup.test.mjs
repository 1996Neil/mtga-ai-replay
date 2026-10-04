import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCoachConfig, saveVoiceConfig, PHASE1_GRANT, clearSiwcPlanOnlyConfirmation, currentPlanOnlyConfirmation } from '../src/live-coach/config.mjs';
import { privateJsonWrite, privateJsonRead } from '../src/live-coach/providers/common.mjs';
import { CoachSetup } from '../src/live-coach/setup.mjs';
import { BudgetLedger } from '../src/live-coach/providers/budget.mjs';
import { createModelProvider, DEEPSEEK_CEILINGS } from '../src/live-coach/providers/index.mjs';
import { PlanModelProvider } from '../src/live-coach/providers/model.mjs';
import { CoachController } from '../src/live-coach/controller.mjs';
import { startReplayServer } from '../src/server.mjs';

const deferred = () => { let resolve; const promise = new Promise(res => { resolve = res; }); return { promise, resolve }; };
async function fixture(t, { offline = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mtga-coach-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  privateJsonWrite(join(directory, 'config.json'), { grant: PHASE1_GRANT, siwc_plan_only_confirmed: false, unrelated: { preserve: true } });
  privateJsonWrite(join(directory, 'credentials.json'), { unrelated_key: 'preserve-other-credential' });
  const budget = new BudgetLedger({ filePath: join(directory, 'usage.json'), grant: PHASE1_GRANT });
  const calls = { metadata: 0, inference: 0, tts: 0 }, controller = new CoachController({ ledger: budget });
  const auth = { summary: () => ({ signedIn: true }), catalogKey: () => 'account-fixture' };
  const model = { catalog: null, catalogAccount: null, async availableModels() { calls.metadata++; this.catalogAccount = auth.catalogKey();
    return this.catalog = [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list' }]; }, async select() { calls.inference++; throw new Error('must not infer'); } };
  const factory = ({ apiKey }) => ({ async availableVoices() { calls.metadata++; return [{ voice_id: 'stock-chinese', voice_name: '中文现成声音',
    language: ['Chinese'], gender: 'female', raw_secret: apiKey }]; }, async *synthesize() { calls.tts++; throw new Error('must not synthesize'); } });
  const setup = await new CoachSetup({ directory, auth, model, budget, controller, offline, miniFactory: factory, elevenFactory: factory }).initialize();
  return { directory, setup, model, auth, controller, budget, calls };
}

test('local voice save preserves grants, account data and other credentials, validates before writes, and keeps passwords private', async t => {
  const { directory } = await fixture(t);
  const before = await readFile(join(directory, 'config.json'), 'utf8');
  await assert.rejects(saveVoiceConfig({ minimax_api_key: 'new-test-secret', grant: { approved: true } }, directory));
  assert.equal(await readFile(join(directory, 'config.json'), 'utf8'), before);
  assert.equal(privateJsonRead(join(directory, 'credentials.json')).minimax_api_key, undefined);
  await saveVoiceConfig({ minimax_api_key: 'new-test-secret', elevenlabs_api_key: 'other-test-secret', minimax_voice_id: 'stock-chinese' }, directory);
  await saveVoiceConfig({ minimax_api_key: '', elevenlabs_api_key: '   ', eleven_voice_id: 'second-stock' }, directory);
  const config = await readCoachConfig(directory), raw = privateJsonRead(join(directory, 'config.json'));
  assert.equal(config.minimaxKey, 'new-test-secret'); assert.equal(config.elevenKey, 'other-test-secret');
  assert.deepEqual(raw.grant, PHASE1_GRANT); assert.equal(raw.siwc_plan_only_confirmed, false); assert.deepEqual(raw.unrelated, { preserve: true });
  assert.equal(privateJsonRead(join(directory, 'credentials.json')).unrelated_key, 'preserve-other-credential');
  await saveVoiceConfig({ minimax_region: 'china' }, directory);
  assert.equal((await readCoachConfig(directory)).minimaxRegion, 'china');
  await assert.rejects(saveVoiceConfig({ minimax_region: 'https://arbitrary.example' }, directory));
  assert.equal((await stat(join(directory, 'credentials.json'))).mode & 0o777, 0o600); assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const bad of [{ minimax_api_key: 'x'.repeat(2049) }, { elevenlabs_api_key: 'secret\nvalue' }, { minimax_voice_id: 1 }]) await assert.rejects(saveVoiceConfig(bad, directory));
});

test('setup save cancels active advice and mutes; metadata has no inference, speech or consumed budget', async t => {
  const { setup, controller, calls, budget } = await fixture(t);
  controller.start(); const abort = new AbortController(); controller.current = { controller: abort, record: {}, audio: Buffer.from('transport-only') };
  const status = await setup.save({ minimax_api_key: 'never-echo-this-key', minimax_voice_id: 'stock-chinese' });
  assert.equal(abort.signal.aborted, true); assert.equal(controller.muted, true); assert.equal(controller.voice, null);
  assert.equal(controller.spoken.size, 0); assert.equal(controller.analyzed.size, 0); assert.equal(controller.state, null);
  assert.equal(status.voice.minimax.keyConfigured, true); assert.equal(JSON.stringify(status).includes('never-echo-this-key'), false);
  const catalog = await setup.availableVoices('minimax');
  assert.deepEqual(catalog.voices, [{ id: 'stock-chinese', name: '中文现成声音', language: 'Chinese', gender: 'female' }]);
  assert.equal(JSON.stringify(catalog).includes('raw_secret'), false);
  const refreshed = await setup.refreshModels();
  assert.equal(refreshed.auth.modelAvailable, false); assert.match(refreshed.auth.blockedReason, /没有所选型号 gpt-6.1-sol/);
  assert.equal(controller.model, null); assert.equal(controller.voice, null); assert.equal(controller.muted, true);
  assert.equal(calls.metadata, 2); assert.equal(calls.inference, 0); assert.equal(calls.tts, 0); assert.equal(budget.summary().ttsRequests, 0); assert.equal(budget.summary().planRequests, 0);
});

test('real mode saved MiniMax config applies while muted; missing Sol never selects another backend', async t => {
  const { setup, controller, calls } = await fixture(t, { offline: false });
  await setup.save({ minimax_api_key: 'stock-account-test-key', minimax_voice_id: 'stock-chinese' });
  assert.ok(controller.voice); assert.equal(controller.voiceId, 'stock-chinese'); assert.equal(controller.muted, true);
  await setup.refreshModels(); assert.equal(controller.model, null); assert.match(controller.modelStatus, /没有所选型号 gpt-6.1-sol/);
  assert.equal(calls.inference + calls.tts, 0);
});

test('an in-flight metadata query cannot race a credential save or expose a stale catalog after account switch', async t => {
  const { setup, model, auth } = await fixture(t); await setup.save({ minimax_api_key: 'account-test-key' });
  const ready = deferred(); setup.providers.minimax.availableVoices = () => ready.promise;
  const pending = setup.availableVoices('minimax');
  await assert.rejects(setup.save({ minimax_api_key: 'new-account-key' }), /setup_busy/);
  ready.resolve([{ voice_id: 'stock-one' }]); await pending;
  await setup.refreshModels(); assert.ok(setup.snapshot().auth.availableModels.length);
  auth.catalogKey = () => 'other-account'; assert.deepEqual(setup.snapshot().auth.availableModels, []);
  assert.match(setup.snapshot().auth.blockedReason, /尚未读取/); assert.notEqual(model.catalogAccount, auth.catalogKey());
});

test('setup HTTP routes enforce same origin, sanitize failures and never echo passwords', async t => {
  const { setup, directory, controller } = await fixture(t);
  const viewerDir = join(directory, 'viewer'); await mkdir(viewerDir); await writeFile(join(viewerDir, 'index.html'), '<title>setup contract</title>');
  const runtime = { setup, controller, snapshot: () => controller.snapshot(), async stop() { controller.stop(); } };
  const running = await startReplayServer({ viewerDir, dataDir: join(directory, 'data'), writeInfo: false, displayNamesZh: new Map(),
    liveCoach: runtime, fetchFn: async () => { throw new Error('no network in route verification'); } });
  t.after(() => running.close());
  const post = (action, input, headers = {}) => fetch(`${running.url}api/live-coach/${action}`, { method: 'POST',
    headers: { Origin: new URL(running.url).origin, 'Content-Type': 'application/json', 'X-MTGA-Coach-Action': 'session', ...headers }, body: JSON.stringify(input) });
  assert.equal((await post('setup', { minimax_api_key: 'private-password' }, { Origin: 'https://foreign.example' })).status, 403);
  const saved = await post('setup', { minimax_api_key: 'private-password' }); assert.equal(saved.status, 200);
  assert.equal((await saved.text()).includes('private-password'), false);
  const get = await fetch(`${running.url}api/live-coach/setup`); assert.equal((await get.text()).includes('private-password'), false);
  const bad = await post('setup', { minimax_api_key: 'private-password\ninvalid' }); assert.equal(bad.status, 400);
  assert.equal((await bad.text()).includes('private-password'), false);
  assert.equal((await post('setup/voices', { provider: 'minimax' })).status, 200);
  assert.equal((await post('setup/models', {})).status, 200);
  // A second tab or delayed request is blocked during the asynchronous save.
  setup.reconfiguring = true;
  for (const action of ['start', 'unmute', 'observe']) assert.equal((await post(action, {})).status, 400);
  assert.equal((await post('mute', {})).status, 200);
  setup.reconfiguring = false;
});

test('credential save clears blocked dedup and finishes muted even if a delayed direct enable bypasses HTTP', async t => {
  const { setup, controller } = await fixture(t);
  controller.start(); controller.spoken.add('blocked-advice'); controller.analyzed.add('blocked-selection');
  const pending = setup.save({ minimax_api_key: 'new-stock-key' });
  assert.equal(setup.reconfiguring, true); controller.unmute();
  await pending;
  assert.equal(controller.muted, true); assert.equal(controller.current, null);
  assert.equal(controller.spoken.size, 0); assert.equal(controller.analyzed.size, 0);
  assert.equal(setup.reconfiguring, false);
});

test('same-account relogin invalidates a running model before inference even if the file is later reconfirmed', async t => {
  const { setup, directory, budget, auth } = await fixture(t);
  privateJsonWrite(join(directory, 'config.json'), { grant: PHASE1_GRANT, siwc_plan_only_confirmed: true, siwc_plan_only_revision: 'startup-revision' });
  let inferenceCalls = 0; auth.accessToken = async () => 'synthetic-not-a-real-token';
  const makeModel = () => new PlanModelProvider({ auth, budget, siwc_plan_only_confirmed: true,
    planOnlyCheck: () => currentPlanOnlyConfirmation(directory, 'startup-revision'), fetchImpl: async url => {
      if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }] });
      inferenceCalls++; throw new Error('inference must not be reached');
    } });
  const running = makeModel(), untouched = makeModel();
  await running.availableModels(); setup.model = running; setup.config = await readCoachConfig(directory);
  assert.equal(setup.snapshot().auth.blockedReason, null);
  clearSiwcPlanOnlyConfirmation(directory);
  await assert.rejects(running.select({ state: {}, candidates: [{ action_id: 'locally-checked' }] }), /Plan-only SIWC inference is blocked/);
  await setup.refreshModels(); assert.match(setup.snapshot().auth.blockedReason, /尚未确认/); assert.equal(setup.controller.model, null);
  const changed = privateJsonRead(join(directory, 'config.json')); assert.notEqual(changed.siwc_plan_only_revision, 'startup-revision');
  privateJsonWrite(join(directory, 'config.json'), { ...changed, siwc_plan_only_confirmed: true });
  // This old instance never saw the temporary false value: the revision still blocks it.
  await assert.rejects(untouched.select({ state: {}, candidates: [{ action_id: 'locally-checked' }] }), /Plan-only SIWC inference is blocked/);
  await setup.refreshModels(); assert.match(setup.snapshot().auth.blockedReason, /已失效/);
  assert.equal(inferenceCalls, 0); assert.equal(budget.summary().planRequests, 0);
});

test('coach exit cancels directory requests and rejects their late responses without synthesis', async t => {
  const { setup, calls } = await fixture(t); await setup.save({ minimax_api_key: 'local-fixture-key' });
  const ready = deferred(); let signal;
  setup.providers.minimax.availableVoices = async options => { signal = options.signal; return await ready.promise; };
  const pending = setup.availableVoices('minimax'); setup.cancelMetadata();
  assert.equal(signal.aborted, true); ready.resolve([{ voice_id: 'late-voice' }]);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(setup.snapshot().voice.minimax.voices, []); assert.equal(setup.busy, false);
  assert.equal(calls.inference + calls.tts, 0);
});


test('explicit SIWC model choice uses the actual catalog and saves no authorization or cloud call', async t => {
  const { setup, controller, calls, directory } = await fixture(t, { offline: false });
  await setup.refreshModels();
  const status = await setup.save({ model_provider: 'siwc', model_id: 'gpt-5.6-sol' });
  assert.equal(status.auth.selectedModel, 'gpt-5.6-sol'); assert.equal(status.auth.modelAvailable, true);
  assert.match(status.auth.blockedReason, /尚未确认/); assert.equal(controller.model, null); assert.equal(controller.muted, true);
  assert.equal(calls.inference + calls.tts, 0); assert.equal(privateJsonRead(join(directory, 'config.json')).siwc_plan_only_confirmed, false);
  assert.deepEqual(privateJsonRead(join(directory, 'config.json')).grant, PHASE1_GRANT);
  await assert.rejects(setup.save({ model_id: '../bad' }));
  await assert.rejects(setup.save({ deepseek_grant: { approved: true } }));
  await assert.rejects(setup.save({ deepseek_api_key: 'not-accepted-by-existing-key-surface' }));
});

test('changing model provider clears the previous model and never reads an unrelated provider key into model configuration', async t => {
  const { directory } = await fixture(t);
  await saveVoiceConfig({ model_id: 'gpt-5.6-sol' }, directory);
  privateJsonWrite(join(directory, 'credentials.json'), { deepseek_api_key: 'synthetic-only-deepseek-key' });
  assert.equal((await readCoachConfig(directory)).deepseekKey, null);
  await saveVoiceConfig({ model_provider: 'deepseek' }, directory);
  const config = await readCoachConfig(directory);
  assert.equal(config.modelId, null); assert.equal(config.modelProvider, 'deepseek'); assert.equal(config.deepseekGrant.approved, false);
  assert.equal((await readCoachConfig(directory, { provider: 'siwc' })).deepseekKey, null);
  const selected = await readCoachConfig(directory, { provider: 'deepseek', model: 'deepseek-flash' });
  assert.equal(selected.modelId, 'deepseek-flash'); assert.equal(selected.deepseekKey, 'synthetic-only-deepseek-key');
});


test('startup model override stays consistent across setup initialization, metadata and voice save', async t => {
  const { directory, auth, budget, controller } = await fixture(t);
  const model = { model: 'gpt-5.6-sol', catalog: [{ slug: 'gpt-5.6-sol', visibility: 'list' }], catalogAccount: auth.catalogKey() };
  const setup = await new CoachSetup({ directory, auth, budget, controller, model, modelSelection: { provider: 'siwc', model: 'gpt-5.6-sol' } }).initialize();
  assert.equal(setup.snapshot().auth.selectedModel, model.model); assert.equal(setup.snapshot().auth.selectionSource, 'startup');
  await setup.save({ minimax_voice_id: 'synthetic-voice' });
  assert.equal(setup.snapshot().auth.selectedModel, model.model); assert.equal(setup.snapshot().auth.modelAvailable, true);
  assert.equal(privateJsonRead(join(directory, 'config.json')).model_id, undefined);
});


test('authorized DeepSeek metadata works before model selection; selecting from its catalog preserves budget separation and visible usage', async t => {
  const { directory, auth, budget, controller } = await fixture(t);
  const raw = privateJsonRead(join(directory, 'config.json'));
  privateJsonWrite(join(directory, 'config.json'), { ...raw, deepseek_grant: { approved: true, metadata: true, inference: false,
    provider: 'deepseek', model: 'deepseek-flash', ...DEEPSEEK_CEILINGS, expiresAt: '2099-01-01T00:00:00Z' } });
  privateJsonWrite(join(directory, 'credentials.json'), { deepseek_api_key: 'synthetic-key' });
  let requests = 0;
  const modelFactory = config => createModelProvider(config, { auth, budget, fetchImpl: async url => {
    assert.equal(url, 'https://api.deepseek.com/models'); requests++; return Response.json({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
  } });
  const setup = await new CoachSetup({ directory, auth, budget, controller, model: modelFactory(await readCoachConfig(directory)), modelFactory }).initialize();
  await setup.save({ model_provider: 'deepseek', model_id: '' });
  assert.equal(setup.snapshot().auth.selectedModel, null);
  assert.equal(controller.snapshot().model_usage.requests, 0);
  const metadata = await setup.refreshModels(); assert.equal(metadata.auth.availableModels.length, 2); assert.equal(requests, 1);
  const saved = await setup.save({ model_id: 'deepseek-flash' });
  assert.equal(saved.auth.modelAvailable, true); assert.match(saved.auth.blockedReason, /付费推理授权/);
  assert.equal(controller.model, null); assert.equal(controller.snapshot().model_usage.reservedUsd, 0);
  assert.equal(budget.summary().planRequests, 0); assert.equal(budget.summary().ttsRequests, 0); assert.equal(requests, 1);
});
