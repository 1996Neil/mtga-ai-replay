// Synthetic CLI harness only: no real account, corpus, speech, or external request.
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const originalConnect = net.Socket.prototype.connect;
let externalAttempts = 0;
net.Socket.prototype.connect = function(...args) {
  let input = args[0]; if (Array.isArray(input)) input = input[0];
  const host = typeof input === 'object' ? input?.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (host && !['localhost','127.0.0.1','::1'].includes(host)) { externalAttempts++; throw Error('External network blocked in synthetic standby CLI'); }
  return originalConnect.apply(this,args);
};
const directory = resolve(process.env.REPLAY2_STANDBY_FIXTURE_DIR);
// Keep default log discovery inside this synthetic home; never parse the user's Player.log.
os.homedir = () => directory;
// Default discovery also includes a global app path outside homedir.
// Make it absent in this child process so a global installation cannot leak logs.
const globalApp = '/Applications/MTGA.app';
const denyGlobal = path => {
  const value = String(path);
  if (value === globalApp || value.startsWith(globalApp + '/')) {
    const error = new Error('Synthetic global app is absent'); error.code = 'ENOENT'; throw error;
  }
};
for (const method of ['readdir', 'stat', 'realpath', 'readFile']) {
  const original = fs.promises[method];
  fs.promises[method] = async (path, ...args) => { denyGlobal(path); return original(path, ...args); };
}
syncBuiltinESMExports();
const { readdir: guardedReadDir } = await import('node:fs/promises');
try { await guardedReadDir(globalApp); throw new Error('Global app isolation missing'); }
catch (error) { if (error.message !== 'Synthetic global app is absent' || error.code !== 'ENOENT') throw error; }
const counts = { metadata:0, model:0, tts:0 };
const countsPath = join(directory,'calls.json'), pendingCountsPath = join(directory,`calls.${process.pid}.tmp`);
const saveCounts = () => {
  writeFileSync(pendingCountsPath,JSON.stringify(counts),{mode:0o600});
  renameSync(pendingCountsPath,countsPath);
};
saveCounts();
let runtime;
process.on('exit',()=>writeFileSync(join(directory,'exit.json'),JSON.stringify({counts,externalAttempts,enabled:runtime?.controller.enabled,muted:runtime?.controller.muted}),{mode:0o600}));
const json = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const stream = value => new Response(`data: ${JSON.stringify(value)}\n\n`,{headers:{'Content-Type':'text/event-stream'}});
function delay(signal, name='delay-model') {
  if (!existsSync(join(directory,name)) || !readFileSync(join(directory,name),'utf8').trim()) return Promise.resolve();
  return new Promise((done,reject) => {
    const timer=setTimeout(done,2000);
    signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
  });
}
globalThis.fetch = async(url,options={}) => {
  if(url==='https://api.deepseek.com/models') { counts.metadata++; saveCounts(); return json({object:'list',data:[{id:'deepseek-flash'}]}); }
  if(url==='https://api.deepseek.com/chat/completions') { counts.model++; saveCounts(); await delay(options.signal); options.signal.throwIfAborted(); return json({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:'{"action_id":"synthetic-1","reason":"transport fixture"}'}}],usage:{prompt_tokens:1,completion_tokens:1}}); }
  if(url==='https://api.openai.com/v1/models') { counts.metadata++; saveCounts(); return json({models:[{slug:'synthetic-sol',display_name:'mock',visibility:'list'}]}); }
  if(String(url).endsWith('/v1/get_voice')) { counts.metadata++; saveCounts(); await delay(options.signal,'delay-voice'); options.signal.throwIfAborted(); return json({base_resp:{status_code:0},system_voice:[{voice_id:'synthetic-stock',voice_name:'synthetic'}]}); }
  if(url==='https://api.openai.com/v1/responses') { counts.model++; saveCounts(); await delay(options.signal); options.signal.throwIfAborted(); return stream({type:'response.completed',response:{status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{content:[{type:'output_text',text:'{"action_id":"synthetic-1","reason":"transport fixture"}'}]}]}}); }
  if(String(url).endsWith('/v1/t2a_v2')) { counts.tts++; saveCounts(); return stream({base_resp:{status_code:0},data:{status:2,audio:Buffer.from('synthetic-not-acoustic-speech').toString('hex')},extra_info:{usage_characters:1}}); }
  throw Error('Unrecognized synthetic provider route');
};
const { LiveCoachRuntime }=await import('../../src/live-coach/runtime.mjs');
const { ReplaySource }=await import('../../src/live-coach/sources.mjs');
const { SiwcAuth }=await import('../../src/live-coach/providers/siwc.mjs');
SiwcAuth.prototype.summary=()=>({signedIn:true});
SiwcAuth.prototype.catalogKey=()=> 'synthetic-account';
SiwcAuth.prototype.accessToken=async({signal}={})=>{writeFileSync(join(directory,'token-start'),'entered');await delay(signal,'delay-token');signal?.throwIfAborted();return 'synthetic-token';};
const state=seq=>({schema:'MTGA_LIVE_STATE_V1',session_id:'synthetic',source_mode:'replay',match_id:'synthetic-match',game_id:'1',seq,state_id:`synthetic-${seq}`,turn:1,terminal:false,coverage:{state_complete:true}});
const source={cards:[],summary:{match_id:'synthetic-match'},viewerReplay:()=>({schema:'synthetic',games:[]}),stateForAnchor:anchor=>state(Number(anchor.split('-A')[1]))};
ReplaySource.open=async()=>source;
ReplaySource.catalog=async()=>[{id:'synthetic-match',started_at:'2026-01-01T00:00:00Z'}];
const options=[1,2].map(i=>({action_id:`synthetic-${i}`,kind:'explanation',speech_core:'Synthetic transport fixture only.',speech_followup:'',score:3-i,immutable_facts:{i},emotion:'neutral',intensity:0.25}));
const replayProvider = LiveCoachRuntime.prototype.replayProvider;
LiveCoachRuntime.prototype.replayProvider = async function(...args) {
  runtime=this;
  runtime.controller.candidates=()=>options;
  runtime.controller.verify=()=>({valid:true});
  runtime.controller.makeAdvice=(candidate,s)=>({...candidate,session_id:s.session_id,match_id:s.match_id,game_id:s.game_id,seq:s.seq});
  writeFileSync(join(directory,'cold.json'),JSON.stringify({enabled:runtime.controller.enabled,muted:runtime.controller.muted,offline:runtime.setup.offline,counts:{...counts},externalAttempts}),{mode:0o600});
  return replayProvider.apply(this,args);
};
