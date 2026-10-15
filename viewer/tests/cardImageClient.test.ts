import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardImageClient } from '../src/lib/cardImageClient.ts';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('hidden ID never requests; failures retry finitely and manual retry recovers',async()=>{
 let time=0,calls=0,good=false;let timer:(()=>void)|undefined;
 const client=createCardImageClient({now:()=>time,fetcher:async()=>{calls++;if(!good)throw Error('offline');return Response.json({image_available:true});},schedule:((fn:()=>void)=>{timer=fn;return 1;}) as typeof setTimeout,cancel:(()=>{timer=undefined;}) as typeof clearTimeout});
 client.subscribe(0,()=>{});assert.equal(calls,0);const stop=client.subscribe(100,()=>{});await tick();
 for(let i=0;i<3;i++){time+=60000;const fn=timer;timer=undefined;fn?.();await tick();}
 assert.equal(calls,3);assert.equal(client.snapshot(100).phase,'failed');good=true;client.retry(100);await tick();assert.equal(client.snapshot(100).phase,'ready');stop();
});
test('unsubscribed stale response cannot update card state',async()=>{
 let resolveResponse!:(r:Response)=>void;let writes=0;
 const client=createCardImageClient({fetcher:()=>new Promise<Response>(resolve=>{resolveResponse=resolve;}),onCard:()=>{writes++;}});
 const stop=client.subscribe(100,()=>{});stop();resolveResponse(Response.json({image_available:true}));await tick();assert.equal(writes,0);
});
