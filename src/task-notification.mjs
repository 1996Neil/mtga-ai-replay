import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const SCRIPT = 'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Fixed local completion messages; no replay identities, paths, credentials or shell interpolation. */
export async function notifyViewerTask(kind, job, { platform = process.platform, run = execute } = {}) {
  if (platform !== 'darwin') return { attempted: false, accepted: false };
  const title = kind === 'collection' ? 'Replay 2.0 · 收藏' : 'Replay 2.0 · 回放';
  const message = job.status === 'succeeded'
    ? kind === 'collection' ? '收藏更新并上传完成。' : `回放上传完成：新增 ${count(job.result?.published)} 场，更新 ${count(job.result?.updated)} 场。`
    : job.status === 'partial' ? '任务部分完成，请打开 Replay 2.0 查看保留结果和重试入口。' : '任务未完成，请打开 Replay 2.0 查看原因。';
  try {
    await run('/usr/bin/osascript', ['-e', SCRIPT, title, message], { timeout: 3000, maxBuffer: 4096, encoding: 'utf8' });
    // Exit success confirms only OS acceptance; macOS may suppress the banner.
    return { attempted: true, accepted: true };
  } catch { return { attempted: true, accepted: false }; }
}
