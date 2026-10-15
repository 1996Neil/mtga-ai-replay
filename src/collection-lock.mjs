import { mkdir, lstat, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

const fail = code => { const error = new Error('Collection lock safety check failed.'); error.code = code; throw error; };
async function directory(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) fail('COLLECTION_LOCAL_INVALID');
}
const same = (a,b) => a.dev === b.dev && a.ino === b.ino && a.isFile() && !a.isSymbolicLink();
async function rejectRecovery(root) {
  try { await lstat(join(root,'recovery.lock')); fail('COLLECTION_BUSY'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function release(path,handle) {
  try {
    const own = await handle.stat({ bigint:true });
    try { if (same(await lstat(path,{bigint:true}),own)) await rm(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  } finally { await handle.close(); }
}
/** All cooperating operation/save contenders check the exclusive recovery gate
 * before and after acquiring their own inode, before entering a callback. */
export async function withCollectionLock(root,name,callback) {
  await directory(root); await rejectRecovery(root); const path=join(root,name); let handle;
  try { handle=await open(path,'wx',0o600); }
  catch (error) { if(error.code==='EEXIST') fail('COLLECTION_BUSY'); throw error; }
  let result,completed=false;
  try { await rejectRecovery(root); await handle.writeFile(String(process.pid)); result=await callback();completed=true;return result; }
  finally { try{await release(path,handle);}catch(error){
    if(completed&&(result?.local_updated||result?.synced))return {...result,diagnostic_error:'COLLECTION_CLEANUP_FAILED',sync_error:result.sync_error??'收藏成果已保存或已确认上传，但锁清理未完成；请恢复操作锁。'};
    throw error;
  } }
}
const dead = pid => { try { process.kill(pid,0); return false; } catch(error) { return error.code==='ESRCH'; } };
/** Serialized manual recovery. An incomplete/changed/live inode is never removed.
 * The gate is the concurrency boundary; inode checks are defense in depth, not
 * an assertion of atomic unlink against a hostile owner of the whole directory. */
export async function recoverCollectionLocks(root) {
  await directory(root); const gatePath=join(root,'recovery.lock'); let gate;
  try { gate=await open(gatePath,'wx',0o600); }
  catch(error) { if(error.code==='EEXIST') fail('COLLECTION_BUSY'); throw error; }
  try {
    await gate.writeFile(String(process.pid)); const stale=[];
    for(const name of ['operation.lock','save.lock']) {
      const path=join(root,name); let handle;
      try {
        const info=await lstat(path,{bigint:true});
        if(!info.isFile()||info.isSymbolicLink()) fail('COLLECTION_LOCAL_INVALID');
        handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
        const own=await handle.stat({bigint:true}); if(!same(info,own)) fail('COLLECTION_BUSY');
        const text=await handle.readFile('utf8'),pid=Number(text);
        if(!/^[1-9][0-9]{0,9}$/.test(text)||!Number.isSafeInteger(pid)||pid>2147483647||!dead(pid)) fail('COLLECTION_BUSY');
        stale.push({path,own,pid,text});
      } catch(error) { if(error.code!=='ENOENT') throw error; }
      finally { await handle?.close(); }
    }
    // Check every inode again before removing any. No operation can enter while
    // the gate is owned, including direct saveCollectionSnapshot callers.
    for(const item of stale) {
      const info=await lstat(item.path,{bigint:true}); if(!same(info,item.own)||!dead(item.pid)) fail('COLLECTION_BUSY');
      const handle=await open(item.path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try { if(!same(await handle.stat({bigint:true}),item.own)||await handle.readFile('utf8')!==item.text) fail('COLLECTION_BUSY'); }
      finally { await handle.close(); }
    }
    for(const item of stale) { if(!same(await lstat(item.path,{bigint:true}),item.own)||!dead(item.pid)) fail('COLLECTION_BUSY'); await rm(item.path); }
    return stale.length>0;
  } finally { await release(gatePath,gate); }
}
