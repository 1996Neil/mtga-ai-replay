import { useEffect, useMemo, useRef, useState } from 'react';
import { createReplaySyncClient, syncButtonLabel } from '../lib/replaySync';
import type { SyncJob } from '../lib/replaySync';

export function ReplaySyncButton({ refreshHistory }: { refreshHistory: () => Promise<number> }) {
  const [available, setAvailable] = useState(false);
  const [job, setJob] = useState<SyncJob>({ id: null, status: 'idle' });
  const [notice, setNotice] = useState(''), [showDetails, setShowDetails] = useState(false);
  const busy = useRef(false), controller = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const client = useMemo(() => createReplaySyncClient(), []);
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/health', { signal: abort.signal }).then(response => response.json())
      .then(health => { if (!abort.signal.aborted) setAvailable(Boolean(health.capabilities?.includes('replay-sync'))); }).catch(() => {});
    return () => abort.abort();
  }, []);
  useEffect(() => () => { controller.current?.abort(); if (timer.current) clearTimeout(timer.current); }, []);
  async function start() {
    if (busy.current) return;
    busy.current = true;
    if (timer.current) clearTimeout(timer.current);
    const abort = new AbortController(); controller.current = abort;
    setShowDetails(false); setNotice(''); setJob({ id: null, status: 'running', progress: { phase: 'scanning' } });
    try {
      const finished = await client.run(setJob, abort.signal);
      if (abort.signal.aborted) return;
      // Even a partial/offline sync may have imported new locally readable games.
      const added = await refreshHistory();
      if (abort.signal.aborted) return;
      setNotice(added ? `新增 ${added} 场回放；从比赛记录中选择查看。` : finished.error ?? (finished.result?.published ? `已同步 ${finished.result.published} 场回放。` : '回放记录已更新。'));
      setShowDetails(added > 0 || finished.status === 'partial' || finished.status === 'failed');
      if (finished.status === 'succeeded') timer.current = setTimeout(() => { setJob({ id: null, status: 'idle' }); setShowDetails(false); }, 6000);
    } catch (error) {
      if (abort.signal.aborted) return;
      setJob({ id: null, status: 'failed', error: error instanceof Error ? error.message : '同步未完成，请重试。' });
      setNotice('同步未完成。已归档的本地回放仍可查看。'); setShowDetails(true);
    } finally { busy.current = false; }
  }
  const running = job.status === 'running', success = job.status === 'succeeded';
  return <div className="replay-sync">
    <button type="button" className="sync-button" onClick={start} disabled={running || !available} aria-busy={running} aria-label={syncButtonLabel(job)} data-status={job.status} title={!available ? '当前后台同步不可用，请更新或重启 Replay 服务。' : job.error ?? '扫描本机日志并补齐 GitHub 回放，保持当前观看位置'}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{success ? <path d="m5 12 4 4 10-10" /> : <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 14 6M18 18a8 8 0 0 1-14-6" /></>}</svg>
      <span role="status" aria-live="polite">{syncButtonLabel(job)}</span>
    </button>
    {showDetails && <div className="sync-details" role={job.status === 'failed' || job.status === 'partial' ? 'alert' : 'status'}>
      <button type="button" aria-label="关闭同步提示" onClick={() => setShowDetails(false)}>×</button>
      <p>{notice}</p>
      {job.result && <p>同步成功 {job.result.published} 场 · 失败 {job.result.failed} 场 · 本地 {job.result.local_matches} 场</p>}
      {job.error && <p>{job.error}</p>}
      {!!job.result?.failures.length && <details><summary>查看失败详情</summary><ul>{job.result.failures.map(f => <li key={f.match_id}><time>{new Date(f.started_at).toLocaleString('zh-CN')}</time><br /><small>{f.match_id}</small><br />{f.reason}</li>)}</ul></details>}
    </div>}
  </div>;
}
