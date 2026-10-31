#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { defaultDataDir } from '../src/history.mjs';
import { validateSyncProxy } from '../src/sync-network.mjs';
import { atomicSyncWrite, safeSyncOutputParents } from '../src/coach-sync.mjs';

const { values } = parseArgs({ options: { 'https-proxy': { type: 'string' }, 'data-dir': { type: 'string' } } });
try {
  const dataDir = values['data-dir'] ?? defaultDataDir();
  const proxy = validateSyncProxy(values['https-proxy']);
  await safeSyncOutputParents(dataDir, 'sync-network.json');
  await atomicSyncWrite(join(dataDir, 'sync-network.json'), JSON.stringify({ https_proxy: proxy }) + '\n');
  console.log('已保存本机同步代理。仅用于 Replay 的 Git/GitHub 子进程，不修改系统网络设置。');
} catch {
  console.error('代理未保存：仅接受无用户名密码的本机 HTTP 代理和明确端口。');
  process.exitCode = 1;
}
