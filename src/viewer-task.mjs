import { randomUUID } from 'node:crypto';

/** Server-owned lifetime. Browser aborts only stop observing this job. */
export function createViewerTask({ workflow, errorMessage, notify, kind, journal, reconcile }) {
  let job = journal?.load(kind) ?? { id: null, status: 'idle', progress: null, result: null, error: null };
  const persist = () => journal?.save(kind,job);
  let completion = Promise.resolve(), started = 0, phaseStarted = 0;
  return {
    snapshot: () => job.status === 'running' ? { ...job, elapsed_ms: Math.round(performance.now() - started), phase_elapsed_ms: Math.round(performance.now() - phaseStarted) } : job,
    start(operation) {
      if (job.status === 'running' || job.status === 'needs_recovery') return job;
      started = phaseStarted = performance.now();
      job = { id: randomUUID(), operation:kind==='collection'&&operation!=='sync'?'update':'sync', status: 'running', progress: { phase: kind === 'collection' ? 'reading' : 'scanning' }, result: null, error: null, started_at: new Date().toISOString() };
      try { persist(); } catch { job={id:null,status:'failed',progress:null,result:null,error:'无法保存任务记录，操作未启动。'};return job; }
      const id = job.id, taskStarted = started;
      const finish = async (result, error = null) => {
        if (job.id !== id) return;
        // Publish the terminal state and its metadata in one turn. No older
        // Promise continuation may finish or notify a subsequently started job.
        job = { ...job, status: ['succeeded', 'partial', 'failed'].includes(result?.status) ? result.status : 'failed',
          result: result ?? null, error: error ?? result?.error ?? null,
          finished_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - taskStarted), notification_pending: true };
        if(job.status==='failed'&&job.checkpoint)job={...job,status:'needs_recovery',error:'任务已生成提交，但发布结果未确认。请核对后恢复。'};
        try { persist(); } catch { job={...job,status:'needs_recovery',error:'任务可能已提交，但完成记录写入失败。请核对后恢复。'}; }
        const finished = { ...job };
        // A failed notification never relabels a successful publication.
        try { const receipt = await notify?.(kind, finished); if (receipt && job.id === id) job = { ...job, notification: receipt }; }
        catch { if (job.id === id) job = { ...job, notification: { attempted: true, accepted: false } }; }
        finally { if (job.id === id) { job = { ...job, notification_pending: false };try {persist();}catch{job={...job,status:'needs_recovery',error:'完成记录未保存，请核对后恢复。'};} } }
      };
      completion = Promise.resolve().then(() => workflow({ operation, onProgress: progress => {
        if (job.id !== id || job.status !== 'running') return;
        if (progress.phase !== job.progress?.phase) phaseStarted = performance.now();
        job = { ...job, progress, ...(progress.checkpoint?{checkpoint:progress.checkpoint}:{}) };
        try {persist();} catch {throw Error('Task journal write failed');}
      } })).then(result => finish(result), error => finish(null, errorMessage(error)));
      return job;
    },
    reconcile() {
      if(job.status!=='needs_recovery'||!reconcile)return job;
      const interrupted={...job},id=job.id;
      started=phaseStarted=performance.now();
      job={...job,status:'running',progress:{phase:'reconciling'},error:null};
      try{persist();}catch{job={...interrupted,error:'无法保存核对任务，仍需人工恢复。'};return job;}
      completion=Promise.resolve().then(()=>reconcile(interrupted)).then(result=>{
        if(job.id!==id)return;
        if(result?.status!=='succeeded')throw Error('Unverified recovery');
        job={...job,status:'succeeded',result,error:null,finished_at:new Date().toISOString(),notification_pending:false};persist();
      }).catch(()=>{if(job.id===id){job={...interrupted,status:'needs_recovery',error:'远端成果无法确认；需要人工核对，不会自动重发。'};try{persist();}catch{}}});
      return job;
    },
    wait: () => completion,
  };
}
