import { mkdir,readFile,writeFile,rename,open,rm,lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateBundleFiles } from './sync-security.mjs';
import { defaultDataDir } from './history.mjs';
import { readCollectionProbe,collectionReadMessage } from './collection-reader.mjs';
import { buildCollectionSnapshot,saveCollectionSnapshot,loadCollectionSnapshot } from './collection.mjs';
import { syncCollectionSnapshot,getCollectionSyncStatus } from './collection-sync.mjs';

const root=options=>join(options.dataDir??defaultDataDir(),'collection');
class OperationError extends Error { constructor(code,message){super(message);this.code=code;} }
async function directory(path) {
  await mkdir(path,{recursive:true,mode:0o700});
  const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()) throw new OperationError('COLLECTION_LOCAL_INVALID','收藏本地目录不安全，未更新。');
}
async function writeState(options,value) {
  await directory(root(options)); const target=join(root(options),'update-state.json');
  try {const s=await lstat(target);if(!s.isFile()||s.isSymbolicLink()) throw new OperationError('COLLECTION_LOCAL_INVALID','收藏本地状态不安全，未更新。');}catch(e){if(e.code!=='ENOENT')throw e;}
  const temp=`${target}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,target);
}
async function readState(options) {
  try {
    const path=join(root(options),'update-state.json'),s=await lstat(path);
    if(!s.isFile()||s.isSymbolicLink())throw new Error();
    const text=await readFile(path,'utf8');
    validateBundleFiles(new Map([['collection/latest/summary.json',text]]));
    const value=JSON.parse(text);
    if(value.schema!=='MTGA_COLLECTION_UPDATE_STATE_V1'||Object.keys(value).sort().join(',')!=='last_check,schema') throw new Error();
    const check=value.last_check;
    if(check!==null){
      if(typeof check!=='object'||Array.isArray(check)||typeof check.ok!=='boolean'||typeof check.at!=='string'||!Number.isFinite(Date.parse(check.at)))throw new Error();
      const keys=check.ok?['at','content_hash','ok']:['at','code','message','ok'];
      if(Object.keys(check).sort().join(',')!==keys.sort().join(','))throw new Error();
      if(check.ok?!/^[a-f0-9]{64}$/.test(check.content_hash??''):(!/^[A-Z_]{1,64}$/.test(check.code??'')||typeof check.message!=='string'||check.message.length>1024))throw new Error();
    }
    return value;
  }catch(e){if(e.code==='ENOENT')return {schema:'MTGA_COLLECTION_UPDATE_STATE_V1',last_check:null};throw new OperationError('COLLECTION_LOCAL_INVALID','收藏本地状态无效；未更新。');}
}
async function operation(options,callback) {
  await directory(root(options));const path=join(root(options),'operation.lock');let h;
  try{h=await open(path,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new OperationError('COLLECTION_BUSY','收藏操作被锁住；若前一命令已中断，请确认没有运行命令后执行 mtga-gpt-collection status --recover-lock。');throw e;}
  try{await h.writeFile(String(process.pid));return await callback();}finally{await h.close();await rm(path,{force:true});}
}
export function collectionErrorMessage(error) {
  if(error?.name==='CollectionReadError')return collectionReadMessage(error.code);
  // Only locally constructed errors use these fixed codes; native/Git stderr is never exposed.
  const messages={COLLECTION_BUSY:'收藏操作被锁住；若前一命令已中断，请确认没有运行命令后执行 mtga-gpt-collection status --recover-lock。',COLLECTION_LOCAL_INVALID:'收藏本地存储未通过检查；上次成功快照保留。',
    COLLECTION_DECREASE:'收藏出现减少，可能尚未加载或切换账号；请在首页或收藏页核对后再更新。上次成功快照保留。',
    COLLECTION_LARGE_CHANGE:'收藏异常大幅增加，可能切换了账号；请核对后再处理。上次成功快照保留。',
    SYNC_BUSY:'另一个数据同步或锁恢复正在运行，请等它结束后重试。',
    SYNC_LOCK_STALE:'共享同步锁来自已结束的进程；确认没有运行命令后执行 mtga-gpt-collection status --recover-sync-lock。',
    COLLECTION_NO_SNAPSHOT:'没有已验证的收藏快照，请先运行 update。'};
  return messages[error?.code] ?? '收藏操作未完成；已保存的成功快照保留。';
}
export async function updateCollection(options={}) {
  return operation(options,async()=>{
    let snapshot;
    try {
      const probe=await (options.readProbe??readCollectionProbe)(options.readerOptions);
      snapshot=await buildCollectionSnapshot(probe,options);
      await saveCollectionSnapshot(snapshot,options);
      await writeState(options,{schema:'MTGA_COLLECTION_UPDATE_STATE_V1',last_check:{ok:true,at:snapshot.summary.verified_at,content_hash:snapshot.summary.content_hash}});
    }catch(e){
      await writeState(options,{schema:'MTGA_COLLECTION_UPDATE_STATE_V1',last_check:{ok:false,at:new Date().toISOString(),code:/^[A-Z_]{1,64}$/.test(e?.code??'')?e.code:'COLLECTION_FAILED',message:collectionErrorMessage(e)}});throw e;
    }
    if(options.noSync)return {local_updated:true,synced:false,no_sync:true,summary:snapshot.summary,inventory:snapshot.inventory};
    try {const sync=await syncCollectionSnapshot(snapshot,options);return {local_updated:true,synced:true,summary:snapshot.summary,inventory:snapshot.inventory,sync};}
    catch(e){return {local_updated:true,synced:false,summary:snapshot.summary,inventory:snapshot.inventory,sync_error:collectionErrorMessage(e)};}
  });
}
export async function syncCollection(options={}) {
  return operation(options,async()=>{
    const snapshot=await loadCollectionSnapshot(options);
    if(!snapshot) throw new OperationError('COLLECTION_NO_SNAPSHOT','没有已验证的收藏快照，请先运行 update。');
    const sync=await syncCollectionSnapshot(snapshot,options);
    return {local_updated:false,synced:true,summary:snapshot.summary,inventory:snapshot.inventory,sync};
  });
}
async function localLockStatus(options,name) {
  try {
    const path=join(root(options),name),s=await lstat(path);
    if(!s.isFile()||s.isSymbolicLink())throw new Error();
    const pid=Number(await readFile(path,'utf8'));
    if(!Number.isSafeInteger(pid)||pid<=0)throw new Error();
    let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else if(e.code!=='EPERM')throw e;}
    return {exists:true,alive};
  }catch(e){if(e.code==='ENOENT')return {exists:false,alive:false};throw new OperationError('COLLECTION_LOCAL_INVALID','收藏操作锁无法安全检查。');}
}
export const collectionOperationLockStatus=(options={})=>localLockStatus(options,'operation.lock');
// Explicit repair only: automatic stale unlink can race another lock acquirer.
export async function recoverCollectionOperationLock(options={}) {
  const locks=['operation.lock','save.lock'];
  const statuses=await Promise.all(locks.map(name=>localLockStatus(options,name)));
  if(statuses.some(status=>status.alive))throw new OperationError('COLLECTION_BUSY','收藏操作仍在运行，不能移除锁。');
  for(let i=0;i<locks.length;i++)if(statuses[i].exists)await rm(join(root(options),locks[i]));
  return statuses.some(status=>status.exists);
}
export async function collectionStatus(options={}) {
  const snapshot=await loadCollectionSnapshot(options),state=await readState(options),sync=await getCollectionSyncStatus(options);
  return {installed_version:'0.3.1',local_validated:Boolean(snapshot),summary:snapshot?.summary??null,inventory:snapshot?.inventory??null,last_check:state.last_check,
    sync,operation_lock:await collectionOperationLockStatus(options),current_snapshot_published:Boolean(snapshot&&sync.pending===0&&sync.last_error===null&&sync.last_synced?.content_hash===snapshot.summary.content_hash&&sync.last_synced?.verified===true&&sync.last_synced.at>=snapshot.summary.verified_at)};
}
