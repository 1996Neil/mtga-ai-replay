import { LocalTaskButton } from './LocalTaskButton';
import type { TaskJob } from '../lib/taskClient';
interface CollectionResult { local_updated: boolean; synced: boolean; summary: { card_kinds?: number; total_quantity?: number }; error?: string | null; }
function label(job: TaskJob<CollectionResult>) {
  if (job.status === 'running') return job.progress?.phase === 'uploading' ? '正在上传收藏…' : '正在更新收藏…';
  if (job.status === 'succeeded') return '收藏已更新';
  if (job.status === 'partial') return '收藏待上传';
  if (job.status === 'failed') return '收藏更新未完成';
  return '更新收藏';
}
export function CollectionUpdateButton() {
  return <LocalTaskButton<CollectionResult> path="/api/collection" action="collection-update" capability="collection-update" label={label} retryUpload
    hint="请让 Arena 已登录并停在首页或收藏页。读取授权仍在本机终端完成；网页不收密码。更新后上传至已配置的私人仓库。"
    describe={job => job.result ? `${job.result.synced ? '收藏已更新并上传' : '本地收藏已更新，上传未完成'}：${job.result.summary.card_kinds ?? '?'} 种 / ${job.result.summary.total_quantity ?? '?'} 张。`
      : '请让 Arena 已登录并停在首页或收藏页。若提示读取授权，请双击桌面的“更新MTGA收藏.command”在本机终端授权，再回此处更新。'} />;
}
