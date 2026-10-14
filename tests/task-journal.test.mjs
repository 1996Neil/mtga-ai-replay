import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,symlink,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createTaskJournal} from '../src/task-journal.mjs';import {createViewerTask} from '../src/viewer-task.mjs';
async function root(t){const dir=await mkdtemp(join(tmpdir(),'task-journal-synthetic-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('restart retains interrupted identity/checkpoint without repeated workflow or inferred success',async t=>{
 const dir=await root(t);let journal=createTaskJournal(dir),calls=0;
 journal.save('replay',{id:'11111111-1111-4111-8111-111111111111',status:'running',progress:{phase:'uploading'},checkpoint:{commit:'a'.repeat(40)},privatePayload:'synthetic private'});journal.close();journal=createTaskJournal(dir);
 const task=createViewerTask({kind:'replay',journal,errorMessage:()=> 'Fixed',workflow:async()=>{calls++;return {status:'succeeded'};}});
 assert.equal(task.snapshot().status,'needs_recovery');assert.equal(task.snapshot().id,'11111111-1111-4111-8111-111111111111');assert.equal(task.snapshot().checkpoint.commit,'a'.repeat(40));task.start();await task.wait();assert.equal(calls,0);journal.close();assert.doesNotMatch((await readFile(join(dir,'tasks/journal.sqlite3'))).toString(),/privatePayload|synthetic private/);
});
test('journal failure before acceptance does not execute or notify a workflow',async()=>{
 let calls=0;const task=createViewerTask({kind:'replay',journal:{load:()=>null,save:()=>{throw Error('synthetic disk failure');}},workflow:()=>{calls++;},errorMessage:()=> 'Fixed'});assert.equal(task.start().status,'failed');await task.wait();assert.equal(calls,0);
});
test('completed status survives restart but private results do not enter journal',async t=>{
 const dir=await root(t);let journal=createTaskJournal(dir);const task=createViewerTask({kind:'collection',journal,errorMessage:()=> 'Fixed',workflow:async()=>({status:'succeeded',inventory:{gold:1},secret:'synthetic private'})});task.start();await task.wait();journal.close();journal=createTaskJournal(dir);const saved=journal.load('collection');assert.equal(saved.status,'succeeded');assert.equal(saved.result.secret,undefined);assert.equal(saved.result.inventory,undefined);journal.close();
});
test('journal rejects a symlink database without changing the outside file',async t=>{
 const dir=await root(t);const journal=createTaskJournal(dir);journal.close();await rm(join(dir,'tasks/journal.sqlite3'));const outside=join(dir,'outside');await writeFile(outside,'keep');await symlink(outside,join(dir,'tasks/journal.sqlite3'));assert.throws(()=>createTaskJournal(dir),/Unsafe/);assert.equal(await readFile(outside,'utf8'),'keep');
});
test('explicit reconciliation can confirm a durable commit without repeating mutation; uncertain reconciliation stays blocked',async t=>{
 const dir=await root(t);const journal=createTaskJournal(dir);t.after(()=>journal.close());let runs=0,checks=0;
 for(const verified of [false,true]){
  journal.save('replay',{id:'22222222-2222-4222-8222-222222222222',status:'needs_recovery',progress:{phase:'uploading'},checkpoint:{commit:'b'.repeat(40)}});
  const task=createViewerTask({kind:'replay',journal,errorMessage:()=> 'Fixed',workflow:()=>{runs++;},reconcile:async job=>{checks++;assert.equal(job.checkpoint.commit,'b'.repeat(40));if(!verified)throw Error('synthetic uncertain');return {status:'succeeded',reconciled:true};}});
  task.reconcile();task.reconcile();await task.wait();assert.equal(task.snapshot().status,verified?'succeeded':'needs_recovery');
 }assert.equal(runs,0);assert.equal(checks,2);
});

test('failed persistence before reconciliation keeps interrupted state and executes nothing',async()=>{
 let checks=0;const task=createViewerTask({kind:'replay',journal:{load:()=>({id:'synthetic',status:'needs_recovery'}),save:()=>{throw Error('synthetic disk fault');}},reconcile:()=>{checks++;},workflow:()=>{},errorMessage:()=> 'Fixed'});
 assert.equal(task.reconcile().status,'needs_recovery');assert.equal(task.reconcile().status,'needs_recovery');await task.wait();assert.equal(checks,0);
});
test('a process killed after SQLite WAL commit resumes as interrupted with the durable checkpoint',async t=>{
 const dir=await root(t),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const moduleUrl=new URL('../src/task-journal.mjs',import.meta.url).href;
 const code=`import {createTaskJournal} from ${JSON.stringify(moduleUrl)}; const journal=createTaskJournal(${JSON.stringify(dir)});journal.save('replay',{id:'33333333-3333-4333-8333-333333333333',status:'running',progress:{phase:'uploading'},checkpoint:{commit:'c'.repeat(40)}});process.kill(process.pid,'SIGKILL');`;
 await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',code]),error=>error.signal==='SIGKILL');
 const journal=createTaskJournal(dir);t.after(()=>journal.close());const job=journal.load('replay');assert.equal(job.status,'needs_recovery');assert.equal(job.checkpoint.commit,'c'.repeat(40));
});
test('default replay reconciliation rejects mismatched destination and commit before claiming success',async t=>{
 const {createViewerSync}=await import('../src/viewer-sync.mjs');const dir=await root(t),journal=createTaskJournal(dir);t.after(()=>journal.close());let checks=0;
 for(const mismatch of ['destination','commit',null]){
  journal.save('replay',{id:'44444444-4444-4444-8444-444444444444',status:'needs_recovery',checkpoint:{commit:'d'.repeat(40),destination_hash:'e'.repeat(64)}});
  const task=createViewerSync({dataDir:dir,journal,workflow:()=>{throw Error('Mutation forbidden');},getPublished:async options=>{assert.equal(options.refresh,true);checks++;return {source:'remote',commit:(mismatch==='commit'?'f':'d').repeat(40),destination_hash:(mismatch==='destination'?'f':'e').repeat(64),index:{matches:[]}};}});
  task.reconcile();await task.wait();assert.equal(task.snapshot().status,mismatch?'needs_recovery':'succeeded');
 }assert.equal(checks,3);
});
