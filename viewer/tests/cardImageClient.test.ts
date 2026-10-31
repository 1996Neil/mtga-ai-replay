import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardImageClient } from '../src/lib/cardImageClient.ts';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('hidden ID never requests; failures retry finitely and manual retry recovers',async()=>{
 let time=0,calls=0,good=false;let timer:(()=>void)|undefined;
 const client=createCardImageClient({now:()=>time,fetcher:async()=>{calls++;if(!good)throw Error('offline');return Response.json({image_available:true});},schedule:((fn:()=>void)=>{timer=fn;return 1;}) as typeof setTimeout,cancel:(()=>{timer=undefined;}) as typeof clearTimeout});
 client.subscribe(0,()=>{});assert.equal(calls,0);const stop=client.subscribe(100,()=>{});await tick();
 for(let i=0;i<4;i++){time+=60000;const fn=timer;timer=undefined;fn?.();await tick();}
 assert.equal(calls,4);assert.equal(client.snapshot(100).phase,'failed');good=true;client.retry(100);await tick();assert.equal(client.snapshot(100).phase,'ready');stop();
});
test('unsubscribed stale response cannot update card state',async()=>{
 let resolveResponse!:(r:Response)=>void;let writes=0;
 const client=createCardImageClient({fetcher:()=>new Promise<Response>(resolve=>{resolveResponse=resolve;}),onCard:()=>{writes++;}});
 const stop=client.subscribe(100,()=>{});stop();resolveResponse(Response.json({image_available:true}));await tick();assert.equal(writes,0);
});
test('transient metadata failure retries after 1.5 seconds instead of a minute', async () => {
 let time=0,calls=0,timer:(()=>void)|undefined,delay=0;
 const client=createCardImageClient({now:()=>time,fetcher:async()=>{
  if(++calls===1)throw Error('temporary disconnect');
  return Response.json({image_available:true});
 },schedule:((fn:()=>void,ms:number)=>{timer=fn;delay=ms;return 1;})as typeof setTimeout,cancel:(()=>{})as typeof clearTimeout});
 const stop=client.subscribe(100,()=>{});await tick();
 assert.equal(delay,1500);assert.equal(client.snapshot(100).phase,'waiting');
 time+=delay;timer?.();await tick();
 assert.equal(client.snapshot(100).phase,'ready');assert.equal(calls,2);stop();
});
test('image errors honor a short server deadline, recover, and keep retry attempts bounded', async () => {
 let time=10000,serverDeadline=0,timer:(()=>void)|undefined,delay=0;
 const client=createCardImageClient({now:()=>time,fetcher:async()=>Response.json({
  image_available:true,image_cached:true,image_retry_after:serverDeadline
 }),schedule:((fn:()=>void,ms:number)=>{timer=fn;delay=ms;return 1;})as typeof setTimeout,cancel:(()=>{})as typeof clearTimeout});
 const stop=client.subscribe(100,()=>{});await tick();
 serverDeadline=time+3000;
 client.imageError(100,client.snapshot(100).attempt);await tick();
 assert.equal(delay,3000);
 time+=delay;serverDeadline=0;timer?.();await tick();
 assert.equal(client.snapshot(100).phase,'ready');
 assert.equal(client.snapshot(100).refreshImage,true);
 client.imageLoaded(100,client.snapshot(100).attempt);
 assert.equal(client.snapshot(100).refreshImage,false);stop();
});
test('a server rate-limit deadline is preserved rather than replaced by fast retry', async () => {
 let time=0,delay=0;
 const client=createCardImageClient({now:()=>time,fetcher:async()=>Response.json({
  image_available:false,retry_after:120000
 }),schedule:((_fn:()=>void,ms:number)=>{delay=ms;return 1;})as typeof setTimeout,cancel:(()=>{})as typeof clearTimeout});
 const stop=client.subscribe(100,()=>{});await tick();assert.equal(delay,120000);stop();
});
test('manual retry runs immediately during an automatic wait and cancels its old timer', async () => {
 let calls=0,cancelled=0,lastUrl='';
 const client=createCardImageClient({fetcher:async url=>{
  lastUrl=String(url);
  if(++calls===1)return Response.json({image_available:false,retry_after:Date.now()+3000,load_error:{kind:'timeout'}});
  return Response.json({image_available:true});
 },schedule:((_fn:()=>void)=>1)as typeof setTimeout,cancel:(()=>{cancelled++;})as typeof clearTimeout});
 const stop=client.subscribe(100,()=>{});await tick();
 assert.equal(client.snapshot(100).phase,'waiting');assert.equal(client.snapshot(100).issue?.kind,'timeout');
 client.retry(100);await tick();
 assert.equal(calls,2);assert.equal(lastUrl,'/api/cards/100?retry=1');assert.equal(client.snapshot(100).phase,'ready');
 assert.equal(client.snapshot(100).refreshImage,true);assert.ok(cancelled>0);stop();
});
test('manual retry replaces a stalled observer and ignores its late reply', async () => {
 let first!:(response:Response)=>void,calls=0,aborted=false;
 const client=createCardImageClient({fetcher:async(_url,options)=>{
  calls++;if(calls===1){options?.signal?.addEventListener('abort',()=>{aborted=true;});return new Promise<Response>(resolve=>{first=resolve;});}
  return Response.json({image_available:true,name:'Fresh'});
 }});
 const stop=client.subscribe(100,()=>{});await tick();
 client.retry(100);await tick();assert.equal(aborted,true);assert.equal(calls,2);
 first(Response.json({image_available:false,name:'Stale'}));await tick();
 assert.equal(client.snapshot(100).card?.name,'Fresh');stop();
});
test('late rate-limit reply from an aborted observer cannot replace a successful manual retry', async () => {
 let first!:(response:Response)=>void,calls=0;
 const client=createCardImageClient({fetcher:async()=>{
  if(++calls===1)return new Promise<Response>(resolve=>{first=resolve;});
  return Response.json({image_available:true,name:'Fresh'});
 }});
 const stop=client.subscribe(100,()=>{});await tick();client.retry(100);await tick();
 first(new Response('',{status:429,headers:{'Retry-After':'120'}}));await tick();
 assert.equal(client.snapshot(100).phase,'ready');assert.equal(client.snapshot(100).issue,undefined);
 assert.equal(client.snapshot(100).retryAt,0);stop();
});
test('repeated successful image events across subscribers leave an already ready snapshot unchanged', async () => {
 let calls=0,notifications=0;
 const client=createCardImageClient({fetcher:async()=>{calls++;return Response.json({image_available:true});}});
 const stops=Array.from({length:40},()=>client.subscribe(100,()=>{notifications++;}));
 await tick();
 const state=client.snapshot(100),before=notifications;
 for(let i=0;i<40;i++)client.imageLoaded(100,state.attempt);
 assert.strictEqual(client.snapshot(100),state);
 assert.equal(notifications,before);assert.equal(calls,1);
 stops.forEach(stop=>stop());
});
