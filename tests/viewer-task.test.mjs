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
