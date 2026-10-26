#!/usr/bin/env node
import { getPublishedCoachIndex } from '../src/coach-sync.mjs';
try {
  const started = performance.now();
  const result = await getPublishedCoachIndex({ fastSync: false });
  console.log(JSON.stringify({ audited: true, commit: result.commit,
    matches: result.index.matches.length, duration_ms: Math.round(performance.now() - started) }));
} catch {
  console.error('完整历史检查未完成；没有上传或删除数据。');
  process.exitCode = 1;
}
