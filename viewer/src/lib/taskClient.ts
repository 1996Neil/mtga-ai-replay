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
  let active: Promise<TaskJob<Result>> | null = null;
  let observedId: string | null | undefined;
  async function read(signal?: AbortSignal) {
    // A dead socket must not leave this observation pending indefinitely.
    const response = await request(path, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: 'no-store' });
    if (!response.ok) throw new Error(`无法读取后台状态（${response.status}）。`);
    return response.json() as Promise<TaskJob<Result>>;
  }
  function poll(onChange: (job: TaskJob<Result>) => void, signal?: AbortSignal, connection?: (lost: boolean) => void, initial?: TaskJob<Result>, uncertainPreviousId?: string | null) {
    return (async () => {
      let job = initial;
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (job) {
          if (uncertainPreviousId !== undefined && (job.status === 'idle' || job.id === uncertainPreviousId)) throw new Error('启动请求的回复丢失，尚不能确认新任务已启动。请查看后台状态后重试。');
          observedId = job.id; onChange(job); if (job.status !== 'running' && !job.notification_pending) return job;
        }
        await wait(signal);
        try { job = await read(signal); connection?.(false); }
        catch { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); connection?.(true); job = undefined; }
      }
    })();
  }
  return {
    resume(onChange: (job: TaskJob<Result>) => void, signal?: AbortSignal, connection?: (lost: boolean) => void): Promise<TaskJob<Result>> {
      if (active) return active;
      active = (async () => {
        let job: TaskJob<Result> | undefined;
        try { job = await read(signal); connection?.(false); }
        catch { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); connection?.(true); }
        return poll(onChange, signal, connection, job);
      })().finally(() => { active = null; });
      return active;
    },
    run(onChange: (job: TaskJob<Result>) => void, signal?: AbortSignal, connection?: (lost: boolean) => void, retryUpload = false): Promise<TaskJob<Result>> {
      if (active) return active;
      active = (async () => {
        // POST happens only on an explicit click. A lost reply is reconciled by GET,
        // never by retrying this mutation and creating a second task.
        const previousId = observedId ?? null;
        let response: Response;
        try { response = await request(retryUpload ? '/api/collection/sync' : path, { method: 'POST', headers: { 'X-MTGA-Replay-Action': retryUpload ? 'collection-sync' : action },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: 'no-store' }); }
        catch { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); connection?.(true); return poll(onChange, signal, connection, undefined, previousId); }
        if (!response.ok) throw new Error(response.status === 404 || response.status === 405 ? '当前后台服务尚未更新，请重启 Viewer 服务后再试。' : response.status === 409 ? '另一个数据任务正在运行，请等它结束后重试。' : `无法启动任务（${response.status}）。`);
        return poll(onChange, signal, connection, await response.json() as TaskJob<Result>);
      })().finally(() => { active = null; });
      return active;
    },
  };
}
