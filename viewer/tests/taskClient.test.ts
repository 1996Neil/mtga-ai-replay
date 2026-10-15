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
 const request=(async(_url,options)=>{if(options?.method==='POST'){posts++;throw new Error('Reply lost');}return new Response(JSON.stringify(posts ? {id:'new',status:'succeeded'} : {id:null,status:'idle'}));}) as typeof fetch;
 assert.equal((await createTaskClient('/api/sync','sync',request,async()=>{}).run(()=>{})).id,'new');assert.equal(posts,1);
});
test('lost POST must not mistake an older result for successful new task',async()=>{
 const request=(async(_url,options)=>{if(options?.method==='POST')throw new Error('Lost');return new Response(JSON.stringify({id:'old',status:'succeeded'}));}) as typeof fetch;
 const client=createTaskClient('/api/sync','sync',request,async()=>{});await client.resume(()=>{});await assert.rejects(client.run(()=>{}),/不能确认新任务/);
});
test('completion waits for notification receipt; collection retry invokes only fixed sync route',async()=>{
 let reads=0;const urls:string[]=[];
 const request=(async(url,options)=>{urls.push(String(url));if(options?.method==='POST')assert.deepEqual(options.headers,{'X-MTGA-Replay-Action':'collection-sync'});return new Response(JSON.stringify({id:'job',status:'succeeded',notification_pending:++reads===2,notification:{attempted:true,accepted:true}}));}) as typeof fetch;
 const job=await createTaskClient('/api/collection','collection-update',request,async()=>{}).run(()=>{},undefined,undefined,true);
 assert.deepEqual(urls,['/api/collection','/api/collection/sync','/api/collection']);assert.equal(job.notification?.accepted,true);
});

test('POST headers followed by a truncated body reconcile the accepted task without reposting', async () => {
 let posts=0;const methods:string[]=[];
 const request=(async(_url,options)=>{
  methods.push(options?.method??'GET');
  if(options?.method==='POST'){posts++;return new Response('{"id":');}
  return new Response(JSON.stringify(posts ? {id:'accepted',status:'succeeded'} : {id:'old',status:'succeeded'}));
 }) as typeof fetch;
 const job=await createTaskClient('/api/sync','sync',request,async()=>{}).run(()=>{});
 assert.equal(job.id,'accepted');assert.equal(posts,1);assert.deepEqual(methods,['GET','POST','GET']);
});

test('a client with no prior observation rejects an unchanged old result after a lost POST', async () => {
 let posts=0;
 const request=(async(_url,options)=>{if(options?.method==='POST'){posts++;throw new Error('Never delivered');}return new Response(JSON.stringify({id:'old',status:'succeeded'}));}) as typeof fetch;
 await assert.rejects(createTaskClient('/api/sync','sync',request,async()=>{}).run(()=>{}),/不能确认新任务/);
 assert.equal(posts,1);
});

test('a fresh preflight prevents another window’s old completion from becoming this request’s success', async () => {
 let id='old-a',posts=0;const observed:string[]=[];
 const request=(async(_url,options)=>{if(options?.method==='POST'){posts++;throw new Error('Never delivered');}return new Response(JSON.stringify({id,status:'succeeded'}));}) as typeof fetch;
 const client=createTaskClient('/api/sync','sync',request,async()=>{});
 await client.resume(job=>observed.push(job.id!));id='old-b';
 await assert.rejects(client.run(job=>observed.push(job.id!)),/不能确认新任务/);
 assert.equal(posts,1);assert.deepEqual(observed,['old-a']);
});

test('preflight resumes a current running task with GET only', async () => {
 const methods:string[]=[];let reads=0;
 const request=(async(_url,options)=>{methods.push(options?.method??'GET');return new Response(JSON.stringify({id:'existing',status:++reads===1?'running':'succeeded'}));}) as typeof fetch;
 const job=await createTaskClient('/api/sync','sync',request,async()=>{}).run(()=>{});
 assert.equal(job.id,'existing');assert.deepEqual(methods,['GET','GET']);
});

test('preflight reconnects before sending a mutation; an aborted preflight sends none', async () => {
 let calls=0,posts=0;const connection:boolean[]=[];
 const request=(async(_url,options)=>{
  if(++calls===1)throw new Error('Disconnected');
  if(options?.method==='POST')posts++;
  return new Response(JSON.stringify(posts ? {id:'new',status:'succeeded'} : {id:null,status:'idle'}));
 }) as typeof fetch;
 await createTaskClient('/api/sync','sync',request,async()=>{}).run(()=>{},undefined,lost=>connection.push(lost));
 assert.equal(posts,1);assert.deepEqual(connection,[true,false]);
 const abort=new AbortController();abort.abort();
 await assert.rejects(createTaskClient('/api/sync','sync',request,async()=>{}).run(()=>{},abort.signal),{name:'AbortError'});
 assert.equal(posts,1);assert.equal(calls,3);
});

test('a newly attached observer never inherits an aborted observer’s pending Promise', async () => {
 let reads=0,release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
 const firstAbort=new AbortController();const observations:string[]=[];
 const request=(async()=>{if(++reads===1)await hold;return new Response(JSON.stringify({id:'retained',status:'succeeded'}));}) as typeof fetch;
 const client=createTaskClient('/api/sync','sync',request,async()=>{});
 const first=client.resume(()=>assert.fail('Aborted observer was updated'),firstAbort.signal);
 const rejected=assert.rejects(first,{name:'AbortError'});firstAbort.abort();
 const next=client.resume(job=>observations.push(job.id!));
 assert.notEqual(next,first);release();await rejected;
 assert.equal((await next).id,'retained');assert.deepEqual(observations,['retained']);assert.equal(reads,2);
});

test('an authoritative 409 is shown once without mutation retries', async () => {
 const methods:string[]=[];
 const request=(async(_url,options)=>{methods.push(options?.method??'GET');return options?.method==='POST' ? new Response('',{status:409}) : new Response(JSON.stringify({id:null,status:'idle'}));}) as typeof fetch;
 await assert.rejects(createTaskClient('/api/sync','sync',request,async()=>{}).run(()=>{}),/另一个数据任务正在运行/);
 assert.deepEqual(methods,['GET','POST']);
});

test('two reopened observers see interrupted task and neither repeats POST',async()=>{
 const methods:string[]=[];const request=(async(_url,options)=>{methods.push(options?.method??'GET');return new Response(JSON.stringify({id:'interrupted',status:'needs_recovery',error:'人工核对'}));})as typeof fetch;
 const clients=[createTaskClient('/api/sync','sync',request,async()=>{}),createTaskClient('/api/sync','sync',request,async()=>{})];
 for(const client of clients){assert.equal((await client.resume(()=>{})).status,'needs_recovery');await assert.rejects(client.run(()=>{}),/人工核对/);}assert.deepEqual(methods,['GET','GET','GET','GET']);
});
test('explicit reconciliation invokes only the protected read-only reconcile route, never the upload route',async()=>{
 const seen:string[]=[];const request=(async(url,options)=>{seen.push(String(url));assert.equal(options?.method,'POST');assert.deepEqual(options?.headers,{'X-MTGA-Replay-Action':'sync-reconcile'});return new Response(JSON.stringify({id:'retained',status:'succeeded'}));})as typeof fetch;
 assert.equal((await createTaskClient('/api/sync','sync',request,async()=>{}).reconcile(()=>{})).status,'succeeded');assert.deepEqual(seen,['/api/sync/reconcile']);
});
