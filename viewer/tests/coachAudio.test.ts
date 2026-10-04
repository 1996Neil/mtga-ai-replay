import test from 'node:test';
import assert from 'node:assert/strict';
import { CoachAudioSink } from '../src/lib/coachAudio.ts';
const decodedAudio = () => ({ duration: 0.1, length: 3200, sampleRate: 32000, numberOfChannels: 1 });
test('mute drops late decode callbacks and clears local sources immediately', async () => {
  let finishDecode: (v: any) => void = () => {}, started = 0, stopped = 0;
  const source = { connect() {}, disconnect() {}, start() { started++; }, stop() { stopped++; }, onended: null, buffer: null };
  const gain = { gain: { value: 0.5 }, connect() {} };
  const context = { destination: {}, createGain: () => gain, resume: async () => {}, close: async () => {},
    decodeAudioData: () => new Promise(resolve => { finishDecode = resolve; }), createBufferSource: () => source };
  const sink = new CoachAudioSink(() => {}, () => context as unknown as AudioContext,
    (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(5) })) as unknown as typeof fetch);
  await sink.enable(); const pending=sink.play({ advice_id:'a',generation:1,url:'/test' });
  await new Promise(resolve => setImmediate(resolve)); sink.mute(); finishDecode(decodedAudio()); await pending;
  assert.equal(started,0);assert.equal(gain.gain.value,0);assert.equal(stopped,0);
  await sink.enable(); const playback=sink.play({ advice_id:'b',generation:2,url:'/test' });
  await new Promise(resolve=>setImmediate(resolve));finishDecode(decodedAudio());await playback;assert.equal(started,1);
  sink.mute();assert.equal(stopped,1);assert.equal(gain.gain.value,0);await sink.close();
});

function harness(options: { fetch?: typeof fetch; decode?: () => Promise<unknown>; start?: () => void } = {}) {
  const receipts: Record<string, unknown>[] = [];
  const source = { connect() {}, disconnect() {}, start: options.start || (() => {}), stop() {}, onended: null, buffer: null };
  const gain = { gain: { value: 0 }, connect() {} };
  const context = { destination: {}, createGain: () => gain, resume: async () => {}, close: async () => {},
    decodeAudioData: options.decode || (async () => decodedAudio()), createBufferSource: () => source };
  const transport = options.fetch || (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } })) as typeof fetch;
  const sink = new CoachAudioSink(value => receipts.push(value), () => context as unknown as AudioContext, transport);
  return { sink, receipts, gain, source };
}

test('audio transport is called without the sink receiver, matching native Window.fetch', async () => {
  let receiver: unknown = 'not called';
  const { sink, receipts } = harness({ fetch: (function(this: unknown) {
    receiver = this;
    if (this !== undefined) throw new TypeError('Illegal invocation; private transport detail');
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } }));
  }) as typeof fetch });
  await sink.enable(); await sink.play({ advice_id: 'native-fetch', generation: 1, url: '/private-audio-url' });
  assert.equal(receiver, undefined); assert.equal(receipts[0]?.event, 'first_sound');
  await sink.close();
});

test('valid playback failures emit only a bounded stage/name and immediately mute', async () => {
  const named = (name: string) => Object.assign(new Error('private provider body and secret URL'), { name });
  const failures: { stage: string; name: string; options: Parameters<typeof harness>[0] }[] = [
    { stage: 'fetch', name: 'HTTPError', options: { fetch: (async () => new Response('private provider body', { status: 502 })) as typeof fetch } },
    { stage: 'fetch', name: 'TypeError', options: { fetch: (async () => { throw named('TypeError'); }) as typeof fetch } },
    { stage: 'fetch', name: 'AudioTypeError', options: { fetch: (async () => new Response('private html body', { headers: { 'Content-Type': 'text/html' } })) as typeof fetch } },
    { stage: 'decode', name: 'EmptyAudioBufferError', options: { fetch: (async () => new Response(new ArrayBuffer(0))) as typeof fetch } },
    { stage: 'decode', name: 'EncodingError', options: { decode: async () => { throw named('EncodingError'); } } },
    { stage: 'decode', name: 'InvalidAudioBufferError', options: { decode: async () => ({ duration: 0, length: 0, sampleRate: 32000, numberOfChannels: 1 }) } },
    { stage: 'start', name: 'InvalidStateError', options: { start: () => { throw named('InvalidStateError'); } } },
    { stage: 'start', name: 'UnknownError', options: { start: () => { throw named('private-secret-error-name'); } } },
  ];
  for (const failure of failures) {
    const { sink, receipts, gain } = harness(failure.options);
    await sink.enable(); await sink.play({ advice_id: 'failure', generation: 1, url: '/private-audio-url' });
    assert.equal(receipts.length, 1); assert.equal(receipts[0].event, 'playback_error');
    assert.equal(receipts[0].error_stage, failure.stage); assert.equal(receipts[0].error_name, failure.name);
    assert.equal(JSON.stringify(receipts).includes('private'), false);
    assert.equal(sink.muted, true); assert.equal(gain.gain.value, 0);
    await sink.close();
  }
});

test('mute suppresses late HTTP and decode failure receipts for a cancelled lease', async () => {
  for (const stage of ['fetch', 'decode']) {
    let reject: (value: unknown) => void = () => {};
    const pending = new Promise<never>((_, rejectPromise) => { reject = rejectPromise; });
    const { sink, receipts } = harness(stage === 'fetch' ? { fetch: (() => pending) as typeof fetch } : { decode: () => pending });
    await sink.enable(); const playback = sink.play({ advice_id: 'cancelled', generation: 1, url: '/private-audio-url' });
    await new Promise(resolve => setImmediate(resolve)); sink.mute(); reject(new Error('private cancelled failure')); await playback;
    assert.deepEqual(receipts, []); assert.equal(sink.muted, true); await sink.close();
  }
});

test('latest mute or close wins over a pending audio enable', async () => {
  for (const action of ['mute','close']) {
    let resume: () => void = () => {};
    const gain = { gain: { value: 0 }, connect() {} };
    const context = { destination: {}, createGain: () => gain,
      resume: () => new Promise<void>(resolve => { resume = resolve; }), close: async () => {} };
    const sink = new CoachAudioSink(() => {}, () => context as unknown as AudioContext);
    const enabling = sink.enable();
    if (action === 'mute') sink.mute(); else await sink.close();
    resume(); assert.equal(await enabling,false); assert.equal(sink.muted,true); assert.equal(gain.gain.value,0);
  }
});
