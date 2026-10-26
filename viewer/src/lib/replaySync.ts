import { createTaskClient } from './taskClient.ts';
import type { TaskJob } from './taskClient.ts';
export interface SyncResult {
  status: 'succeeded' | 'partial' | 'failed'; new_matches: number; local_matches: number;
  already_published: number; missing: number | null; published: number; failed: number; skipped: number;
  github_matches: number | null; updated?: number; error: string | null;
  latest: { match_id: string; started_at: string; result: string } | null;
  failures: { match_id: string; started_at: string; reason: string }[];
  duration_ms?: number; timings_ms?: Record<string, number>; import_cached?: boolean;
}
export type SyncJob = TaskJob<SyncResult>;
export function syncButtonLabel(job: SyncJob) {
  if(job.status==='needs_recovery')return '回放任务需要核对';
  if (job.status === 'running') {
    if (job.progress?.phase === 'publishing') return '正在准备发布…';
    if (job.progress?.phase === 'uploading') return '正在上传…';
    if (job.progress?.phase === 'remote') return '正在核对远端…';
    if (job.progress?.phase === 'security') return '正在检查安全…';
    if (job.progress?.phase === 'cards') return '正在补齐卡牌…';
    if (job.progress?.phase === 'generating' && job.progress.total) return `正在准备 ${job.progress.completed ?? 0}/${job.progress.total}…`;
    return '正在扫描…';
  }
  if (job.status === 'partial') return '部分同步失败';
  if (job.status === 'failed') return '同步失败';
  if (job.status === 'succeeded') return job.result?.published ? `已同步 ${job.result.published} 场` : job.result?.updated ? `已更新 ${job.result.updated} 场` : '已是最新';
  return '同步回放';
}

/** Structured API client; resume reads current server work without starting another upload. */
export function createReplaySyncClient(request: typeof fetch = fetch, wait?: (signal?: AbortSignal) => Promise<void>) {
  return createTaskClient<SyncResult>('/api/sync', 'sync', request, wait);
}
