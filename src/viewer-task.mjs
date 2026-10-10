import { randomUUID } from 'node:crypto';

/** Server-owned lifetime. Browser aborts only stop observing this job. */
export function createViewerTask({ workflow, errorMessage, notify, kind }) {
  let job = { id: null, status: 'idle', progress: null, result: null, error: null };
  let completion = Promise.resolve(), started = 0, phaseStarted = 0;
  return {
    snapshot: () => job.status === 'running' ? { ...job, elapsed_ms: Math.round(performance.now() - started), phase_elapsed_ms: Math.round(performance.now() - phaseStarted) } : job,
    start(operation) {
      if (job.status === 'running') return job;
      started = phaseStarted = performance.now();
      job = { id: randomUUID(), status: 'running', progress: { phase: kind === 'collection' ? 'reading' : 'scanning' }, result: null, error: null, started_at: new Date().toISOString() };
      completion = Promise.resolve().then(() => workflow({ operation, onProgress: progress => {
        if (progress.phase !== job.progress?.phase) phaseStarted = performance.now();
        job = { ...job, progress };
      } })).then(result => {
        job = { ...job, status: ['succeeded', 'partial', 'failed'].includes(result.status) ? result.status : 'failed', result, error: result.error ?? null };
      }).catch(error => { job = { ...job, status: 'failed', error: errorMessage(error) }; }).then(async () => {
        job = { ...job, finished_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - started) };
        // A failed notification never relabels a successful publication.
        const finished = { ...job };
        job = { ...job, notification_pending: true };
        try { const receipt = await notify?.(kind, finished); if (receipt && job.id === finished.id) job = { ...job, notification: receipt, notification_pending: false }; }
        catch { if (job.id === finished.id) job = { ...job, notification: { attempted: true, accepted: false }, notification_pending: false }; }
        finally { if (job.id === finished.id) job = { ...job, notification_pending: false }; }
      });
      return job;
    },
    wait: () => completion,
  };
}
