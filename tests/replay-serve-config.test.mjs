import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('desktop Replay launcher archives locally and enables asynchronous remote sync', async () => {
  const source = await readFile(new URL('../bin/mtga-replay-serve.mjs', import.meta.url), 'utf8');
  assert.match(source, /observeLocalLogs:\s*true/);
  assert.match(source, /autoSyncReplays:\s*true/);
});
