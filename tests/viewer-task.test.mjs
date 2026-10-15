import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerTask } from '../src/viewer-task.mjs';
import { createViewerCollection } from '../src/viewer-collection.mjs';
import { notifyViewerTask } from '../src/task-notification.mjs';
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return {promise,release}; };
test('server task survives observer departure, retains result and notifies once', async () => {
 const hold=gate(); let calls=0,notifications=0;
 const task=createViewerTask({kind:'replay',errorMessage:()=> 'Fixed error',workflow:async()=>{calls++;await hold.promise;return {status:'succeeded',published:2};},notify:async()=>{notifications++;return {attempted:true,accepted:true};}});
 const first=task.start();assert.equal(task.start().id,first.id); await Promise.resolve();assert.equal(calls,1);
 hold.release();await task.wait();assert.equal(task.snapshot().status,'succeeded');assert.equal(task.snapshot().result.published,2);assert.equal(notifications,1);assert.equal(task.snapshot().notification_pending,false);
});
test('late notification cannot overwrite a newer job', async () => {
 const hold=gate();let calls=0;
 const task=createViewerTask({kind:'replay',errorMessage:()=> 'Fixed',workflow:async()=>({status:'succeeded'}),notify:async()=>{if(++calls===1)await hold.promise;return {attempted:true,accepted:true};}});
 task.start();const previousWait=task.wait();for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(task.snapshot().status,'succeeded');const next=task.start();hold.release();await previousWait;await task.wait();assert.equal(task.snapshot().id,next.id);assert.equal(task.snapshot().status,'succeeded');
});
test('collection partial preserves local success; retry publishes snapshot without another read', async () => {
 let reads=0,uploads=0;
 const task=createViewerCollection({dataDir:'/tmp/synthetic',update:async options=>{assert.equal(options.readerOptions.interactive,false);reads++;return {local_updated:true,synced:false,sync_error:'Fixed upload error',summary:{card_kinds:2,total_quantity:8},inventory:{}};},sync:async()=>{if (++uploads===1) throw new Error('private stderr');return {local_updated:false,synced:true,summary:{card_kinds:2,total_quantity:8}};}});
 task.start('update');await task.wait();assert.equal(task.snapshot().status,'partial');assert.equal(task.snapshot().result.local_updated,true);
 task.start('sync');await task.wait();assert.equal(task.snapshot().status,'partial');assert.equal(task.snapshot().result.summary.total_quantity,8);assert.doesNotMatch(JSON.stringify(task.snapshot()),/private stderr/);
 task.start('sync');await task.wait();assert.equal(task.snapshot().status,'succeeded');assert.equal(reads,1);assert.equal(uploads,2);
});
test('notification uses fixed argv with counts only and bounded execution; errors stay redacted', async () => {
 let command,args,options;
 assert.deepEqual(await notifyViewerTask('replay',{status:'succeeded',result:{published:2,updated:1,match_id:'private-id',secret:'ghp_private'}},{platform:'darwin',run:async(...v)=>{[command,args,options]=v;}}),{attempted:true,accepted:true});
 assert.equal(command,'/usr/bin/osascript');assert.equal(options.timeout,3000);assert.doesNotMatch(JSON.stringify(args),/private-id|ghp_private/);assert.match(args.at(-1),/新增 2 场，更新 1 场/);
 assert.deepEqual(await notifyViewerTask('collection',{status:'failed'},{platform:'darwin',run:async()=>{throw new Error('secret stderr');}}),{attempted:true,accepted:false});
});

test('terminal state and notification are committed together before a new job can start', async () => {
 const firstHold=gate(),secondHold=gate();let calls=0;const notifications=[];
 const task=createViewerTask({kind:'replay',errorMessage:()=> 'Fixed',workflow:async()=>{
  if(++calls===1)await firstHold.promise;else await secondHold.promise;return {status:'succeeded'};
 },notify:async(_kind,job)=>{notifications.push({id:job.id,status:job.status});return {attempted:true,accepted:true};}});
 const first=task.start(),firstDone=task.wait();await Promise.resolve();firstHold.release();
 while(task.snapshot().status==='running')await Promise.resolve();
 const second=task.start();await firstDone;const snapshot={...task.snapshot()};
 secondHold.release();await task.wait();
 assert.equal(snapshot.status,'running');assert.equal(snapshot.finished_at,undefined);assert.equal(snapshot.notification_pending,undefined);
 assert.deepEqual(notifications,[{id:first.id,status:'succeeded'},{id:second.id,status:'succeeded'}]);
});

test('late progress from a finished workflow cannot mutate the next running job', async () => {
 const hold=gate();let oldProgress,calls=0;
 const task=createViewerTask({kind:'replay',errorMessage:()=> 'Fixed',workflow:async({onProgress})=>{
  if(++calls===1)oldProgress=onProgress;else await hold.promise;return {status:'succeeded'};
 }});
 task.start();await task.wait();task.start();await Promise.resolve();
 oldProgress({phase:'security',completed:999});const snapshot={...task.snapshot()};
 hold.release();await task.wait();assert.deepEqual(snapshot.progress,{phase:'scanning'});
});

test('notification rejection preserves a completed publication and is attempted only once', async () => {
 let calls=0;
 const task=createViewerTask({kind:'replay',errorMessage:()=> 'Fixed',workflow:async()=>({status:'succeeded',published:3}),notify:async()=>{calls++;throw new Error('private stderr');}});
 task.start();await task.wait();
 for(let i=0;i<5;i++){const snapshot=task.snapshot();assert.equal(snapshot.status,'succeeded');assert.equal(snapshot.result.published,3);assert.equal(snapshot.notification_pending,false);}
 assert.deepEqual(task.snapshot().notification,{attempted:true,accepted:false});assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(task.snapshot()),/private stderr/);
});

test('closing an observer leaves the server workflow running; a new page reads the retained result', async () => {
 const {createTaskClient}=await import('../viewer/src/lib/taskClient.ts');
 const hold=gate();let calls=0,posts=0;
 const task=createViewerTask({kind:'replay',errorMessage:()=> 'Fixed',workflow:async()=>{calls++;await hold.promise;return {status:'succeeded',published:2};}});
 const request=async(_url,options)=>{
  if(options?.method==='POST'){posts++;return new Response(JSON.stringify(task.start()));}
  return new Response(JSON.stringify(task.snapshot()));
 };
 const abort=new AbortController();const first=createTaskClient('/api/sync','sync',request,async()=>{});
 await assert.rejects(first.run(()=>abort.abort(),abort.signal),{name:'AbortError'});
 assert.equal(task.snapshot().status,'running');assert.equal(calls,1);const id=task.snapshot().id;
 const second=createTaskClient('/api/sync','sync',request,async()=>{});
 const restored=await second.resume(job=>{assert.equal(job.id,id);if(job.status==='running')hold.release();});
 assert.equal(restored.status,'succeeded');assert.equal(restored.result.published,2);assert.equal(posts,1);assert.equal(calls,1);
 const third=await createTaskClient('/api/sync','sync',request,async()=>{}).resume(()=>{});
 assert.equal(third.id,id);assert.equal(third.status,'succeeded');assert.equal(posts,1);
});
