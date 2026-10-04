import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const CODES = new Set(['READ_PERMISSION_REQUIRED','ARENA_HOME_REQUIRED','ARENA_NOT_RUNNING','READER_SHAPE','READER_FAILED','COLLECTION_INCOMPLETE','COLLECTION_INVALID','COLLECTION_EMPTY','INVENTORY_UNKNOWN','READ_UNSTABLE','HELPER_ARCHITECTURE','READ_TIMEOUT']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export class CollectionReadError extends Error {
  constructor(code) { super(collectionReadMessage(code)); this.name='CollectionReadError'; this.code=CODES.has(code)?code:'READER_FAILED'; }
}
export function collectionReadMessage(code) {
  return ({READ_PERMISSION_REQUIRED:'macOS 需要读取授权。请在 Terminal 运行此命令或双击更新MTGA收藏.command，并只在本机终端输入密码。',
    ARENA_HOME_REQUIRED:'请退出对局并等待 Arena 首页或收藏加载完成，再更新。',
    ARENA_NOT_RUNNING:'Arena 未运行；上次成功快照保留。',
    READ_UNSTABLE:'两次读取结果不一致，请在首页加载完成后重试；上次成功快照保留。',
    INVENTORY_UNKNOWN:'资源字段缺失或未知；上次成功快照保留。',
    HELPER_ARCHITECTURE:'当前读取 helper 仅支持已验证的 macOS ARM64 环境。',
    READ_TIMEOUT:'读取超时；上次成功快照保留。'})[code] ?? '收藏读取或结构校验失败；上次成功快照保留。';
}
export function validateProbeResult(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new CollectionReadError('READER_SHAPE');
  if (value.ok===false) throw new CollectionReadError(CODES.has(value.code)?value.code:'READER_FAILED');
  if (value.schema!=='MTGA_COLLECTION_PROBE_V1' || value.source!=='mtga-reader@0.1.13/readCollection+readInventory'
    || value.stable_reads!==2 || typeof value.read_at!=='string' || !Number.isFinite(Date.parse(value.read_at))
    || !Array.isArray(value.cards) || value.cards.length===0 || value.cards.length>1_000_000) throw new CollectionReadError('COLLECTION_INVALID');
  const seen=new Set();
  const cards=value.cards.map(c=>{
    if (!c || !Number.isSafeInteger(c.grpId) || c.grpId<=0 || !integer(c.qty) || seen.has(c.grpId)) throw new CollectionReadError('COLLECTION_INVALID');
    seen.add(c.grpId); return {grpId:c.grpId,qty:c.qty};
  }).sort((a,b)=>a.grpId-b.grpId);
  const i=value.inventory;
  if (!i || ![i.gold,i.gems,i.wildcards?.common,i.wildcards?.uncommon,i.wildcards?.rare,i.wildcards?.mythic].every(integer)) throw new CollectionReadError('INVENTORY_UNKNOWN');
  if (!cards.some(c=>c.qty>0)) throw new CollectionReadError('COLLECTION_EMPTY');
  const inventory={gold:i.gold,gems:i.gems,wildcards:{common:i.wildcards.common,uncommon:i.wildcards.uncommon,rare:i.wildcards.rare,mythic:i.wildcards.mythic}};
  const content_hash=createHash('sha256').update(JSON.stringify({cards,inventory})).digest('hex');
  if (content_hash!==value.content_hash) throw new CollectionReadError('COLLECTION_INVALID');
  return {schema:value.schema,read_at:value.read_at,source:value.source,stable_reads:2,cards,inventory,content_hash};
}
function executeProbe(file,args,{interactive=false,spawnFn=spawn,timeoutMs=60000}={}) {
  return new Promise((yes,no)=>{
    let stdout='',done=false,oversized=false,timedOut=false,killTimer;
    const env={...process.env};
    for (const key of Object.keys(env)) if (/^(?:NODE_OPTIONS|NODE_PATH|DYLD_|LD_PRELOAD)/.test(key)) delete env[key];
    let child;
    try { child=spawnFn(file,args,{env,stdio:[interactive?'inherit':'ignore','pipe',interactive?'inherit':'ignore']}); }
    catch { no(new CollectionReadError('READER_FAILED'));return; }
    const timer=setTimeout(()=>{
      timedOut=true; finish(new CollectionReadError('READ_TIMEOUT'));
      try { child.kill('SIGTERM'); } catch {}
      if(file!=='/usr/bin/sudo') {killTimer=setTimeout(()=>{try {child.kill('SIGKILL');}catch {}},1000); killTimer.unref?.();}
    },timeoutMs);
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?no(error):yes(value);};
    child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8');if(Buffer.byteLength(stdout)>32*1024*1024){oversized=true;child.kill('SIGTERM');}});
    child.on('error',()=>finish(new CollectionReadError('READER_FAILED')));
    child.on('close',code=>{
      clearTimeout(killTimer);
      if(timedOut){finish(new CollectionReadError('READ_TIMEOUT'));return;}
      if(oversized){finish(new CollectionReadError('COLLECTION_INVALID'));return;}
      let value;
      try { value=JSON.parse(stdout); } catch { finish(new CollectionReadError('READER_FAILED'));return; }
      if (code!==0 && value?.ok!==false) {finish(new CollectionReadError('READER_FAILED'));return;}
      try {finish(null,validateProbeResult(value));}catch(e){finish(e);}
    });
  });
}
/** Only this fixed child may be elevated; callers and all publishing remain ordinary-user. */
export async function readCollectionProbe({interactive=Boolean(process.stdin.isTTY),allowPrivilege=true,...options}={}) {
  const helper=fileURLToPath(new URL('../tools/collection-reader/probe.mjs',import.meta.url));
  try { return await executeProbe(process.execPath,[helper],options); }
  catch(e) {
    if(e.code!=='READ_PERMISSION_REQUIRED' || !allowPrivilege) throw e;
    if(interactive) process.stderr.write('仅为收藏读取临时授权；密码在本机 Terminal 输入。保存与上传仍使用普通用户权限。\n');
    // Noninteractive runs can use an existing user-authorized sudo timestamp;
    // they never prompt for or capture a password. Terminal runs prompt directly.
    try { return await executeProbe('/usr/bin/sudo',[...(interactive?[]:['-n']),'--','/usr/bin/env','-i','PATH=/usr/bin:/bin:/usr/sbin:/sbin',process.execPath,helper],{...options,interactive}); }
    catch(e2) { if(e2.code==='READER_FAILED') throw new CollectionReadError('READ_PERMISSION_REQUIRED'); throw e2; }
  }
}
