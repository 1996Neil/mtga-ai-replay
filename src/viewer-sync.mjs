import { randomUUID } from 'node:crypto';
import { syncReplayHistory, replaySyncError } from './replay-workflow.mjs';

/** One in-memory job per server; the publisher's existing cross-process lock
 * still serializes Git writes with CLI and collection commands. */
export function createViewerSync({ dataDir, workflow = syncReplayHistory }) {
  let job = { id: null, status: 'idle', progress: null, result: null, error: null };
  let completion = Promise.resolve();
  return {
    snapshot: () => job,
    start() {
      if (job.status === 'running') return job;
      job = { id: randomUUID(), status: 'running', progress: { phase: 'scanning' }, result: null, error: null };
      completion = Promise.resolve().then(() => workflow({ dataDir,
        onProgress: progress => { job = { ...job, progress }; },
      })).then(result => {
        job = { ...job, status: result.status, result, error: result.error ?? null };
      }).catch(error => {
        job = { ...job, status: 'failed', error: replaySyncError(error) };
      });
      return job;
    },
    wait: () => completion,
  };
}
