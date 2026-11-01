import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

/** Local summaries only. A journal is evidence of task ownership, never a
 * publication receipt or authority to repeat a mutation after restart. */
export function createTaskJournal(dataDir) {
  const root=join(dataDir,'tasks');mkdirSync(root,{recursive:true,mode:0o700});
  if(lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory())throw Error('Unsafe task journal');
  const path=join(root,'journal.sqlite3');
  for(const name of [path,path+'-wal',path+'-shm']) {
    try{const info=lstatSync(name);if(!info.isFile()||info.isSymbolicLink())throw Error('Unsafe task journal');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const db=new DatabaseSync(path);chmodSync(path,0o600); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS task (kind TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const read=db.prepare('SELECT value FROM task WHERE kind=?'),write=db.prepare('INSERT INTO task(kind,value) VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET value=excluded.value');
  const phases=new Set(['reading','uploading','scanning','comparing','cards','generating','remote','publishing','security','reconciling','downloading','waiting']);
  const statuses=new Set(['idle','running','succeeded','partial','failed','needs_recovery']);
  function sanitize(job) {
    if(job.id!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.id??''))throw Error('Invalid task identity');
    if(!statuses.has(job.status))throw Error('Invalid task status');
    const output={id:job.id,operation:job.operation==='update'?'update':'sync',status:job.status,progress:job.progress?{phase:phases.has(job.progress.phase)?job.progress.phase:'scanning'}:null,result:null,error:null};
    for(const key of ['started_at','finished_at'])if(typeof job[key]==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(job[key])&&Number.isFinite(Date.parse(job[key])))output[key]=job[key];
    for(const key of ['completed','total'])if(Number.isSafeInteger(job.progress?.[key])&&job.progress[key]>=0)output.progress[key]=job.progress[key];
    if(job.status==='failed')output.error='上次任务未完成，请检查本地队列后恢复。';
    if(job.status==='partial')output.error='本地成果已保留；发布或状态记录尚未完成。';
    if(job.status==='needs_recovery')output.error='服务曾中断。需要人工核对本地队列和远端提交；不会自动读取或重复上传。';
    if(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.checkpoint?.commit??''))output.checkpoint={commit:job.checkpoint.commit,...(/^[a-f0-9]{64}$/.test(job.checkpoint.destination_hash??'')?{destination_hash:job.checkpoint.destination_hash}:{})};
    if(['succeeded','partial'].includes(job.status)&&job.result){
      const safe={status:job.status};
      for(const key of ['published','updated','downloaded','failed','local_matches','github_matches','skipped'])if(Number.isSafeInteger(job.result[key])&&job.result[key]>=0)safe[key]=job.result[key];
      for(const key of ['local_updated','synced','reconciled'])if(typeof job.result[key]==='boolean')safe[key]=job.result[key];
      if(job.result.summary){safe.summary={};for(const key of ['card_kinds','total_quantity'])if(Number.isSafeInteger(job.result.summary[key])&&job.result.summary[key]>=0)safe.summary[key]=job.result.summary[key];}
      output.result=safe;
    }
    if(job.notification)output.notification={attempted:!!job.notification.attempted,accepted:!!job.notification.accepted};
    return output;
  }
  return {
    kinds: () => db.prepare('SELECT kind FROM task').all().map(row => row.kind),
    load(kind) {
      const row=read.get(kind);if(!row)return null;
      const job=sanitize(JSON.parse(row.value));
      if(job.status==='running'){job.status='needs_recovery';job.error='服务曾中断。需要人工核对本地队列和远端提交；不会自动读取或重复上传。';write.run(kind,JSON.stringify(job));}
      return job;
    },
    save(kind,job){write.run(kind,JSON.stringify(sanitize(job)));},
    close(){db.close();},
  };
}
