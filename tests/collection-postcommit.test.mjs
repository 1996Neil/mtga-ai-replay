import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {updateCollection,recoverCollectionOperationLock} from '../src/collection-update.mjs';
import {loadCollectionSnapshot,saveCollectionSnapshot,buildCollectionSnapshot} from '../src/collection.mjs';
const probe=qty=>{const cards=[{grpId:900001,qty}],inventory={gold:0,gems:0,wildcards:{common:0,uncommon:0,rare:0,mythic:0}};return {schema:'MTGA_COLLECTION_PROBE_V1',read_at:'2026-10-10T00:00:00.000Z',source:'mtga-reader@0.1.13/readCollection+readInventory',stable_reads:2,cards,inventory,content_hash:createHash('sha256').update(JSON.stringify({cards,inventory})).digest('hex')};};
async function fixture(t){const dataDir=await mkdtemp(join(tmpdir(),'collection-correctness-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));return {confirmAccount:true,dataDir,cardDb:null,displayNamesZh:new Map(),noSync:true,readProbe:async()=>probe(2)};}
test('post-commit diagnostics failure reports new saved snapshot and does not touch outside sentinel',async t=>{
 const o=await fixture(t);await updateCollection(o);const target=join(o.dataDir,'collection/update-state.json'),sentinel=join(o.dataDir,'sentinel');await writeFile(sentinel,'keep');await rm(target);await symlink(sentinel,target);
 const result=await updateCollection({...o,readProbe:async()=>probe(3)});assert.equal(result.local_updated,true);assert.equal(result.synced,false);assert.equal(result.diagnostic_error,'COLLECTION_DIAGNOSTIC_FAILED');assert.match(result.sync_error,/已保存/);assert.doesNotMatch(result.sync_error,/上次|保留/);assert.equal((await loadCollectionSnapshot(o)).summary.total_quantity,3);assert.equal(await readFile(sentinel,'utf8'),'keep');
});
test('pre-commit failure keeps old snapshot even if failure diagnostics also cannot be written',async t=>{
 const o=await fixture(t);await updateCollection(o);const target=join(o.dataDir,'collection/update-state.json');await rm(target);await symlink(join(o.dataDir,'uncreated'),target);await assert.rejects(updateCollection({...o,readProbe:async()=>{const e=new Error('synthetic');e.code='READ_UNSTABLE';throw e;}}),{code:'READ_UNSTABLE'});assert.equal((await loadCollectionSnapshot(o)).summary.total_quantity,2);
});
test('recovery gate blocks normal operation and direct save, and two recovery contenders',async t=>{
 const o=await fixture(t),root=join(o.dataDir,'collection');await mkdir(root);await writeFile(join(root,'recovery.lock'),String(process.pid));let reads=0;await assert.rejects(updateCollection({...o,readProbe:()=>{reads++;return probe(3);}}),{code:'COLLECTION_BUSY'});assert.equal(reads,0);await assert.rejects(recoverCollectionOperationLock(o),{code:'COLLECTION_BUSY'});const snapshot=await buildCollectionSnapshot(probe(2),o);await assert.rejects(saveCollectionSnapshot(snapshot,o),{code:'COLLECTION_BUSY'});
});
test('recovery rejects symlink, incomplete and live locks without unlinking',async t=>{
 const o=await fixture(t),root=join(o.dataDir,'collection');await mkdir(root);const lock=join(root,'operation.lock');
 for(const text of ['',String(process.pid)]){await writeFile(lock,text);await assert.rejects(recoverCollectionOperationLock(o),{code:'COLLECTION_BUSY'});assert.equal(await readFile(lock,'utf8'),text);await rm(lock);}
 const sentinel=join(o.dataDir,'outside');await writeFile(sentinel,'2147483647');await symlink(sentinel,lock);await assert.rejects(recoverCollectionOperationLock(o),{code:'COLLECTION_LOCAL_INVALID'});assert.equal((await lstat(lock)).isSymbolicLink(),true);assert.equal(await readFile(sentinel,'utf8'),'2147483647');
});
test('save-lock cleanup failure after current commit keeps accurate local_updated status',async t=>{
 const fs=(await import('node:fs/promises')).default,{syncBuiltinESMExports}=await import('node:module');
 const o=await fixture(t);await updateCollection(o);const original=fs.rm,lock=join(o.dataDir,'collection/save.lock');
 fs.rm=async(path,...args)=>{if(String(path)===lock){const error=new Error('synthetic cleanup fault');error.code='EACCES';throw error;}return original(path,...args);};syncBuiltinESMExports();
 try{const result=await updateCollection({...o,readProbe:async()=>probe(3)});assert.equal(result.local_updated,true);assert.equal(result.diagnostic_error,'COLLECTION_CLEANUP_FAILED');assert.equal((await loadCollectionSnapshot(o)).summary.total_quantity,3);}
 finally{fs.rm=original;syncBuiltinESMExports();}
});
test('no trustworthy identity means explicit account confirmation is required before any reader executes',async t=>{
 const o=await fixture(t);let reads=0;await assert.rejects(updateCollection({...o,confirmAccount:false,readProbe:()=>{reads++;return probe(2);}}),{code:'COLLECTION_ACCOUNT_CONFIRM_REQUIRED'});assert.equal(reads,0);assert.equal(await loadCollectionSnapshot(o),null);
});
test('a verified sync receipt is retained even when operation-lock release fails',async t=>{
 const fs=(await import('node:fs/promises')).default,{syncBuiltinESMExports}=await import('node:module'),{withCollectionLock}=await import('../src/collection-lock.mjs');
 const o=await fixture(t),root=join(o.dataDir,'collection'),lock=join(root,'operation.lock'),original=fs.rm;
 fs.rm=async(path,...args)=>{if(String(path)===lock)throw Error('synthetic cleanup fault');return original(path,...args);};syncBuiltinESMExports();
 try{const result=await withCollectionLock(root,'operation.lock',async()=>({local_updated:false,synced:true}));assert.equal(result.synced,true);assert.equal(result.diagnostic_error,'COLLECTION_CLEANUP_FAILED');}
 finally{fs.rm=original;syncBuiltinESMExports();}
});
