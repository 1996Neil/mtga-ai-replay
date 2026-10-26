import { LocalTaskButton } from './LocalTaskButton';
import { syncButtonLabel } from '../lib/replaySync';
import type { SyncResult } from '../lib/replaySync';
export function ReplaySyncButton() {
  return <LocalTaskButton<SyncResult> path="/api/sync" action="sync" capability="replay-sync" label={syncButtonLabel}
    extra={job => job.result?.failures?.length ? <details><summary>未完成的回放 ({job.result.failures.length})</summary>{job.result.failures.map((failure, index) => <p key={index}>{failure.started_at ?? '时间未知'}：{failure.reason}</p>)}</details> : null}
    hint="只同步新增或变化的回放；先确认 Git 上传，再更新本地。失败会保留待发送记录。"
    describe={job => job.result ? `回放${job.status === 'succeeded' ? '同步完成' : '部分或全部未完成'}：新增 ${job.result.published} 场 · 更新 ${job.result.updated ?? 0} 场 · 失败 ${job.result.failed} 场 · 本地 ${job.result.local_matches} 场。` : '先上传 Git，再更新本地回放。'} />;
}
