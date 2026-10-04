import test from 'node:test';
import assert from 'node:assert/strict';
import { CoachController } from '../src/live-coach/controller.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const state = (changes = {}) => ({ session_id: 's', match_id: 'm', game_id: 'g', seq: 1, state_id: 'S1',
  source_mode: 'replay', turn: 6, observed_at_monotonic: 12, coverage: { state_complete: true }, target: true, ...changes });
const option = { action_id: 'certified', kind: 'tactic', score: 80, immutable_facts: { amount: 3 }, speech_core: '三点。', speech_followup: '这回不用攻击。', subtitle: '三点。' };
const options = { candidates: () => [option], verify: (_, s) => ({ valid: s.target === true }),
  makeAdvice: (c,s) => ({ ...c, session_id: s.session_id, match_id: s.match_id, game_id: s.game_id, seq: s.seq }), voiceId: 'configured-test-voice' };
test('a late TTS packet cannot publish an audio lease after target leaves', async () => {
  const gate = deferred(), events = [];
  const coach = new CoachController({ ...options, voice: { async *synthesize(_, { signal }) { await gate.promise; yield Buffer.from('contract-test-audio'); assert.equal(signal.aborted, true); } } });
  coach.on('event', event => events.push(event)); coach.start(); coach.observe(state());
  coach.observe(state({ seq: 2, target: false })); gate.resolve(); await tick();
  assert.equal(events.some(event => event.type === 'audio'), false); assert.equal(coach.current, null);
});
test('irrelevant state IDs do not restart TTS; duplicates speak only once', async () => {
  const gate = deferred(); let calls = 0; const events = [];
  const coach = new CoachController({ ...options, voice: { async *synthesize() { calls++; await gate.promise; yield Buffer.from('contract-test-audio'); } } });
  coach.on('event', event => events.push(event)); coach.start(); coach.observe(state()); coach.observe(state({ seq: 2, state_id: 'S2', cosmetic: true }));
  gate.resolve(); await tick(); const audio = events.find(event => event.type === 'audio'); assert.ok(audio); assert.equal(calls, 1);
  assert.ok(coach.audio(audio.advice_id)); coach.acknowledge({ advice_id: audio.advice_id, generation: audio.generation, event: 'ended', client_time: 33 });
  coach.observe(state({ seq: 3 })); await tick(); assert.equal(calls, 1);
});
test('mute aborts generation, deletes ready buffers, rejects old playback callbacks and suppresses subsequent requests', async () => {
  let captured; const events=[];
  const coach = new CoachController({ ...options, voice: { async *synthesize(_, { signal }) { captured=signal; yield Buffer.from('contract-test-audio'); } } });
  coach.on('event', event=>events.push(event)); coach.start(); coach.observe(state()); await tick();
  const audio=events.find(e=>e.type==='audio'); assert.ok(audio); coach.mute();
  assert.equal(captured.aborted,true); assert.equal(coach.audio(audio.advice_id),null);
  assert.equal(coach.acknowledge({advice_id:audio.advice_id,generation:audio.generation,event:'first_sound',client_time:99}),false);
  coach.observe(state({seq:2})); assert.equal(coach.current,null);
});
test('new game, terminal and unknown reconstruction invalidate every stage', async()=>{
  for(const changes of [{game_id:'g2',target:false},{terminal:true},{coverage:{state_complete:false}}]) {
    const gate=deferred(),events=[];const coach=new CoachController({...options,voice:{async *synthesize(){await gate.promise;yield Buffer.from('test');}}});
    coach.on('event',e=>events.push(e));coach.start();coach.observe(state());coach.observe(state({seq:2,...changes}));gate.resolve();await tick();
    assert.equal(events.filter(e=>e.type==='audio').length,0);assert.equal(coach.current,null);
  }
});
test('late model selection is revalidated and model text cannot rewrite verified facts',async()=>{
  const gate=deferred(), events=[];const other={...option,action_id:'other',score:1};
  const coach=new CoachController({...options,candidates:()=>[option,other],model:{async select(){await gate.promise;return{action_id:'certified',speech_core:'wrong number 99'};}},voice:{async *synthesize(text){assert.equal(text,'三点。 这回不用攻击。');yield Buffer.from('test');}}});
  coach.on('event',e=>events.push(e));coach.start();coach.observe(state());coach.observe(state({seq:2,target:false}));gate.resolve();await tick();
  assert.equal(events.filter(e=>e.type==='audio').length,0);
});
test('provider failure remains explicit and never fabricates audio',async()=>{
  const coach=new CoachController(options);coach.start();coach.observe(state());await tick();
  assert.match(coach.snapshot().error,/真实语音阻塞/);assert.equal(coach.current.phase,'voice_blocked');assert.equal(coach.current.audio,null);assert.equal(coach.records[0].tts_first_packet_at,undefined);
});

test('browser playback failure revokes the lease, mutes subsequent observations and stores only bounded diagnostics', async () => {
  let calls = 0; const events = [];
  const coach = new CoachController({ ...options, voice: { async *synthesize() { calls++; yield Buffer.from('contract-only'); } } });
  coach.on('event', event => events.push(event)); coach.start(); coach.observe(state()); await tick();
  const audio = events.find(event => event.type === 'audio');
  assert.equal(coach.acknowledge({ ...audio, event: 'playback_error', client_time: 23, error_stage: 'decode', error_name: 'SECRET token payload' }), true);
  assert.equal(coach.snapshot().muted, true); assert.equal(coach.audio(audio.advice_id), null);
  assert.match(coach.snapshot().error, /解码失败/); assert.equal(coach.records[0].playback_error_stage, 'decode');
  assert.equal(coach.records[0].playback_error_name, 'unknown'); assert.doesNotMatch(JSON.stringify(coach.snapshot()), /SECRET/);
  coach.observe(state({ seq: 2 })); await tick(); assert.equal(calls, 1);
});

test('intentional model silence is quiet and unchanged candidates do not repeatedly consume quota',async()=>{
  let calls=0;const coach=new CoachController({...options,candidates:()=>[option,{...option,action_id:'other'}],model:{async select(){calls++;return{action_id:null,reason:'取舍暂不清晰'};}}});
  coach.start();coach.observe(state());await tick();coach.observe(state({seq:2,state_id:'S2',cosmetic:true}));await tick();
  assert.equal(calls,1);assert.equal(coach.current,null);assert.equal(coach.snapshot().error,null);
  assert.equal(coach.records[0].selection.action_id,null);
  coach.observe(state({game_id:'g2'}));await tick();assert.equal(calls,2);
});
