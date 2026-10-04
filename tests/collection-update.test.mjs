import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { updateCollection,syncCollection,collectionStatus,collectionErrorMessage,recoverCollectionOperationLock } from '../src/collection-update.mjs';
import { CollectionReadError } from '../src/collection-reader.mjs';

function probe(qty=2){const cards=[{grpId:900001,qty}],inventory={gold:100,gems:0,wildcards:{common:1,uncommon:2,rare:3,mythic:4}};return {schema:'MTGA_COLLECTION_PROBE_V1',read_at:'2026-10-02T13:01:06.960Z',source:'mtga-reader@0.1.13/readCollection+readInventory',stable_reads:2,cards,inventory,content_hash:createHash('sha256').update(JSON.stringify({cards,inventory})).digest('hex')};}
async function fixture(t){const dataDir=await mkdtemp(join(tmpdir(),'mtga-update-test-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));return {dataDir,cardDb:null,displayNamesZh:new Map(),noSync:true,readProbe:async()=>probe()};}
async function syncedState(options,summary,{pending=false,error=null,at=new Date().toISOString()}={}){await mkdir(join(options.dataDir,'collection-sync'),{recursive:true});await writeFile(join(options.dataDir,'collection-sync','state.json'),JSON.stringify({schema:'MTGA_COLLECTION_SYNC_V1',repository:'example-user/mtga-replay-data',pending,last_synced:{at,commit:'a'.repeat(40),content_hash:summary.content_hash,verified:true},last_error:error,...(pending?{pending_content_hash:summary.content_hash}:{})}));}

test('failed real-reader outcomes retain prior successful snapshot and identify latest failed check',async t=>{
 const options=await fixture(t),first=await updateCollection(options);
 for(const code of ['ARENA_NOT_RUNNING','ARENA_HOME_REQUIRED','READ_PERMISSION_REQUIRED','INVENTORY_UNKNOWN','READ_UNSTABLE']){
   await assert.rejects(updateCollection({...options,readProbe:async()=>{throw new CollectionReadError(code);}}),{code});
   const status=await collectionStatus(options);assert.equal(status.summary.content_hash,first.summary.content_hash);assert.equal(status.last_check.ok,false);assert.equal(status.last_check.code,code);assert.equal(status.current_snapshot_published,false);
 }
});
test('partial full reads report collection decrease without overwriting the saved quantities',async t=>{
 const options=await fixture(t);await updateCollection(options);
 await assert.rejects(updateCollection({...options,readProbe:async()=>probe(1)}),{code:'COLLECTION_DECREASE'});
 const status=await collectionStatus(options);assert.equal(status.summary.total_quantity,2);assert.match(status.last_check.message,/减少/);assert.match(collectionErrorMessage({code:'COLLECTION_LARGE_CHANGE'}),/大幅增加/);
});
test('upload failure leaves the local update usable; sync never invokes the reader',async t=>{
 const options=await fixture(t),result=await updateCollection({...options,noSync:false});
 assert.equal(result.local_updated,true);assert.equal(result.synced,false);
 assert.equal((await collectionStatus(options)).summary.total_quantity,2);
 let calls=0;await assert.rejects(syncCollection({...options,readProbe:()=>{calls++;throw new Error();}}),{code:'COLLECTION_SYNC_REPOSITORY'});assert.equal(calls,0);
});
test('published status requires verified same content, no pending failure, and current verification time',async t=>{
 const options=await fixture(t),first=await updateCollection(options);await syncedState(options,first.summary);
 assert.equal((await collectionStatus(options)).current_snapshot_published,true);
 await syncedState(options,first.summary,{pending:true});assert.equal((await collectionStatus(options)).current_snapshot_published,false);
 await syncedState(options,first.summary,{error:{code:'COLLECTION_SYNC_FAILED',message:'Upload failed.',at:new Date().toISOString()}});assert.equal((await collectionStatus(options)).current_snapshot_published,false);
 await syncedState(options,first.summary,{at:'2026-01-01T00:00:00.000Z'});assert.equal((await collectionStatus(options)).current_snapshot_published,false);
});
test('concurrent update cannot start another read; explicit lock recovery rejects live and permits dead process',async t=>{
 const options=await fixture(t);let release,start;const entered=new Promise(r=>start=r),gate=new Promise(r=>release=r);
 const first=updateCollection({...options,readProbe:async()=>{start();await gate;return probe();}});await entered;
 let reads=0;await assert.rejects(updateCollection({...options,readProbe:()=>{reads++;return probe();}}),{code:'COLLECTION_BUSY'});assert.equal(reads,0);await assert.rejects(recoverCollectionOperationLock(options),{code:'COLLECTION_BUSY'});
 release();await first;
 const path=join(options.dataDir,'collection','operation.lock');await writeFile(path,'2147483647');await writeFile(join(options.dataDir,'collection','save.lock'),'2147483647');assert.equal((await collectionStatus(options)).operation_lock.alive,false);assert.equal(await recoverCollectionOperationLock(options),true);assert.equal(await recoverCollectionOperationLock(options),false);await updateCollection(options);
});
test('status refuses non-whitelisted diagnostics and does not expose persisted secrets',async t=>{
 const options=await fixture(t);await updateCollection(options);await writeFile(join(options.dataDir,'collection','update-state.json'),JSON.stringify({schema:'MTGA_COLLECTION_UPDATE_STATE_V1',last_check:null,unexpected:'extra'}));await assert.rejects(collectionStatus(options),{code:'COLLECTION_LOCAL_INVALID'});
});
