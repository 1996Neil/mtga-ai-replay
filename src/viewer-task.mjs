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
      const id = job.id, taskStarted = started;
      const finish = async (result, error = null) => {
        if (job.id !== id) return;
        // Publish the terminal state and its metadata in one turn. No older
        // Promise continuation may finish or notify a subsequently started job.
        job = { ...job, status: ['succeeded', 'partial', 'failed'].includes(result?.status) ? result.status : 'failed',
          result: result ?? null, error: error ?? result?.error ?? null,
          finished_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - taskStarted), notification_pending: true };
        const finished = { ...job };
        // A failed notification never relabels a successful publication.
        try { const receipt = await notify?.(kind, finished); if (receipt && job.id === id) job = { ...job, notification: receipt }; }
        catch { if (job.id === id) job = { ...job, notification: { attempted: true, accepted: false } }; }
        finally { if (job.id === id) job = { ...job, notification_pending: false }; }
      };
      completion = Promise.resolve().then(() => workflow({ operation, onProgress: progress => {
        if (job.id !== id || job.status !== 'running') return;
        if (progress.phase !== job.progress?.phase) phaseStarted = performance.now();
        job = { ...job, progress };
      } })).then(result => finish(result), error => finish(null, errorMessage(error)));
      return job;
    },
    wait: () => completion,
  };
}
