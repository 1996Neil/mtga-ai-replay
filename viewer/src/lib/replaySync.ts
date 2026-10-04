export interface SyncResult {
  status: 'succeeded' | 'partial' | 'failed'; new_matches: number; local_matches: number;
  already_published: number; missing: number | null; published: number; failed: number; skipped: number;
  github_matches: number | null; updated?: number; error: string | null;
  latest: { match_id: string; started_at: string; result: string } | null;
  failures: { match_id: string; started_at: string; reason: string }[];
}
export interface SyncJob {
  id: string | null; status: 'idle' | 'running' | 'succeeded' | 'partial' | 'failed';
  progress?: { phase: string; completed?: number; total?: number } | null;
  result?: SyncResult | null; error?: string | null;
}
export function syncButtonLabel(job: SyncJob) {
  if (job.status === 'running') {
    if (job.progress?.phase === 'publishing') return '正在上传…';
    if (job.progress?.phase === 'generating' && job.progress.total) return `正在准备 ${job.progress.completed ?? 0}/${job.progress.total}…`;
    return '正在扫描…';
  }
  if (job.status === 'partial') return '部分同步失败';
  if (job.status === 'failed') return '同步失败';
  if (job.status === 'succeeded') return job.result?.published ? `已同步 ${job.result.published} 场` : job.result?.updated ? '已同步' : '已是最新';
  return '同步回放';
}

function pause(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 700);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
/** Structured API only. Rapid callers share one request/polling task. */
export function createReplaySyncClient(request: typeof fetch = fetch, wait = pause) {
  let active: Promise<SyncJob> | null = null;
  return { run(onChange: (job: SyncJob) => void, signal?: AbortSignal): Promise<SyncJob> {
    if (active) return active;
    active = (async () => {
      const response = await request('/api/sync', { method: 'POST', headers: { 'X-MTGA-Replay-Action': 'sync' }, signal, cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 || response.status === 405 ? '当前后台服务尚未更新，请重启 Viewer 服务后再试。' : `无法启动同步（${response.status}）。`);
      let job = await response.json() as SyncJob;
      onChange(job);
      while (job.status === 'running') {
        await wait(signal);
        const status = await request('/api/sync', { signal, cache: 'no-store' });
        if (!status.ok) throw new Error(`无法读取同步状态（${status.status}），请稍后重试。`);
        job = await status.json() as SyncJob; onChange(job);
      }
      return job;
    })().finally(() => { active = null; });
    return active;
  } };
}
