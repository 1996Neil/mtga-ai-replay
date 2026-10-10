import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskClient } from '../src/lib/taskClient.ts';
test('reopen resumes server job with GET only, reconnects after transient failure',async()=>{
 const methods:string[]=[],connection:boolean[]=[];let calls=0;
 const request=(async(_url,options)=>{methods.push(options?.method??'GET');if(++calls===2)throw new Error('Disconnected');return new Response(JSON.stringify({id:'kept',status:calls<4?'running':'succeeded'}));}) as typeof fetch;
 const job=await createTaskClient('/api/sync','sync',request,async()=>{}).resume(()=>{},undefined,v=>connection.push(v));
 assert.equal(job.id,'kept');assert.equal(job.status,'succeeded');assert.ok(methods.every(v=>v==='GET'));assert.deepEqual(connection,[false,true,false,false]);
});
test('lost POST response reconciles by GET without reposting',async()=>{
 let posts=0;
 const request=(async(_url,options)=>{if(options?.method==='POST'){posts++;throw new Error('Reply lost');}return new Response(JSON.stringify({id:'new',status:'succeeded'}));}) as typeof fetch;
 assert.equal((await createTaskClient('/api/sync','sync',request,async()=>{}).run(()=>{})).id,'new');assert.equal(posts,1);
});
test('lost POST must not mistake an older result for successful new task',async()=>{
 const request=(async(_url,options)=>{if(options?.method==='POST')throw new Error('Lost');return new Response(JSON.stringify({id:'old',status:'succeeded'}));}) as typeof fetch;
 const client=createTaskClient('/api/sync','sync',request,async()=>{});await client.resume(()=>{});await assert.rejects(client.run(()=>{}),/不能确认新任务/);
});
test('completion waits for notification receipt; collection retry invokes only fixed sync route',async()=>{
 let reads=0;const urls:string[]=[];
 const request=(async(url,options)=>{urls.push(String(url));if(options?.method==='POST')assert.deepEqual(options.headers,{'X-MTGA-Replay-Action':'collection-sync'});return new Response(JSON.stringify({id:'job',status:'succeeded',notification_pending:++reads===1,notification:{attempted:true,accepted:true}}));}) as typeof fetch;
 const job=await createTaskClient('/api/collection','collection-update',request,async()=>{}).run(()=>{},undefined,undefined,true);
 assert.deepEqual(urls,['/api/collection/sync','/api/collection']);assert.equal(job.notification?.accepted,true);
});
