import test from 'node:test';
import assert from 'node:assert/strict';
import workerThreads from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bundle,filesForBundle,reportForSource} from './helpers/cloud-review-fixture.mjs';
import {readPublishedReviewSource} from '../src/review/cloud-review.mjs';
import {createCloudReviewReader} from '../src/review/review-sync.mjs';

async function instrument(t) {
  const Original=workerThreads.Worker,traces=[];let id=0;const control={crash:null};
  class ObservedWorker extends Original {
    constructor(...args){super(...args);this.observerId=++id;traces.push({type:'create',id:this.observerId});this.on('exit',()=>traces.push({type:'exit',id:this.observerId}));}
    postMessage(message,...rest){traces.push({type:'post',id:this.observerId,operation:message.operation});
      if(control.crash===message.operation){control.crash=null;void this.terminate();return;}
      return super.postMessage(message,...rest);}
  }
  workerThreads.Worker=ObservedWorker;syncBuiltinESMExports();
  t.after(()=>{workerThreads.Worker=Original;syncBuiltinESMExports();});
  return {traces,control};
}
async function fixture(t) {
  const dataDir=await mkdtemp(join(tmpdir(),'review-phase-lifecycle-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  let replay;const value=await bundle({richer:true,coachOptions:{multipart:true},onReplay:r=>replay=r});
  const sourceInput={files:filesForBundle(value),matchId:replay.match.id,revision:'a'.repeat(40)};
  const source=readPublishedReviewSource(sourceInput),report=reportForSource(source);
  await mkdir(join(dataDir,'coach-sync'));await writeFile(join(dataDir,'coach-sync/state.json'),JSON.stringify({schema:'MTGA_LOCAL_SYNC_V1',enabled:true,repository:'fixture-owner/private-coaching',pending:[],synced:{[replay.match.id]:{content_hash:value.contentHash}}}));
  const gates={wait:null};
  const reader=createCloudReviewReader({dataDir,loadReplay:async()=>replay,fetchReview:async(id,game,options)=>{
    await gates.wait;
    await options.onVerifiedTarget({repository:'fixture-owner/private-coaching',branch:'main'});
    await options.onVerifiedRevision({repository:'fixture-owner/private-coaching',branch:'main',matchId:id,gameNumber:game,revision:sourceInput.revision});
    await options.computePool.run('validate',{path:'README.md',content:'Synthetic private replay transport.'});
    return {repository:'fixture-owner/private-coaching',branch:'main',sourceInput,report};
  }});t.after(()=>reader.close());return {reader,replay,sourceInput,gates};
}

test('bulk phase workers exit before the next bulk phase, while small reads survive until explicit close',async t=>{
  const {traces}=await instrument(t),h=await fixture(t);
  h.reader.start(h.replay.match.id,1);await h.reader.wait();
  assert.equal((await h.reader.read(h.replay.match.id,1)).status,'ready');
  const history=traces.find(x=>x.operation==='validate'),source=traces.find(x=>x.operation==='cloudReviewSource'),local=traces.find(x=>x.operation==='cloudReviewLocal');
  assert.ok(history&&source&&local);assert.notEqual(history.id,source.id);assert.notEqual(source.id,local.id);
  for(const [before,after] of [[history,source],[source,local]]){
    const exit=traces.findIndex(x=>x.type==='exit'&&x.id===before.id);
    assert.ok(exit>=0&&exit<traces.indexOf(after),'previous heavy heap must terminate before next task transfer');
  }
  assert.ok(traces.some(x=>x.type==='exit'&&x.id===local.id),'local rebuild heap is released before ready');
  assert.ok(h.sourceInput.files.size>0,'worker verification must not consume caller-owned bytes');
  await h.reader.close();
  for(const created of traces.filter(x=>x.type==='create'))assert.ok(traces.some(x=>x.type==='exit'&&x.id===created.id));
});

test('source worker failure is cleaned up and preserves a prior valid cache for offline reading',async t=>{
  const {traces,control}=await instrument(t),h=await fixture(t);
  h.reader.start(h.replay.match.id,1);await h.reader.wait();assert.equal((await h.reader.read(h.replay.match.id,1)).status,'ready');
  control.crash='cloudReviewSource';h.reader.start(h.replay.match.id,1);await h.reader.wait();
  const state=await h.reader.read(h.replay.match.id,1);assert.equal(state.status,'ready');assert.equal(state.offline,true);
  await h.reader.close();
  for(const created of traces.filter(x=>x.type==='create'))assert.ok(traces.some(x=>x.type==='exit'&&x.id===created.id));
});

test('same-game and cross-game starts remain bounded and closing drains an in-flight fetch without allocating later phases',async t=>{
  const {traces}=await instrument(t),h=await fixture(t);let release;
  h.gates.wait=new Promise(done=>release=done);
  assert.equal(h.reader.start(h.replay.match.id,1).code,202);
  assert.equal(h.reader.start(h.replay.match.id,1).code,202);
  assert.equal(h.reader.start(h.replay.match.id,2).code,409);
  const closing=h.reader.close();release();await closing;
  assert.equal(h.reader.start(h.replay.match.id,1).code,503);
  assert.equal(traces.some(x=>x.operation==='cloudReviewSource'||x.operation==='cloudReviewLocal'),false);
  for(const created of traces.filter(x=>x.type==='create'))assert.ok(traces.some(x=>x.type==='exit'&&x.id===created.id));
});
