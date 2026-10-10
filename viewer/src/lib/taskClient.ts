export interface TaskJob<Result> {
  id: string | null; status: 'idle' | 'running' | 'succeeded' | 'partial' | 'failed';
  progress?: { phase: string; completed?: number; total?: number; timings_ms?: Record<string, number> } | null;
  result?: Result | null; error?: string | null;
  started_at?: string; finished_at?: string; elapsed_ms?: number; phase_elapsed_ms?: number;
  notification_pending?: boolean;
  notification?: { attempted: boolean; accepted: boolean };
}
export function taskPause(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1000);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export function createTaskClient<Result>(path: '/api/sync' | '/api/collection', action: 'sync' | 'collection-update', request: typeof fetch = fetch, wait = taskPause) {
  let active: { promise: Promise<TaskJob<Result>>; signal?: AbortSignal } | null = null;
  class StatusError extends Error {
    status: number;
    constructor(status: number) {
      super(status === 404 || status === 405 ? '当前后台服务尚未更新，请重启 Viewer 服务后再试。' : `无法读取后台状态（${status}）。`);
      this.status = status;
    }
  }
  function assertObserving(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
  async function read(signal?: AbortSignal) {
    // A dead socket must not leave this observation pending indefinitely.
    const response = await request(path, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: 'no-store' });
    if (!response.ok) throw new StatusError(response.status);
    const job = await response.json() as TaskJob<Result>;
    assertObserving(signal);
    return job;
  }
  async function readConnected(signal?: AbortSignal, connection?: (lost: boolean) => void) {
    while (true) {
      assertObserving(signal);
      try { const job = await read(signal); connection?.(false); return job; }
      catch (error) {
        assertObserving(signal);
        if (error instanceof StatusError && error.status < 500) { connection?.(false); throw error; }
        connection?.(true); await wait(signal);
      }
    }
  }
  function observe(work: () => Promise<TaskJob<Result>>, signal?: AbortSignal) {
    // An aborted observer may still be settling when a page attaches again.
    // It must neither capture the new observer nor clear the newer promise.
    if (active && !active.signal?.aborted) return active.promise;
    const promise = work().finally(() => { if (active?.promise === promise) active = null; });
    active = { promise, signal };
    return promise;
  }
  function poll(onChange: (job: TaskJob<Result>) => void, signal?: AbortSignal, connection?: (lost: boolean) => void, initial?: TaskJob<Result>, uncertainPreviousId?: string | null) {
    return (async () => {
      let job = initial;
      while (true) {
        assertObserving(signal);
        if (job) {
          if (uncertainPreviousId !== undefined && (job.status === 'idle' || job.id === uncertainPreviousId)) throw new Error('启动请求的回复丢失，尚不能确认新任务已启动。请查看后台状态后重试。');
          onChange(job); if (job.status !== 'running' && !job.notification_pending) return job;
        }
        await wait(signal);
        job = await readConnected(signal, connection);
      }
    })();
  }
  return {
    resume(onChange: (job: TaskJob<Result>) => void, signal?: AbortSignal, connection?: (lost: boolean) => void): Promise<TaskJob<Result>> {
      return observe(async () => poll(onChange, signal, connection, await readConnected(signal, connection)), signal);
    },
    run(onChange: (job: TaskJob<Result>) => void, signal?: AbortSignal, connection?: (lost: boolean) => void, retryUpload = false): Promise<TaskJob<Result>> {
      return observe(async () => {
        // POST happens only on an explicit click. A lost reply is reconciled by GET,
        // never by retrying this mutation and creating a second task.
        // The page may have been idle while another window completed a job.
        // Capture a fresh baseline, not the last result this client happened to see.
        const previous = await readConnected(signal, connection);
        if (previous.status === 'running') return poll(onChange, signal, connection, previous);
        const previousId = previous.id;
        let response: Response;
        let initial: TaskJob<Result> | undefined;
        try { response = await request(retryUpload ? '/api/collection/sync' : path, { method: 'POST', headers: { 'X-MTGA-Replay-Action': retryUpload ? 'collection-sync' : action },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: 'no-store' });
          // Headers can arrive before a socket failure truncates the JSON body.
          if (response.ok) initial = await response.json() as TaskJob<Result>;
        }
        catch { assertObserving(signal); connection?.(true); return poll(onChange, signal, connection, undefined, previousId); }
        if (!response.ok) throw new Error(response.status === 404 || response.status === 405 ? '当前后台服务尚未更新，请重启 Viewer 服务后再试。' : response.status === 409 ? '另一个数据任务正在运行，请等它结束后重试。' : `无法启动任务（${response.status}）。`);
        return poll(onChange, signal, connection, initial);
      }, signal);
    },
  };
}
