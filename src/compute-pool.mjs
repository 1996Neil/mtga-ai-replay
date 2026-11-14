import {CoachSyncError} from './coach-sync-error.mjs';
import { Worker } from 'node:worker_threads';

/** Bounded CPU pool. Only structured, read-only computation is accepted.
 * No Git checkout, credential, reader or publication command enters workers. */
export function createComputePool({ size = 2, maxQueue = 32 } = {}) {
  if (![2,4].includes(size)) throw Error('Unsupported worker count');
  let closed = false, sequence = 0, failures=0; const waiting = [], slots = [];
  function dispatch() {
    for (const slot of slots) {
      if (closed || slot.retiring || slot.task || !waiting.length) continue;
      const task = waiting.shift(); slot.task = task;
      slot.worker.ref();task.timeout=setTimeout(()=>{slot.worker.terminate();},120000);
      try { slot.worker.postMessage({ id: task.id, operation: task.operation, input: task.input }); }
      catch { finish(slot, Error('CPU task transfer failed')); }
    }
  }
  function finish(slot, error, value) {
    const task = slot.task; slot.task = null; if(task)clearTimeout(task.timeout);slot.worker.unref();
    // Large source expansion is a one-shot peak. Release its V8 heap instead of
    // retaining gigabytes after either a ready or rejected cloud verification.
    if (!closed && task?.operation === 'cloudReviewSync') { slot.retiring = true; void slot.worker.terminate(); }
    if (task) error ? task.reject(error) : task.resolve(value);
    dispatch();
  }
  function make() {
    // This pure ESM worker needs no main-process CLI flags. Explicitly copying
    // execArgv also copies flags Node expands in test children that Workers reject.
    const slot = { worker: new Worker(new URL('./compute-worker.mjs', import.meta.url),{execArgv:[]}), task: null };
    slot.worker.unref();
    slot.worker.on('message', message => {
      if (slot.task?.id !== message.id) return;
      const error=message.error?(message.code==='SYNC_BUNDLE'?new CoachSyncError('SYNC_BUNDLE','Coach bundle validation failed; no upload was attempted.'):Error('CPU task failed')):null;if(error&&message.security)error.code='MTGA_SYNC_SECURITY';
      finish(slot,error,message.value);
    });
    slot.worker.on('error', () => {
      // Do not leak replay contents, paths, or worker stack into status errors.
      const task = slot.task; slot.task = null; if(task)clearTimeout(task.timeout);task?.reject(Error('CPU worker failed'));
    });
    slot.worker.on('exit', () => {
      const task = slot.task; slot.task = null; if(task)clearTimeout(task.timeout);task?.reject(Error('CPU worker exited'));
      if(!closed&&!slot.retiring&&++failures>2){closed=true;for(const pending of waiting.splice(0))pending.reject(Error('CPU pool unavailable'));for(const peer of slots)if(peer!==slot){if(peer.task){clearTimeout(peer.task.timeout);peer.task.reject(Error('CPU pool unavailable'));peer.task=null;}peer.worker.terminate();}}
      if (!closed) { const index = slots.indexOf(slot); slots[index] = make(); dispatch(); }
    });
    return slot;
  }
  for (let i=0;i<size;i++) slots.push(make());
  return {
    run(operation, input) {
      if (closed) return Promise.reject(Error('CPU pool closed'));
      if (!['bundle','validate','bundleFiles','validateFiles','cloudReviewSync','cloudReviewRead','cloudReviewFingerprint'].includes(operation)) return Promise.reject(Error('Unsupported CPU operation'));
      if (waiting.length >= maxQueue) return Promise.reject(Error('CPU queue full'));
      return new Promise((resolve,reject) => { waiting.push({id:++sequence,operation,input,resolve,reject}); dispatch(); });
    },
    async close() {
      closed = true;
      for (const task of waiting.splice(0)) task.reject(Error('CPU pool closed'));
      for (const slot of slots) { if(slot.task)clearTimeout(slot.task.timeout);slot.task?.reject(Error('CPU pool closed')); slot.task = null; }
      await Promise.all(slots.map(slot => slot.worker.terminate()));
    },
  };
}
