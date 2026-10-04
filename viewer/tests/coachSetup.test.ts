import test from 'node:test';
import assert from 'node:assert/strict';
import { coachModelUpdate, coachSetupUpdate, readCoachSetup, readCoachVoices, redactedCoachSetup, refreshCoachModels, saveCoachSetup, stockVoices } from '../src/lib/coachSetup.ts';

test('setup drafts preserve blank keys and voice ids, and enforce backend limits', () => {
  assert.deepEqual(coachSetupUpdate({ minimaxKey: '  ', elevenKey: '', minimaxVoiceId: 'stock-voice', elevenVoiceId: '' }), { minimax_voice_id: 'stock-voice' });
  assert.deepEqual(coachSetupUpdate({ minimaxKey: '', elevenKey: ' new-key ', minimaxVoiceId: '', elevenVoiceId: ' voice-2 ' }), { elevenlabs_api_key: 'new-key', eleven_voice_id: 'voice-2' });
  assert.throws(() => coachSetupUpdate({ minimaxKey: 'x'.repeat(2049), elevenKey: '', minimaxVoiceId: '', elevenVoiceId: '' }), /2048/);
  assert.throws(() => coachSetupUpdate({ minimaxKey: '', elevenKey: '', minimaxVoiceId: '', elevenVoiceId: 'v'.repeat(201) }), /200/);
});

test('client retains only named redacted fields and handles incomplete catalogs', () => {
  const setup = redactedCoachSetup({ offline: true, api_key: 'unexpected-secret', auth: { signedIn: true, modelAvailable: false,
    availableModels: [{ slug: 'gpt-current', display_name: 'Current Model', visibility: 'list', token: 'unexpected-secret' }, { name: 'missing slug' }],
    blockedReason: '当前目录不可用', access_token: 'unexpected-secret' }, voice: { minimax: { keyConfigured: true, keySource: 'environment', voiceSource: 'environment', voiceId: 'stock-1',
      api_key: 'unexpected-secret', voices: [{ id: 'stock-1', name: 'Stock Voice', language: 'zh', gender: 'female', secret: 'unexpected-secret' }] },
    eleven: { keyConfigured: 'unexpected-secret', voiceId: null } }, grant: { token: 'unexpected-secret' } });
  assert.equal(JSON.stringify(setup).includes('unexpected-secret'), false);
  assert.equal(setup.voice.minimax.keyConfigured, true);
  assert.equal(setup.voice.minimax.keySource, 'environment');
  assert.equal(setup.voice.minimax.voiceSource, 'environment');
  assert.equal(setup.voice.eleven.keyConfigured, false);
  assert.equal(setup.voice.eleven.keySource, 'local');
  assert.equal(setup.voice.eleven.voiceSource, 'local');
  assert.deepEqual(setup.auth.availableModels, [{ slug: 'gpt-current', display_name: 'Current Model', visibility: 'list' }]);
  assert.deepEqual(stockVoices([{ id: 'one', name: 'First' }, { id: 'one', name: 'Duplicate' }, { id: 'two' }, null]), [{ id: 'one', name: 'First' }]);
  assert.equal(redactedCoachSetup(null).offline, true);
});

test('environment-supplied keys and voices are never included in local save updates', () => {
  const setup = redactedCoachSetup({ voice: { minimax: { keySource: 'environment', voiceSource: 'environment' }, eleven: { keySource: 'environment', voiceSource: 'local' } } });
  assert.deepEqual(coachSetupUpdate({ minimaxKey: 'new-minimax', elevenKey: 'new-eleven', minimaxVoiceId: 'env-voice', elevenVoiceId: 'local-voice' }, setup.voice), { eleven_voice_id: 'local-voice' });
});

test('MiniMax region loads from redacted status and only a local change is saved', () => {
  const draft = { minimaxKey: '', elevenKey: '', minimaxVoiceId: '', elevenVoiceId: '', minimaxRegion: 'china' as const };
  const local = redactedCoachSetup({ voice: { minimax: { region: 'global', regionSource: 'local' } } });
  assert.deepEqual(coachSetupUpdate(draft, local.voice), { minimax_region: 'china' });
  const unchanged = redactedCoachSetup({ voice: { minimax: { region: 'china', regionSource: 'local' } } });
  assert.deepEqual(coachSetupUpdate(draft, unchanged.voice), {});
  const environment = redactedCoachSetup({ voice: { minimax: { region: 'global', regionSource: 'environment' } } });
  assert.deepEqual(coachSetupUpdate(draft, environment.voice), {});
  assert.equal(local.voice.minimax.region, 'global');
  assert.equal(unchanged.voice.minimax.region, 'china');
});

test('setup actions use fixed same-origin metadata endpoints and session action header', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; options: RequestInit }[] = [];
  globalThis.fetch = (async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return { ok: true, json: async () => String(url).endsWith('/voices') ? { provider: 'eleven', voices: [{ id: 'one', name: 'Stock' }] } : { offline: true } } as Response;
  }) as typeof fetch;
  try {
    await readCoachSetup();
    await saveCoachSetup({ minimax_voice_id: 'stock-1' });
    await refreshCoachModels();
    assert.deepEqual(await readCoachVoices('eleven'), [{ id: 'one', name: 'Stock' }]);
    assert.deepEqual(calls.map(call => [call.url, call.options.method]), [['/api/live-coach/setup', 'GET'], ['/api/live-coach/setup', 'POST'], ['/api/live-coach/setup/models', 'POST'], ['/api/live-coach/setup/voices', 'POST']]);
    for (const call of calls) {
      assert.equal((call.options.headers as Record<string, string>)['X-MTGA-Coach-Action'], 'session');
      assert.equal(call.options.credentials, 'same-origin');
      assert.equal(call.options.redirect, 'error');
      assert.equal(call.options.cache, 'no-store');
    }
    assert.equal(calls[2].options.body, '{}');
    assert.equal(calls[3].options.body, '{"provider":"eleven"}');
  } finally { globalThis.fetch = original; }
});

test('provider failures never display an error body or response parse snippet', async () => {
  const original = globalThis.fetch;
  try {
    for (const ok of [false, true]) {
      globalThis.fetch = (async () => ({ ok, json: async () => { throw new Error('unexpected-secret in invalid response'); } })) as typeof fetch;
      await assert.rejects(readCoachSetup(), error => error instanceof Error && !error.message.includes('unexpected-secret'));
    }
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ provider: 'minimax', voices: [] }) })) as typeof fetch;
    await assert.rejects(readCoachVoices('eleven'), /服务不一致/);
  } finally { globalThis.fetch = original; }
});


test('model selection saves only an explicit account-catalog choice, respects environment and grants no cash permission', () => {
  const current = redactedCoachSetup({ auth: { provider: 'siwc', selectedModel: 'gpt-6.1-sol', availableModels: [{ slug: 'gpt-5.6-sol' }] } }).auth;
  assert.deepEqual(coachModelUpdate('siwc', 'gpt-5.6-sol', current), { model_id: 'gpt-5.6-sol' });
  assert.throws(() => coachModelUpdate('siwc', 'invented', current), /实际型号/);
  assert.deepEqual(coachModelUpdate('deepseek', '', current), { model_provider: 'deepseek', model_id: '' });
  assert.deepEqual(coachModelUpdate('siwc', 'gpt-5.6-sol', { ...current, selectionSource: 'environment' }), {});
});
