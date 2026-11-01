import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createTaskClient, taskPause } from '../lib/taskClient';
import type { TaskJob } from '../lib/taskClient';

export function LocalTaskButton<Result>({ path, action, capability, label, describe, retryUpload = false, hint, extra, accountKey, accountLabel, disabledReason }:
  { path: '/api/sync' | '/api/collection'; action: 'sync' | 'collection-update'; capability: string;
    label: (job: TaskJob<Result>) => string; describe: (job: TaskJob<Result>) => string; retryUpload?: boolean; hint: string; extra?: (job: TaskJob<Result>) => ReactNode; accountKey?: string; accountLabel?: string; disabledReason?: string }) {
  const [available, setAvailable] = useState(false), [job, setJob] = useState<TaskJob<Result>>({ id: null, status: 'idle' });
  const [details, setDetails] = useState(false), [lost, setLost] = useState(false), [starting, setStarting] = useState(true), [requestError, setRequestError] = useState('');
  const busy = useRef(false), controller = useRef<AbortController | null>(null);
  const client = useMemo(() => createTaskClient<Result>(path, action, fetch, taskPause, accountKey), [path, action, accountKey]);
  function observe(value: TaskJob<Result>) {
    setJob(value); setStarting(false);
  }
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const response = await fetch('/api/health', { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]), cache: 'no-store' });
          if (!response.ok) throw new Error('Health unavailable');
          const health = await response.json();
          if (abort.signal.aborted) return;
          const supported = Boolean(health.capabilities?.includes(capability)); setAvailable(supported); setStarting(false); setLost(false);
          if (supported) { busy.current = true; await client.resume(observe, abort.signal, setLost).finally(() => { busy.current = false; }); }
          return;
        } catch {
          if (abort.signal.aborted) return;
          setStarting(false); setLost(true);
          try { await taskPause(abort.signal); } catch { return; }
        }
      }
    })();
    return () => { abort.abort(); controller.current?.abort(); busy.current = false; };
  }, [client, capability]);
  async function start(retry = false) {
    if (busy.current || job.status==='needs_recovery') return;
    if(action==='collection-update'&&!retry&&!window.confirm(`即将更新「${accountLabel ?? '所选账号'}」的收藏。读取器无法自动证明账号身份，请确认 Arena 当前登录的就是这个账号。是否继续？`))return;
    busy.current = true;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setRequestError(''); setDetails(true); setStarting(true);
    try { await client.run(observe, abort.signal, setLost, retry); }
    catch (error) { if (!abort.signal.aborted) { setRequestError(error instanceof Error ? error.message : '任务状态未知，请重新打开页面查看。'); setStarting(false); } }
    finally { busy.current = false; }
  }
  async function reconcile() {
    if(busy.current)return;busy.current=true;
    const abort=new AbortController();controller.current=abort;setStarting(true);setRequestError('');
    try{await client.reconcile(observe,abort.signal,setLost);}catch{setRequestError('任务尚不能确认，请人工核对。');}finally{busy.current=false;setStarting(false);}
  }
  const running = job.status === 'running', success = job.status === 'succeeded';
  const buttonLabel = label(running || details || job.status === 'needs_recovery' ? job : { id: null, status: 'idle' });
  return <div className="replay-sync">
    <button type="button" className="sync-button" disabled={starting || !available || lost || Boolean(disabledReason)} aria-busy={running || starting} aria-label={buttonLabel} aria-expanded={details} data-status={job.status}
      title={disabledReason ?? (available ? hint : '当前服务不支持此功能，请更新或重启 Replay 2.0。')} onClick={() => { if (running || job.status === 'needs_recovery') setDetails(true); else void start(); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{success && details ? <path d="m5 12 4 4 10-10" /> : <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 14 6M18 18a8 8 0 0 1-14-6" /></>}</svg>
      <span role="status" aria-live="polite">{buttonLabel}</span>
    </button>
    {details && <div className="sync-details" role={job.status === 'failed' || job.status === 'partial' ? 'alert' : 'status'}>
      <button type="button" aria-label={`关闭${capability === 'replay-sync' ? '同步' : '收藏'}提示`} onClick={() => { setDetails(false); setRequestError(''); }}>×</button>
      {lost ? <p>页面连接中断，后台任务状态暂时未知。正在重新连接；关闭页面不会取消后台任务。</p> : <p>{running ? `${label(job)} 已用 ${Math.floor((job.elapsed_ms ?? 0) / 1000)} 秒。可以关闭页面，重开后查看结果。` : describe(job)}</p>}
      {requestError && <p>{requestError}</p>}
      {job.error && <p>{job.error}</p>}
      {job.progress?.timings_ms && <details><summary>各阶段耗时</summary><p>{Object.entries(job.progress.timings_ms).map(([phase, ms]) => `${({ waiting: '等待同步通道', security: '安全检查', cards: '补齐卡牌', generating: '生成文件', remote: '核对远端', uploading: '上传', publishing: '准备发布', scanning: '扫描', comparing: '比较' } as Record<string,string>)[phase] ?? phase} ${Math.round(ms / 1000)}秒`).join(' · ')}</p></details>}
      {job.status==='needs_recovery'&&capability==='replay-sync'&&<button type="button" className="standard-button" disabled={starting||lost} onClick={()=>void reconcile()}>核对已发布回放</button>}
      {extra?.(job)}
      {job.notification?.attempted && <p className="task-note">{job.notification.accepted ? '已提交系统通知；是否显示由 macOS 通知设置决定。' : '系统通知未能提交；此处保留完成结果。'}</p>}
      {!running && job.status !== 'idle' && job.status !== 'needs_recovery' && <button type="button" className="standard-button task-retry" disabled={starting || lost} onClick={() => void start(retryUpload && job.status === 'partial')}>{retryUpload && job.status === 'partial' ? '重试上传收藏' : capability === 'replay-sync' ? '再次同步回放' : '再次更新收藏'}</button>}
    </div>}
  </div>;
}
