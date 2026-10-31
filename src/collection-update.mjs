import { mkdir,readFile,writeFile,rename,open,rm,lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateBundleFiles } from './sync-security.mjs';
import { defaultDataDir } from './history.mjs';
import { withCollectionLock,recoverCollectionLocks } from './collection-lock.mjs';
import { readCollectionProbe,collectionReadMessage } from './collection-reader.mjs';
import { buildCollectionSnapshot,saveCollectionSnapshot,loadCollectionSnapshot } from './collection.mjs';
import { syncCollectionSnapshot,getCollectionSyncStatus } from './collection-sync.mjs';
import { collectionAccountKey, collectionStoreRoot } from './collection-scope.mjs';
import { readDraftCapture } from './draft-capture.mjs';

const root=options=>collectionStoreRoot(options.dataDir??defaultDataDir(), options.accountKey);
class OperationError extends Error { constructor(code,message){super(message);this.code=code;} }
async function directory(path) {
  await mkdir(path,{recursive:true,mode:0o700});
  const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()) throw new OperationError('COLLECTION_LOCAL_INVALID','收藏本地目录不安全，未更新。');
}
async function writeState(options,value) {
  if (options.accountKey) { await directory(root({ dataDir: options.dataDir })); await directory(join(root({ dataDir: options.dataDir }), 'accounts')); }
  await directory(root(options)); const target=join(root(options),'update-state.json');
  try {const s=await lstat(target);if(!s.isFile()||s.isSymbolicLink()) throw new OperationError('COLLECTION_LOCAL_INVALID','收藏本地状态不安全，未更新。');}catch(e){if(e.code!=='ENOENT')throw e;}
  const temp=`${target}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,target);
}
async function readState(options) {
  try {
    if (options.accountKey) {
      for (const path of [root({ dataDir: options.dataDir }), join(root({ dataDir: options.dataDir }), 'accounts')]) {
        const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      }
    }
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
async function operation(options,callback) { return withCollectionLock(root({dataDir:options.dataDir}),'operation.lock',callback); }
export async function activeCollectionAccount(options = {}) {
  return (await readDraftCapture({ dataDir: options.dataDir ?? defaultDataDir(), metadataOnly: true })).active_account;
}
async function checkAccount(options) {
  collectionAccountKey(options.accountKey);
  if (options.accountKey && await (options.activeAccount ?? activeCollectionAccount)(options) !== options.accountKey) {
    throw new OperationError('COLLECTION_ACCOUNT_CHANGED', 'Game account does not match the selected collection.');
  }
}
export function collectionErrorMessage(error) {
  if(error?.name==='CollectionReadError')return collectionReadMessage(error.code);
  // Only locally constructed errors use these fixed codes; native/Git stderr is never exposed.
  const messages={COLLECTION_BUSY:'收藏操作被锁住；若前一命令已中断，请确认没有运行命令后执行 mtga-gpt-collection status --recover-lock。',COLLECTION_LOCAL_INVALID:'收藏本地存储未通过检查；上次成功快照保留。',
    COLLECTION_DECREASE:'收藏出现减少，可能尚未加载或切换账号；请在首页或收藏页核对后再更新。上次成功快照保留。',
    COLLECTION_LARGE_CHANGE:'收藏异常大幅增加，可能切换了账号；请核对后再处理。上次成功快照保留。',
    SYNC_BUSY:'另一个数据同步或锁恢复正在运行，请等它结束后重试。',
    SYNC_LOCK_STALE:'共享同步锁来自已结束的进程；确认没有运行命令后执行 mtga-gpt-collection status --recover-sync-lock。',
    COLLECTION_ACCOUNT_CONFIRM_REQUIRED:'当前读取器无法可靠识别账户；请确认 Arena 中是预期账户，再明确确认更新。上次快照未改变。',
    COLLECTION_ACCOUNT_INVALID:'请选择已识别的游戏账号；未分类旧收藏不会自动分配给任何账号。',
    COLLECTION_ACCOUNT_CHANGED:'Arena 活动账号与所选账号不一致或读取期间发生变化；未保存收藏。请核对账号后重试。',
    COLLECTION_NO_SNAPSHOT:'没有已验证的收藏快照，请先运行 update。'};
  return messages[error?.code] ?? '收藏操作未完成；已保存的成功快照保留。';
}
export async function updateCollection(options={}) {
  return operation(options,async()=>{
    if(options.confirmAccount!==true)throw new OperationError('COLLECTION_ACCOUNT_CONFIRM_REQUIRED','Account confirmation required');
    await checkAccount(options);
    let snapshot;
    try {
      const probe=await (options.readProbe??readCollectionProbe)(options.readerOptions);
      await checkAccount(options);
      snapshot=await buildCollectionSnapshot(probe,options);
      await saveCollectionSnapshot(snapshot,options);
    }catch(e){
      if(snapshot){
        try{const current=await loadCollectionSnapshot(options);
          if(current&&current.summary.content_hash===snapshot.summary.content_hash&&current.summary.verified_at===snapshot.summary.verified_at)
            return {local_updated:true,synced:false,summary:current.summary,inventory:current.inventory,diagnostic_error:'COLLECTION_CLEANUP_FAILED',sync_error:'本地收藏已保存，但锁清理未完成；请核对并恢复操作锁。'};
        }catch{}
      }
      try { await writeState(options,{schema:'MTGA_COLLECTION_UPDATE_STATE_V1',last_check:{ok:false,at:new Date().toISOString(),code:/^[A-Z_]{1,64}$/.test(e?.code??'')?e.code:'COLLECTION_FAILED',message:collectionErrorMessage(e)}}); } catch {}
      throw e;
    }
    // current.json is committed: a later diagnostics failure must not report
    // that the previous snapshot was retained, nor hide the successful save.
    try { await writeState(options,{schema:'MTGA_COLLECTION_UPDATE_STATE_V1',last_check:{ok:true,at:snapshot.summary.verified_at,content_hash:snapshot.summary.content_hash}}); }
    catch { const message='本地收藏已保存，但状态记录未完成；请检查本地状态后重试上传。';return {local_updated:true,synced:false,summary:snapshot.summary,inventory:snapshot.inventory,diagnostic_error:'COLLECTION_DIAGNOSTIC_FAILED',sync_error:message}; }
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
export const collectionOperationLockStatus=(options={})=>localLockStatus({dataDir:options.dataDir},'operation.lock');
// Explicit repair only: automatic stale unlink can race another lock acquirer.
export async function recoverCollectionOperationLock(options={}) {
  collectionAccountKey(options.accountKey);
  const recovered = await recoverCollectionLocks(root({dataDir:options.dataDir}));
  if (!options.accountKey) return recovered;
  try {
    for (const path of [join(root({dataDir:options.dataDir}), 'accounts'), root(options)]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new OperationError('COLLECTION_LOCAL_INVALID', 'Unsafe collection account storage.');
    }
  } catch (error) { if (error.code === 'ENOENT') return recovered; throw error; }
  return await recoverCollectionLocks(root(options)) || recovered;
}
export async function collectionStatus(options={}) {
  const snapshot=await loadCollectionSnapshot(options),state=await readState(options),sync=await getCollectionSyncStatus(options);
  return {installed_version:'0.3.1',local_validated:Boolean(snapshot),summary:snapshot?.summary??null,inventory:snapshot?.inventory??null,last_check:state.last_check,
    account_key: options.accountKey ?? null,
    sync,operation_lock:await collectionOperationLockStatus(options),current_snapshot_published:Boolean(snapshot&&sync.pending===0&&sync.last_error===null&&sync.last_synced?.content_hash===snapshot.summary.content_hash&&sync.last_synced?.verified===true&&sync.last_synced.at>=snapshot.summary.verified_at)};
}
