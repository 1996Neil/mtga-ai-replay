import { LocalTaskButton } from './LocalTaskButton';
import { syncButtonLabel } from '../lib/replaySync';
import type { SyncResult } from '../lib/replaySync';
export function ReplaySyncButton() {
  return <LocalTaskButton<SyncResult> path="/api/sync" action="sync" capability="replay-sync" label={syncButtonLabel}
    extra={job => job.result?.failures?.length ? <details><summary>未完成的回放 ({job.result.failures.length})</summary>{job.result.failures.map((failure, index) => <p key={index}>{failure.started_at ?? '时间未知'}：{failure.reason}</p>)}</details> : null}
    hint="同步本地和线上新增或变化的回放，按本地保留天数执行。"
    describe={job => job.result ? `回放${job.status === 'succeeded' ? '同步完成' : '部分或全部未完成'}：上传 ${job.result.published} 场 · 下载 ${job.result.downloaded ?? 0} 场 · 更新 ${job.result.updated ?? 0} 场 · 失败 ${job.result.failed} 场 · 本地 ${job.result.local_matches} 场。` : '同步本地和线上变化；本地记录无需等待上传即可查看。'} />;
}
