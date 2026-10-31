import { LocalTaskButton } from './LocalTaskButton';
import type { TaskJob } from '../lib/taskClient';
interface CollectionResult { local_updated: boolean; synced: boolean; summary: { card_kinds?: number; total_quantity?: number }; error?: string | null; }
function label(job: TaskJob<CollectionResult>) {
  if(job.status==='needs_recovery')return '收藏任务需要核对';
  if (job.status === 'running') return job.progress?.phase === 'uploading' ? '正在上传收藏…' : '正在更新收藏…';
  if (job.status === 'succeeded') return '收藏已更新';
  if (job.status === 'partial') return '收藏待上传';
  if (job.status === 'failed') return '收藏更新未完成';
  return '更新收藏';
}
export function CollectionUpdateButton({ accountKey, accountLabel }: { accountKey?: string; accountLabel?: string }) {
  const identified = /^[a-f0-9]{64}$/.test(accountKey ?? '');
  return <LocalTaskButton<CollectionResult> path="/api/collection" action="collection-update" capability="collection-update" label={label} retryUpload
    accountKey={identified ? accountKey : 'unassigned'} accountLabel={accountLabel}
    disabledReason={identified ? undefined : '请选择已识别的游戏账号；未分类旧收藏不会自动分配。'}
    hint={`只更新「${accountLabel ?? '所选账号'}」的收藏。请确认 Arena 登录同一账号并停在首页或收藏页。读取授权仍在本机终端完成。`}
    describe={job => job.result ? `${job.result.synced ? '收藏已更新并上传' : '本地收藏已更新，上传未完成'}：${job.result.summary.card_kinds ?? '?'} 种 / ${job.result.summary.total_quantity ?? '?'} 张。`
      : `当前收藏归属：${accountLabel ?? '未选择账号'}。旧的未分类收藏保留，不会作为本账号的收藏。若提示读取授权，请双击桌面的“更新MTGA收藏.command”在本机终端授权。`} />;
}
