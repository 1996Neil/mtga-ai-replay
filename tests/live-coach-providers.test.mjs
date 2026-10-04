import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { BudgetLedger, SiwcAuth, PlanModelProvider, StandardApiModelProvider, MiniMaxVoiceProvider, ElevenVoiceProvider, verifyIdToken, SIWC_ENDPOINTS } from '../src/live-coach/providers/index.mjs';

// Contract tests use fake network transports. They are not real API/audio acceptance.
const grant = { approved: true, plan: true, minimax: true, eleven: true, maxPlanRequests: 20, maxTtsRequests: 30, maxChars: 6000, maxUsd: 1 };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const budget = () => new BudgetLedger({ grant });
function stream(events, split = false) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { if (split) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); } else controller.enqueue(bytes); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
const auth = { async accessToken() { return 'fake-oauth-token'; } };
const candidates = [{ action_id: 'checked-A', immutable_facts: { damage: 3 } }];
const catalog = { models: [{ slug: 'gpt-6.1-sol', visibility: 'list', display_name: 'GPT-6.1 Sol' }, { slug: 'hidden', visibility: 'hidden' }] };
const audioHex = Buffer.from('ID3 fake contract bytes').toString('hex');
const voices = { base_resp: { status_code: 0 }, system_voice: [{ voice_id: 'returned-system-voice', voice_name: '中文音色' }] };

test('zero default grant blocks provider calls; an existing key grants no budget', async () => {
  let calls = 0;
  const provider = new MiniMaxVoiceProvider({ apiKey: 'fake-key', budget: new BudgetLedger(), fetchImpl: async () => { calls++; } });
  await assert.rejects(provider.availableVoices(), { code: 'authorization_required' });
  assert.equal(calls, 0);
  await assert.rejects(new StandardApiModelProvider().select(), { code: 'paid_api_not_authorized' });
});

test('budget reservations persist, stop before the cap, and never refund cancellation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mtga-provider-budget-'));
  try {
    const filePath = join(directory, 'usage.json');
    const first = new BudgetLedger({ filePath, grant: { ...grant, maxTtsRequests: 1 } });
    const id = first.reserve({ provider: 'minimax', kind: 'tts', chars: 42, estimatedUsd: 0.1 });
    first.finish(id, { status: 'canceled_usage_unknown' });
    const resumed = new BudgetLedger({ filePath, grant: { ...grant, maxTtsRequests: 1 } });
    assert.equal(resumed.summary().ttsRequests, 1);
    assert.equal(resumed.summary().reservedUsd, 0.1);
    assert.equal(resumed.summary().unknownBillingRequests, 1);
    assert.throws(() => resumed.reserve({ provider: 'minimax', kind: 'tts', chars: 1, estimatedUsd: 0 }), { code: 'budget_exhausted' });
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.throws(() => new BudgetLedger({ grant: { ...grant, maxPlanRequests: 21 } }), { code: 'invalid_grant' });
    const cash = new BudgetLedger({ grant: { ...grant, maxUsd: 0.05 } });
    assert.throws(() => cash.reserve({ provider: 'eleven', kind: 'tts', chars: 1, estimatedUsd: 0.051 }), { code: 'budget_exhausted' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'contract-key', alg: 'RS256', use: 'sig' };
function idToken(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_test', exp: Math.floor(Date.now() / 1000) + 3600, sub: 'contract-subject', ...claims })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

test('identity tokens require signature, exact audience, nonce and unexpired identity', () => {
  const options = { jwks: { keys: [jwk] }, issuer: 'https://auth.openai.com', clientId: 'oaiapp_test', nonce: 'correct' };
  assert.equal(verifyIdToken(idToken({ nonce: 'correct' }), options).sub, 'contract-subject');
  for (const changes of [{ nonce: 'wrong' }, { aud: 'other-client' }, { exp: 1 }, { iss: 'https://other.example' }]) assert.throws(() => verifyIdToken(idToken(changes), options), { code: 'invalid_id_token' });
  const forged = idToken({ nonce: 'correct' }).split('.'); forged[2] = Buffer.from('invalid-signature').toString('base64url');
  assert.throws(() => verifyIdToken(forged.join('.'), options), { code: 'invalid_id_token' });
});

test('SIWC performs its own dynamic registration, PKCE/state/nonce validation and private persistence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mtga-provider-auth-'));
  let requestUrl;
  let exchanges = 0;
  const fakeFetch = async (url, options) => {
    if (url === SIWC_ENDPOINTS.token) {
      exchanges++;
      assert.equal(options.body.get('client_id'), 'oaiapp_test');
      assert.equal(options.body.get('redirect_uri'), requestUrl.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), requestUrl.searchParams.get('code_challenge'));
      assert.equal(options.body.has('client_secret'), false);
      return json({ access_token: 'fake-access', refresh_token: 'fake-refresh', id_token: idToken({ nonce: requestUrl.searchParams.get('nonce') }), scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url === SIWC_ENDPOINTS.discovery) return json({ issuer: 'https://auth.openai.com', authorization_endpoint: SIWC_ENDPOINTS.authorize, token_endpoint: SIWC_ENDPOINTS.token, jwks_uri: SIWC_ENDPOINTS.jwks });
    if (url === SIWC_ENDPOINTS.jwks) return json({ keys: [jwk] });
    throw new Error('Unexpected fake request');
  };
  try {
    const login = new SiwcAuth({ configDir: directory, grant, fetchImpl: fakeFetch });
    assert.equal(login.summary().signedIn, false);
    const pending = await login.startAuthorization();
    requestUrl = new URL(pending.url);
    assert.equal(requestUrl.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(requestUrl.searchParams.get('agent_name_hint'), 'MTGA Live Coach');
    assert.equal(new URL(pending.redirectUri).hostname, '127.0.0.1');
    assert.equal(requestUrl.searchParams.get('scope').includes('chatgpt.tokens.use.direct'), true);
    const invalid = new URL(pending.redirectUri); invalid.searchParams.set('state', 'wrong');
    assert.equal((await fetch(invalid)).status, 400);
    assert.equal(exchanges, 0);
    const callback = new URL(pending.redirectUri);
    callback.searchParams.set('state', requestUrl.searchParams.get('state')); callback.searchParams.set('code', 'fake-code'); callback.searchParams.set('client_id', 'oaiapp_test');
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    assert.equal((await pending.completion).signedIn, true);
    assert.equal(await login.accessToken(), 'fake-access');
    assert.equal(statSync(join(directory, 'siwc-host.json')).mode & 0o777, 0o600);
    const next = await login.startAuthorization();
    const returning = new URL(next.url);
    assert.equal(returning.searchParams.get('client_id'), 'oaiapp_test');
    assert.equal(returning.searchParams.has('agent_name_hint'), false);
    assert.equal(returning.searchParams.get('ext_agent_host_id'), requestUrl.searchParams.get('ext_agent_host_id'));
    const changed = new URL(next.redirectUri); changed.searchParams.set('state', returning.searchParams.get('state')); changed.searchParams.set('code', 'fake-code'); changed.searchParams.set('client_id', 'other-client');
    await fetch(changed);
    await assert.rejects(next.completion, { code: 'invalid_registration' });
    assert.equal(exchanges, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('model uses the account catalog and the supported SIWC request shape; only a completed selection escapes', async () => {
  const ledger = budget();
  let body;
  const provider = new PlanModelProvider({ auth, budget: ledger, siwc_plan_only_confirmed: true, fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return json(catalog);
    body = JSON.parse(options.body);
    return stream([{ type: 'response.output_text.delta', delta: '{"action_id":"checked-A","reason":"三个伤害足够"}' }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 10 } } } }], true);
  } });
  assert.equal((await provider.availableModels()).length, 1);
  const selected = await provider.select({ state: { seq: 110 }, candidates });
  assert.equal(selected.action_id, 'checked-A');
  assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.store, false); assert.equal(body.stream, true); assert.ok(Array.isArray(body.input));
  for (const field of ['max_output_tokens', 'temperature', 'metadata', 'previous_response_id', 'tools']) assert.equal(Object.hasOwn(body, field), false);
  assert.equal(ledger.summary().reasoningTokens, 10); assert.equal(ledger.summary().cachedInputTokens, 20); assert.equal(ledger.summary().planRequests, 1);
});

test('issued SIWC client ID survives a failed exchange without claiming the account authenticated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mtga-provider-pending-'));
  try {
    const login = new SiwcAuth({ configDir: directory, grant, fetchImpl: async () => new Response('', { status: 400 }) });
    const first = await login.startAuthorization(); const authorization = new URL(first.url);
    const callback = new URL(first.redirectUri); callback.searchParams.set('state', authorization.searchParams.get('state')); callback.searchParams.set('client_id', 'oaiapp_issued'); callback.searchParams.set('code', 'failed-code');
    await fetch(callback); await assert.rejects(first.completion);
    assert.equal(login.summary().signedIn, false);
    const next = await login.startAuthorization(); const returning = new URL(next.url);
    assert.equal(returning.searchParams.get('client_id'), 'oaiapp_issued'); assert.equal(returning.searchParams.has('agent_name_hint'), false);
    next.cancel(); await assert.rejects(next.completion, { name: 'AbortError' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('partial model output, failed terminal and invented action ID are rejected and accounted', async () => {
  for (const events of [
    [{ type: 'response.output_text.delta', delta: '{"action_id":"checked-A"}' }],
    [{ type: 'response.output_text.delta', delta: '{"action_id":"checked-A"}' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }],
    [{ type: 'response.output_text.delta', delta: '{"action_id":"unverified"}' }, { type: 'response.completed' }],
  ]) {
    const ledger = budget(); const provider = new PlanModelProvider({ auth, budget: ledger, siwc_plan_only_confirmed: true, fetchImpl: async url => url.endsWith('/models') ? json(catalog) : stream(events) });
    await assert.rejects(provider.select({ state: {}, candidates }));
    assert.equal(ledger.summary().planRequests, 1); assert.equal(ledger.summary().unknownBillingRequests, 1);
  }
});

test('absent Sol stops without inference or fallback', async () => {
  let inferenceCalls = 0;
  const provider = new PlanModelProvider({ auth, budget: budget(), siwc_plan_only_confirmed: true, fetchImpl: async url => { if (url.endsWith('/models')) return json({ models: [] }); inferenceCalls++; } });
  await assert.rejects(provider.select({ state: {}, candidates }), { code: 'model_unavailable' });
  assert.equal(inferenceCalls, 0);
});

test('already canceled model requests do not leave the provider stuck busy', async () => {
  const controller = new AbortController(); controller.abort();
  const provider = new PlanModelProvider({ auth, budget: budget(), siwc_plan_only_confirmed: true, fetchImpl: async url => url.endsWith('/models') ? json(catalog) : stream([{ type: 'response.output_text.delta', delta: '{"action_id":null}' }, { type: 'response.completed' }]) });
  await assert.rejects(provider.select({ state: {}, candidates, signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await provider.select({ state: {}, candidates })).action_id, null);
});

test('account changes invalidate the running provider’s plan-only assurance before another inference', async () => {
  let account = 'one'; let catalogRequests = 0; let inferenceCalls = 0;
  const ledger = budget();
  const changingAuth = { ...auth, catalogKey() { return account; } };
  const provider = new PlanModelProvider({ auth: changingAuth, budget: ledger, siwc_plan_only_confirmed: true, fetchImpl: async url => {
    if (url.endsWith('/models')) { catalogRequests++; return json(catalog); }
    inferenceCalls++;
    return stream([{ type: 'response.output_text.delta', delta: '{"action_id":null}' }, { type: 'response.completed' }]);
  } });
  await provider.select({ state: {}, candidates }); account = 'two';
  assert.equal((await provider.availableModels())[0].slug, 'gpt-6.1-sol');
  await assert.rejects(provider.select({ state: {}, candidates }), { code: 'siwc_plan_only_account_changed' });
  assert.equal(catalogRequests, 2); assert.equal(inferenceCalls, 1); assert.equal(ledger.summary().planRequests, 1);
});

test('corrupted private ledger fails closed and never echoes its secret-like contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mtga-provider-corrupt-'));
  try {
    const filePath = join(directory, 'usage.json');
    writeFileSync(filePath, 'SECRET-MUST-NOT-APPEAR', { mode: 0o600 });
    assert.throws(() => new BudgetLedger({ filePath, grant }), error => error.code === 'invalid_private_file' && !error.message.includes('SECRET'));
    writeFileSync(filePath, JSON.stringify({ version: 1, entries: [{ kind: 'tts', chars: -1, reservedUsd: -1 }] }), { mode: 0o600 });
    assert.throws(() => new BudgetLedger({ filePath, grant }), { code: 'invalid_ledger' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SIWC login and plan-call approval do not authorize potentially billed credits inference', async () => {
  for (const assurance of [undefined, false, 'true']) {
    const ledger = budget(); let inferenceCalls = 0;
    const provider = new PlanModelProvider({ auth, budget: ledger, siwc_plan_only_confirmed: assurance, fetchImpl: async url => {
      if (url.endsWith('/models')) return json(catalog);
      inferenceCalls++; return stream([{ type: 'response.completed' }]);
    } });
    // The account's live model directory is available; this does not establish billing mode.
    assert.equal((await provider.availableModels())[0].slug, 'gpt-6.1-sol');
    await assert.rejects(provider.select({ state: { seq: 110 }, candidates }), error => error.code === 'siwc_plan_only_unconfirmed' && error.message.includes('credits fallback') && error.message.includes('Usage'));
    assert.equal(inferenceCalls, 0); assert.equal(ledger.summary().planRequests, 0);
    assert.equal(ledger.summary().siwcCreditsUsage, 'not_reported_by_inference_contract');
    assert.equal(Object.hasOwn(ledger.summary(), 'planCashUsd'), false);
  }
});

test('MiniMax streams real byte contract, verifies returned voice and avoids aggregate audio duplication', async () => {
  const ledger = budget(); let sent;
  const provider = new MiniMaxVoiceProvider({ apiKey: 'fake-key', budget: ledger, fetchImpl: async (url, options) => {
    if (url.endsWith('/get_voice')) return json(voices);
    sent = JSON.parse(options.body);
    return stream([{ base_resp: { status_code: 0 }, data: { audio: audioHex, status: 1 } }, { base_resp: { status_code: 0 }, data: { status: 2 }, extra_info: { usage_characters: 7 } }], true);
  } });
  const chunks = [];
  for await (const chunk of provider.synthesize('不用攻击，打三点。', { voiceId: 'returned-system-voice', emotion: 'excited' })) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'ID3 fake contract bytes');
  assert.equal(sent.model, 'speech-2.8-turbo'); assert.equal(sent.stream, true); assert.equal(sent.stream_options.exclude_aggregated_audio, true); assert.equal(sent.voice_setting.vol, 1); assert.equal(sent.voice_setting.emotion, 'happy');
  assert.equal(ledger.summary().ttsRequests, 1);
  assert.equal(ledger.summary().actualUsdSource, 'returned_usage_times_documented_rate_not_invoice');
  await assert.rejects(async () => { for await (const _ of provider.synthesize('测试', { voiceId: 'invented' })) {} }, { code: 'voice_unavailable' });
  assert.equal(ledger.summary().ttsRequests, 1);
});

test('MiniMax consumer cancellation stops late audio while preserving possible billable usage', async () => {
  const ledger = budget(); const controller = new AbortController();
  const provider = new MiniMaxVoiceProvider({ apiKey: 'fake-key', budget: ledger, fetchImpl: async url => url.endsWith('/get_voice') ? json(voices) : stream([{ data: { audio: audioHex, status: 1 } }, { data: { audio: audioHex, status: 1 } }, { data: { status: 2 } }]) });
  const iterator = provider.synthesize('请看当前场面', { voiceId: 'returned-system-voice', signal: controller.signal });
  assert.ok((await iterator.next()).value.length);
  controller.abort();
  await assert.rejects(iterator.next(), { name: 'AbortError' });
  assert.equal(ledger.summary().ttsRequests, 1); assert.equal(ledger.summary().unknownBillingRequests, 1);
});

test('MiniMax mainland uses only its selected official host and conservatively reserves double characters with CNY usage', async () => {
  const ledger = budget(), urls = [];
  const provider = new MiniMaxVoiceProvider({ apiKey: 'fake-key', budget: ledger, region: 'china', fetchImpl: async url => {
    urls.push(url); return url.endsWith('/get_voice') ? json(voices) : stream([{ data: { audio: audioHex, status: 1 } },
      { data: { status: 2 }, extra_info: { usage_characters: 4 } }]);
  } });
  for await (const _ of provider.synthesize('三点', { voiceId: 'returned-system-voice' })) {}
  assert.deepEqual(urls, ['https://api.minimax.cn/v1/get_voice', 'https://api.minimax.cn/v1/t2a_v2']);
  assert.equal(ledger.summary().chars, 4); assert.equal(ledger.summary().reservedUsd, 0.00048);
  assert.equal(ledger.data.entries[0].usage.estimated_cny, 0.0008); assert.equal(ledger.data.entries[0].usage.billing_currency, 'CNY');
  assert.equal(ledger.data.entries[0].actualUsd, null);
  assert.equal(ledger.summary().actualUsd, null);
  assert.equal(ledger.summary().estimatedCny, 0.0008);
  assert.throws(() => new MiniMaxVoiceProvider({ region: 'https://foreign.example' }), { code: 'invalid_minimax_region' });
});

test('MiniMax catalog rejection exposes only a numeric provider code and never retries another region', async () => {
  const urls = [], provider = new MiniMaxVoiceProvider({ apiKey: 'fake-key', budget: budget(), region: 'china', fetchImpl: async url => {
    urls.push(url); return json({ base_resp: { status_code: 2049, status_msg: 'SECRET-MUST-NOT-ECHO' } });
  } });
  await assert.rejects(provider.availableVoices(), error => error.message.includes('2049') && !error.message.includes('SECRET'));
  assert.deepEqual(urls, ['https://api.minimax.cn/v1/get_voice']);
});

class FakeDialogueSocket extends EventTarget {
  static instances = [];
  constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; FakeDialogueSocket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  send(raw) {
    const message = JSON.parse(raw); this.sent.push(message);
    if (message.close_socket) queueMicrotask(() => { if (this.readyState !== 1) return; this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ audio: Buffer.from('ID3 dialogue bytes').toString('base64') }) })); this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ is_final: true }) })); });
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const elevenFetch = async url => url.endsWith('/models') ? json([{ model_id: 'eleven_v4_turbo', can_do_text_to_speech: true }]) : json({ voices: [{ voice_id: 'returned-premade-voice', category: 'premade', labels: { language: 'zh' } }], has_more: false });

test('Eleven verifies v4 and premade voice, uses dialogue WS, flushes short speech, and closes', async () => {
  const ledger = budget();
  const provider = new ElevenVoiceProvider({ apiKey: 'fake-key', budget: ledger, fetchImpl: elevenFetch, WebSocketImpl: FakeDialogueSocket });
  const chunks = []; for await (const chunk of provider.synthesize('先别攻击。', { voiceId: 'returned-premade-voice', emotion: 'excited' })) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'ID3 dialogue bytes');
  const socket = FakeDialogueSocket.instances.at(-1); const url = new URL(socket.url);
  assert.equal(url.pathname, '/v1/text-to-dialogue/stream-input'); assert.equal(url.searchParams.get('model_id'), 'eleven_v4_turbo'); assert.equal(url.searchParams.has('xi-api-key'), false);
  assert.deepEqual(socket.sent[0].voices, ['returned-premade-voice']); assert.equal(socket.sent[2].flush, true); assert.equal(socket.sent[3].close_socket, true); assert.equal(socket.readyState, 3);
  assert.equal(ledger.summary().ttsRequests, 1); assert.equal(ledger.summary().unknownBillingRequests, 1);
});

test('Eleven missing v4 stops before a WS and no old endpoint or model is used', async () => {
  const before = FakeDialogueSocket.instances.length;
  const provider = new ElevenVoiceProvider({ apiKey: 'fake-key', budget: budget(), fetchImpl: async () => json([{ model_id: 'eleven_v3' }]), WebSocketImpl: FakeDialogueSocket });
  await assert.rejects(async () => { for await (const _ of provider.synthesize('测试', { voiceId: 'returned-premade-voice' })) {} }, { code: 'model_unavailable' });
  assert.equal(FakeDialogueSocket.instances.length, before);
});

test('Eleven abort rejects queued audio and counts the canceled request', async () => {
  const ledger = budget(); const controller = new AbortController();
  const provider = new ElevenVoiceProvider({ apiKey: 'fake-key', budget: ledger, fetchImpl: elevenFetch, WebSocketImpl: FakeDialogueSocket });
  const iterator = provider.synthesize('测试撤销', { voiceId: 'returned-premade-voice', signal: controller.signal });
  assert.ok((await iterator.next()).value.length);
  controller.abort(); await assert.rejects(iterator.next(), { name: 'AbortError' });
  assert.equal(FakeDialogueSocket.instances.at(-1).readyState, 3); assert.equal(ledger.summary().ttsRequests, 1);
});
