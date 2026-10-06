import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createLauncher, requestJSON } from '../tools/replay2-launcher/launcher.mjs';
import { BudgetLedger } from '../src/live-coach/providers/budget.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const helper=fileURLToPath(new URL('./helpers/standby-cli-mock.mjs',import.meta.url));
const grant={approved:true,plan:true,minimax:true,eleven:false,maxPlanRequests:4,maxTtsRequests:4,maxChars:2000,maxUsd:0.5};
const view=(seq=1)=>({match_id:'synthetic-match',game_number:1,anchor:'T1-A1',boundary:'after',view_seq:seq});
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function until(fn) { for(let i=0;i<100;i++){if(await fn())return;await pause(30);}throw Error('Synthetic fixture deadline exceeded'); }
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const write=async(path,data)=>writeFile(path,JSON.stringify(data),{mode:0o600});
const cleanEnv=()=>{const env={...process.env};for(const key of ['NODE_OPTIONS','MINIMAX_API_KEY','ELEVENLABS_API_KEY','DEEPSEEK_API_KEY','MINIMAX_REGION','MINIMAX_VOICE_ID','ELEVENLABS_VOICE_ID','MTGA_COACH_MODEL_PROVIDER','MTGA_COACH_MODEL'])delete env[key];return env;};
async function fixture(t,override={},modelConfig={}) {
  const dir=await mkdtemp(join(tmpdir(),'replay2-standby-'));
  const config={grant:{...grant,...override},model_provider:'siwc',model_id:'synthetic-sol',siwc_plan_only_confirmed:true,minimax_voice_id:'synthetic-stock',...modelConfig};
  await write(join(dir,'config.json'),config);
  await write(join(dir,'credentials.json'),{minimax_api_key:'synthetic-never-a-real-key',deepseek_api_key:'synthetic-never-a-real-key'});
  await writeFile(join(dir,'delay-model'),'');
  await mkdir(join(dir,'viewer'));await writeFile(join(dir,'viewer/index.html'),'Synthetic test fixture');
  const free=createServer();await new Promise(done=>free.listen(0,'127.0.0.1',done));const port=free.address().port;await new Promise(done=>free.close(done));
  const env=cleanEnv();
  env.REPLAY2_STANDBY_FIXTURE_DIR=dir;
  const child=spawn(process.execPath,['--import',helper,join(root,'bin/mtga-gpt-replay.mjs'),'live-coach','serve','--enable','--standby','--mode','replay','--no-open','--port',String(port),'--config-dir',dir,'--repo-dir',dir,'--data-dir',join(dir,'data'),'--viewer-dir',join(dir,'viewer')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);
  const exit=new Promise(done=>child.once('exit',(code,signal)=>done({code,signal})));
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    await exit;
    try {const facts=await read(join(dir,'exit.json'));assert.equal(facts.externalAttempts,0);}finally{await rm(dir,{recursive:true,force:true});}
  });
  const base=`http://127.0.0.1:${port}`;
  await until(async()=>{if(child.exitCode!==null)throw Error(output);try{return(await requestJSON(base+'/api/health')).service==='mtga-gpt-replay';}catch{return false;}});
  const post=async(path,body={})=>{const result=await fetch(base+'/api/live-coach/'+path,{method:'POST',headers:{Origin:base,'X-MTGA-Coach-Action':'session','Content-Type':'application/json'},body:JSON.stringify(body)});return{status:result.status,body:await result.json()};};
  const status=()=>requestJSON(base+'/api/live-coach/status');
  const counts=()=>read(join(dir,'calls.json'));
  const ready=async()=>{assert.equal((await post('setup/models')).status,200);assert.equal((await post('setup/voices',{provider:'minimax'})).status,200);};
  return{dir,config,child,port,post,status,counts,ready};
}
test('real CLI standby cold and simultaneous launcher reuse stay disabled/muted with zero provider calls',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await read(join(f.dir,'cold.json')),{enabled:false,muted:true,offline:false,counts:{metadata:0,model:0,tts:0},externalAttempts:0});
  await requestJSON(`http://127.0.0.1:${f.port}/api/live-coach/setup`);await f.post('observe',view());
  const launcher=createLauncher({projectRoot:root,port:f.port,stateDir:join(f.dir,'launcher')});
  const results=await Promise.all(Array.from({length:5},()=>launcher.start({openPage:false})));
  assert.ok(results.every(row=>row.pid===f.child.pid));
  assert.deepEqual(await f.counts(),{metadata:0,model:0,tts:0});const status=await f.status();assert.equal(status.enabled,false);assert.equal(status.muted,true);
});
test('explicit existing catalog/start routes reach original fake model/TTS once; duplicates stay quiet',async t=>{
  const f=await fixture(t);assert.equal((await f.post('start')).status,400);assert.equal((await f.status()).enabled,false);
  await f.ready();assert.deepEqual(await f.counts(),{metadata:2,model:0,tts:0});
  assert.equal((await f.post('start')).status,200);await f.post('observe',view());await until(async()=>(await f.status()).status==='ready');
  assert.deepEqual(await f.counts(),{metadata:2,model:1,tts:1});const status=await f.status();assert.equal(status.usage.planRequests,1);assert.equal(status.usage.ttsRequests,1);
  await f.post('start');await f.post('observe',view());await f.post('observe',view(0));await pause(50);assert.deepEqual(await f.counts(),{metadata:2,model:1,tts:1});
});
for(const[name,override]of[['no grant',{approved:false}],['no plan quota',{maxPlanRequests:0}],['no speech requests',{maxTtsRequests:0}],['no character quota',{maxChars:0}],['no cash quota',{maxUsd:0}]]){
  test(`standby ${name} blocks relevant catalog and all generation`,async t=>{
    const f=await fixture(t,override),model=await f.post('setup/models'),voice=await f.post('setup/voices',{provider:'minimax'});
    if(name==='no grant'||name==='no plan quota')assert.equal(model.status,400);if(name!=='no plan quota')assert.equal(voice.status,400);
    assert.equal((await f.post('start')).status,400);assert.equal((await f.post('unmute')).status,400);await f.post('observe',view());
    const status=await f.status();assert.equal(status.enabled,false);assert.equal(status.muted,true);const calls=await f.counts();assert.equal(calls.model,0);assert.equal(calls.tts,0);if(name==='no grant')assert.equal(calls.metadata,0);
  });
}
test('exact speech ceiling is checked before either provider generation',async t=>{
  const f=await fixture(t,{maxChars:1});await f.ready();assert.equal((await f.post('start')).status,200);await f.post('observe',view());await until(async()=>Boolean((await f.status()).error));assert.deepEqual(await f.counts(),{metadata:2,model:0,tts:0});
});
test('stop during selection aborts TTS and retains original reservation',async t=>{
  const f=await fixture(t);await f.ready();await writeFile(join(f.dir,'delay-model'),'yes');await f.post('start');await f.post('observe',view());await until(async()=>(await f.counts()).model===1);await f.post('stop');await pause(80);
  const status=await f.status();assert.equal(status.enabled,false);assert.equal(status.muted,true);assert.equal(status.advice,null);assert.equal(status.usage.planRequests,1);assert.deepEqual(await f.counts(),{metadata:2,model:1,tts:0});
});
test('invalidate cancels selection and old views cannot produce audio',async t=>{
  const f=await fixture(t);await f.ready();await writeFile(join(f.dir,'delay-model'),'yes');await f.post('start');await f.post('observe',view());await until(async()=>(await f.counts()).model===1);await f.post('invalidate',{view_seq:2});await f.post('observe',view());await pause(80);
  assert.equal((await f.status()).advice,null);assert.deepEqual(await f.counts(),{metadata:2,model:1,tts:0});
});
test('saved authorization revocation blocks generation without renewal',async t=>{
  const f=await fixture(t);await f.ready();await f.post('start');f.config.grant.approved=false;await write(join(f.dir,'config.json'),f.config);await f.post('observe',view());await until(async()=>Boolean((await f.status()).error));
  assert.deepEqual(await f.counts(),{metadata:2,model:0,tts:0});assert.equal((await read(join(f.dir,'config.json'))).grant.approved,false);
});
test('persisted plan balance consumed by another caller blocks generation without reset',async t=>{
  const f=await fixture(t);await f.ready();await f.post('start');const budget=new BudgetLedger({filePath:join(f.dir,'usage.json'),grant});for(let i=0;i<4;i++)budget.reserve({provider:'openai-plan',kind:'plan'});
  await f.post('observe',view());await until(async()=>Boolean((await f.status()).error));assert.deepEqual(await f.counts(),{metadata:2,model:0,tts:0});assert.equal((await f.status()).usage.planRequests,4);
});
test('revocation during model await prevents the following TTS request',async t=>{
  const f=await fixture(t);await f.ready();await writeFile(join(f.dir,'delay-model'),'yes');await f.post('start');await f.post('observe',view());await until(async()=>(await f.counts()).model===1);
  f.config.grant.approved=false;await write(join(f.dir,'config.json'),f.config);await until(async()=>Boolean((await f.status()).error));
  assert.deepEqual(await f.counts(),{metadata:2,model:1,tts:0});assert.equal((await f.status()).advice,null);
});
test('revocation during provider voice-catalog await prevents the actual TTS reservation and request',async t=>{
  const f=await fixture(t);assert.equal((await f.post('setup/models')).status,200);await writeFile(join(f.dir,'delay-voice'),'yes');await f.post('start');await f.post('observe',view());await until(async()=>(await f.counts()).metadata===2);
  f.config.grant.approved=false;await write(join(f.dir,'config.json'),f.config);await until(async()=>Boolean((await f.status()).error));
  assert.deepEqual(await f.counts(),{metadata:2,model:1,tts:0});assert.equal((await f.status()).usage.ttsRequests,0);assert.equal((await f.status()).usage.planRequests,1);
});
test('revocation during original token await prevents model reservation and request',async t=>{
  const f=await fixture(t);await f.ready();await writeFile(join(f.dir,'token-start'),'');await writeFile(join(f.dir,'delay-token'),'yes');await f.post('start');await f.post('observe',view());await until(async()=>(await readFile(join(f.dir,'token-start'),'utf8'))==='entered');
  f.config.grant.approved=false;await write(join(f.dir,'config.json'),f.config);await until(async()=>Boolean((await f.status()).error));
  assert.deepEqual(await f.counts(),{metadata:2,model:0,tts:0});assert.equal((await f.status()).usage.planRequests,0);
});
test('the last approved model request still permits its separately approved speech',async t=>{
  const f=await fixture(t,{maxPlanRequests:1});await f.ready();await f.post('start');await f.post('observe',view());await until(async()=>(await f.status()).status==='ready');
  assert.deepEqual(await f.counts(),{metadata:2,model:1,tts:1});assert.equal((await f.status()).usage.planRequests,1);
});
const paidGrant={approved:true,provider:'deepseek',model:'deepseek-flash',metadata:true,inference:true,maxRequests:2,maxUsd:0.01,maxInputBytes:65536,maxOutputTokens:256,expiresAt:'2099-01-01T00:00:00Z'};
const paidConfig=changes=>({model_provider:'deepseek',model_id:'deepseek-flash',deepseek_grant:{...paidGrant,...changes}});
test('DeepSeek retains a separate cash grant and reaches the original adapter only after explicit actions',async t=>{
  const f=await fixture(t,{},paidConfig());assert.deepEqual(await f.counts(),{metadata:0,model:0,tts:0});await f.ready();await f.post('start');await f.post('observe',view());await until(async()=>(await f.status()).status==='ready');
  const status=await f.status();assert.equal(status.model_usage.requests,1);assert.equal(status.usage.planRequests,0);assert.equal(status.usage.ttsRequests,1);assert.deepEqual(await f.counts(),{metadata:2,model:1,tts:1});
});
for(const[name,changes,catalogStatus]of[['metadata-only',{inference:false},200],['absent grant',{approved:false},400],['expired grant',{expiresAt:'2000-01-01T00:00:00Z'},400],['insufficient cash',{maxUsd:0.000001},400]]){
  test(`DeepSeek ${name} cannot be upgraded by UI clicks`,async t=>{
    const f=await fixture(t,{},paidConfig(changes));assert.equal((await f.post('setup/models')).status,catalogStatus);assert.equal((await f.post('start')).status,400);assert.equal((await f.post('unmute')).status,400);await f.post('observe',view());
    const counts=await f.counts();assert.equal(counts.model,0);assert.equal(counts.tts,0);assert.deepEqual((await read(join(f.dir,'config.json'))).deepseek_grant,{...paidGrant,...changes});assert.equal((await f.status()).enabled,false);
  });
}
test('standby rejects live and offline combinations before accessing configuration',async()=>{
  const {main}=await import('../bin/mtga-live-coach.mjs');
  for(const flags of [['--offline'],['--mode','live']])await assert.rejects(main(['serve','--enable','--standby','--config-dir','/synthetic-nonexistent',...flags]),/only for replay serve/);
});
test('launcher cold starts actual CLI in synthetic config, repeats same PID, exits gracefully and reopens new PID',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'replay2-standby-lifecycle-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await write(join(dir,'config.json'),{grant,model_provider:'siwc',model_id:'synthetic-sol',minimax_voice_id:'synthetic-stock',siwc_plan_only_confirmed:true});
  await write(join(dir,'credentials.json'),{minimax_api_key:'synthetic-not-a-key'});await writeFile(join(dir,'delay-model'),'');
  const free=createServer();await new Promise(done=>free.listen(0,'127.0.0.1',done));const port=free.address().port;await new Promise(done=>free.close(done));
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./helpers/standby-launcher-driver.mjs',import.meta.url))],{env:{...cleanEnv(),REPLAY2_STANDBY_FIXTURE_DIR:dir,REPLAY2_STANDBY_FIXTURE_PORT:String(port)},timeout:10000});
  const facts=await read(join(dir,'launcher-facts.json'));
  assert.equal(facts.first.reused,false);assert.ok(facts.repeated.every(row=>row.pid===facts.first.pid));assert.equal(facts.stopped.stopped,true);assert.equal(facts.afterStop.running,false);assert.notEqual(facts.reopened.pid,facts.first.pid);assert.equal(facts.final.running,false);
  assert.deepEqual(facts.cold,{enabled:false,muted:true,offline:false,counts:{metadata:0,model:0,tts:0},externalAttempts:0});assert.deepEqual(facts.exit.counts,{metadata:0,model:0,tts:0});assert.equal(facts.exit.externalAttempts,0);
});
