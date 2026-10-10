import { LocalTaskButton } from './LocalTaskButton';
import { syncButtonLabel } from '../lib/replaySync';
import type { SyncResult } from '../lib/replaySync';
export function ReplaySyncButton() {
  return <LocalTaskButton<SyncResult> path="/api/sync" action="sync" capability="replay-sync" label={syncButtonLabel}
    extra={job => job.result?.failures?.length ? <details><summary>未完成的回放 ({job.result.failures.length})</summary>{job.result.failures.map((failure, index) => <p key={index}>{failure.started_at ?? '时间未知'}：{failure.reason}</p>)}</details> : null}
    hint="上传已归档回放；任务在后台运行，关闭页面后仍会继续，重开可查看结果。"
    describe={job => job.result ? `回放${job.status === 'succeeded' ? '上传完成' : '部分或全部未完成'}：新增 ${job.result.published} 场 · 更新 ${job.result.updated ?? 0} 场 · 失败 ${job.result.failed} 场 · 本地 ${job.result.local_matches} 场。` : '上传已归档的回放。'} />;
}
