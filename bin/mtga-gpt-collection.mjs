#!/usr/bin/env node
import { resolve } from 'node:path';
import { updateCollection,syncCollection,collectionStatus,collectionErrorMessage,recoverCollectionOperationLock } from '../src/collection-update.mjs';
import { recoverCoachSyncLock } from '../src/coach-sync.mjs';
import { readDraftCapture } from '../src/draft-capture.mjs';
import { defaultDataDir } from '../src/history.mjs';
import { validAccountKey } from '../src/account-scope.mjs';
import { collectionPrefix } from '../src/collection-scope.mjs';
import { createInterface } from 'node:readline/promises';
const HELP=`mtga-gpt-collection update [--account <账号键>] [--confirm-account] [--no-sync]\nmtga-gpt-collection status [--account <账号键> | --legacy] [--recover-lock] [--recover-sync-lock]\nmtga-gpt-collection sync [--account <账号键>]\n\n默认使用本机采集器识别的 Arena 活动账号；update 必须确认游戏实际登录同一账号。\n--legacy 只读查看归属不明的旧收藏。仅 update 需要游戏运行。\n权限仅授予收藏读取 helper，文件保存与上传使用普通用户。\n`;
function localTime(value){return value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'无';}
function totals(summary,inventory){
 if(!summary){console.log('本地暂无成功收藏快照。');return;}
 console.log(`本地成功读取：${localTime(summary.read_at)}；验证：${localTime(summary.verified_at)}`);
 console.log(`收藏 ${summary.card_kinds} 种 / ${summary.total_quantity} 张；待识别 ${summary.unidentified_card_kinds} 种 / ${summary.unidentified_quantity} 张。`);
 console.log(`Gold ${inventory.gold} / Gems ${inventory.gems}；Common ${inventory.wildcards.common} / Uncommon ${inventory.wildcards.uncommon} / Rare ${inventory.wildcards.rare} / Mythic ${inventory.wildcards.mythic}。`);
 console.log(`内容 SHA256：${summary.content_hash}`);
}
try {
 const args=process.argv.slice(2),command=args.shift();const options={};
 if(!command||command==='--help'||command==='help'){console.log(HELP);}
 else {
  if(typeof process.getuid==='function'&&process.getuid()===0)throw new Error('RUN_AS_USER');
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--confirm-account'&&command==='update')options.confirmAccount=true;
    else if(args[i]==='--recover-lock'&&command==='status')options.recoverLock=true;
    else if(args[i]==='--recover-sync-lock'&&command==='status')options.recoverSyncLock=true;
    else if(args[i]==='--no-sync'&&command==='update')options.noSync=true;
    else if(args[i]==='--account'&&args[i+1])options.accountKey=args[++i];
    else if(args[i]==='--legacy'&&command==='status')options.legacy=true;
    else if(args[i]==='--data-dir'&&args[i+1])options.dataDir=resolve(args[++i]);
    else throw new Error('USAGE');
  }
  if(options.legacy&&options.accountKey)throw new Error('USAGE');
  if (!options.legacy) {
    const catalog=await readDraftCapture({dataDir:options.dataDir??defaultDataDir()});
    options.accountKey??=catalog.active_account;
    if(!validAccountKey(options.accountKey)||!catalog.accounts.some(item=>item.account_key===options.accountKey))throw Object.assign(new Error(),{code:'COLLECTION_ACCOUNT_INVALID'});
    const account=catalog.accounts.find(item=>item.account_key===options.accountKey);
    console.log(`收藏账号：${account.label} · ${options.accountKey.slice(0,8)}`);
    if(command==='update'&&!options.confirmAccount&&process.stdin.isTTY){
      const prompt=createInterface({input:process.stdin,output:process.stdout});
      try{options.confirmAccount=(await prompt.question(`请确认 Arena 当前登录的是「${account.label}」；读取器无法自动证明账号身份。输入 YES 继续：`)).trim()==='YES';}
      finally{prompt.close();}
    }
  }
  if(command==='update'||command==='sync') {
   const r=await (command==='update'?updateCollection:syncCollection)(options);totals(r.summary,r.inventory);
   if(r.synced)console.log(`远端已校验：${r.sync.repository} @ ${r.sync.last_synced.commit}\nGPT 可从仓库 ${collectionPrefix(options.accountKey)}summary.json 开始读取。`);
   else if(r.no_sync)console.log('本地更新成功；本次未同步远端。');
   else {console.log('本地更新成功，远端未更新。请运行 mtga-gpt-collection sync 重试。');if(r.sync_error)console.log(r.sync_error);process.exitCode=2;}
  }else if(command==='status'){
   if(options.recoverLock){const recovered=await recoverCollectionOperationLock(options);console.log(recovered?'已核实旧操作进程结束，陈旧操作锁已解除。':'没有需要解除的收藏操作锁。');}
   if(options.recoverSyncLock){const {recovered}=await recoverCoachSyncLock(options);console.log(recovered?'已核实旧同步进程结束，陈旧共享同步锁已解除。':'没有需要解除的共享同步锁。');}
   const r=await collectionStatus(options);totals(r.summary,r.inventory);
   console.log(`最近检查：${r.last_check?(r.last_check.ok?'通过':'失败')+' '+localTime(r.last_check.at):'无'}`);
   if(r.operation_lock.exists)console.log(r.operation_lock.alive?'收藏操作正在运行。':'发现陈旧操作锁；确认没有运行命令后，可执行 status --recover-lock。');
   if(r.last_check&&!r.last_check.ok)console.log(r.last_check.message);
   const last=r.sync.last_synced;
   console.log(last?`上次远端校验：${localTime(last.at)}；提交 ${last.commit}`:'尚未成功发布收藏。');
   console.log(r.current_snapshot_published?'本地内容与上次远端已校验内容一致；远端此刻未重新查询。':'当前本地收藏尚未确认发布；sync 可重试。');
   if(r.sync.last_error)console.log('上次同步失败；已保留本地结果。');
  }else throw new Error('USAGE');
 }
}catch(e){
 console.error(e.message==='USAGE'?HELP:e.message==='RUN_AS_USER'?'请以普通用户运行收藏命令；只有内部读取 helper 可以临时授权。':collectionErrorMessage(e));process.exitCode=1;
}
