/** Controlled old/new recovery race. Every reader/publisher is synthetic. */
import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const source=resolve(process.argv[2]),base=await fs.mkdtemp(join(tmpdir(),'recovery-race-synthetic-')),root=join(base,'collection'),lock=join(root,'operation.lock');
const originalRm=fs.rm;let entered,release,blocked=false;const at=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
fs.rm=async(path,...args)=>{if(String(path)===lock&&!blocked){blocked=true;entered();await hold;}return originalRm(path,...args);};syncBuiltinESMExports();
const {recoverCollectionOperationLock,updateCollection}=await import(pathToFileURL(join(source,'src/collection-update.mjs')));
const cards=[{grpId:900001,qty:2}],inventory={gold:0,gems:0,wildcards:{common:0,uncommon:0,rare:0,mythic:0}},probe={schema:'MTGA_COLLECTION_PROBE_V1',read_at:'2026-10-10T00:00:00.000Z',source:'mtga-reader@0.1.13/readCollection+readInventory',stable_reads:2,cards,inventory,content_hash:createHash('sha256').update(JSON.stringify({cards,inventory})).digest('hex')};
const options={dataDir:base,confirmAccount:true,cardDb:null,displayNamesZh:new Map(),noSync:true,readProbe:async()=>probe};
try{
 await fs.mkdir(root);await fs.writeFile(lock,'2147483647');const recovery=recoverCollectionOperationLock(options);await at;
 let secondRejected=false;try{await recoverCollectionOperationLock(options);}catch(error){if(error.code!=='COLLECTION_BUSY')throw error;secondRejected=true;}
 let readers=0,readerAt,readerRelease;const readEntered=new Promise(r=>readerAt=r),readHold=new Promise(r=>readerRelease=r);
 const start=()=>updateCollection({...options,readProbe:async()=>{readers++;readerAt();await readHold;return probe;}});
 let first;
 if(!secondRejected){first=start();await readEntered;release();await recovery;const second=start();await Promise.race([new Promise(r=>setTimeout(r,100)),readEntered]);readerRelease();await Promise.allSettled([first,second]);}
 else{await start().then(()=>{throw Error('Acquisition crossed recovery gate');},error=>{if(error.code!=='COLLECTION_BUSY')throw error;});release();await recovery;readerRelease();await start();}
 console.log(JSON.stringify({second_recovery_rejected:secondRejected,readers_during_old_race:readers,overlap:!secondRejected&&readers===2}));
}finally{release();fs.rm=originalRm;syncBuiltinESMExports();await originalRm(base,{recursive:true,force:true});}
