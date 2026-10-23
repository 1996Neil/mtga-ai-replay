#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { syncDraftCapture } from '../src/draft-sync.mjs';
const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
try { console.log(JSON.stringify(await syncDraftCapture({ dataDir: values['data-dir'] }), null, 2)); }
catch { console.error('轮抽 Git 备份未完成；本地记录保留。检查网络、私有仓库配置及同步队列后重试。'); process.exitCode = 1; }
