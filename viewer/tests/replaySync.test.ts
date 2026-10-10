import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplaySyncClient, syncButtonLabel } from '../src/lib/replaySync.ts';
import type { SyncJob, SyncResult } from '../src/lib/replaySync.ts';

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return { status: 'succeeded', new_matches: 0, local_matches: 10, already_published: 10, missing: 0,
    published: 0, failed: 0, skipped: 0, github_matches: 10, latest: null, error: null, failures: [], ...overrides };
}
test('no new games displays 已是最新 using structured API results', async () => {
  const responses: SyncJob[] = [{ id: 'job', status: 'running', progress: { phase: 'scanning' } }, { id: 'job', status: 'succeeded', result: result() }];
  const calls: RequestInit[] = [], observed: string[] = [];
  const request = (async (_url, options) => { calls.push(options!); return new Response(JSON.stringify(responses.shift())); }) as typeof fetch;
  const job = await createReplaySyncClient(request, async () => {}).run(value => observed.push(syncButtonLabel(value)));
  assert.deepEqual(observed, ['正在扫描…', '已是最新']); assert.equal(job.result?.missing, 0);
  assert.equal(calls[0].method, 'POST'); assert.deepEqual(calls[0].headers, { 'X-MTGA-Replay-Action': 'sync' }); assert.equal(calls[0].body, undefined);
});
test('rapid calls share one task and report both new games', async () => {
  let posts = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const request = (async (_url, options) => {
    if (options?.method === 'POST') { posts++; await gate; }
    return new Response(JSON.stringify({ id: 'job', status: 'succeeded', result: result({ local_matches: 12, missing: 2, published: 2, new_matches: 2, github_matches: 12 }) }));
  }) as typeof fetch;
  const client = createReplaySyncClient(request, async () => {});
  const first = client.run(() => {}), second = client.run(() => {});
  assert.equal(first, second); assert.equal(posts, 1); release();
  assert.equal(syncButtonLabel(await first), '已同步 2 场');
});
test('partial failure remains explicit while retaining successful games and short error', async () => {
  const terminal: SyncJob = { id: 'job', status: 'partial', error: '部分回放未完成同步，请查看详情。',
    result: result({ status: 'partial', published: 1, failed: 1, failures: [{ match_id: 'bad', started_at: '2026-10-01', reason: 'No steps' }] }) };
  const request = (async () => new Response(JSON.stringify(terminal))) as typeof fetch;
  const job = await createReplaySyncClient(request).run(() => {});
  assert.equal(syncButtonLabel(job), '部分同步失败'); assert.equal(job.result?.published, 1); assert.equal(job.result?.failures[0].reason, 'No steps');
  assert.equal(syncButtonLabel({ id: 'job', status: 'running', progress: { phase: 'generating', completed: 1, total: 2 } }), '正在准备 1/2…');
});
test('old backend failure is actionable; aborted polling stops without another request', async () => {
  const unavailable = (async () => new Response('', { status: 405 })) as typeof fetch;
  await assert.rejects(createReplaySyncClient(unavailable).run(() => {}), /重启 Viewer/);
  const controller = new AbortController(); let requests = 0;
  const request = (async () => { requests++; return new Response(JSON.stringify({ id: 'job', status: 'running' })); }) as typeof fetch;
  await assert.rejects(createReplaySyncClient(request).run(() => controller.abort(), controller.signal), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('preparation, safety and actual upload remain distinct; existing updates have an explicit count', () => {
 for (const [phase,label] of [['publishing','正在准备发布…'],['security','正在检查安全…'],['remote','正在核对远端…'],['cards','正在补齐卡牌…'],['uploading','正在上传…']]) {
  assert.equal(syncButtonLabel({id:'job',status:'running',progress:{phase,completed:1,total:1}}),label);
 }
 assert.equal(syncButtonLabel({id:'job',status:'running',progress:{phase:'generating',completed:1,total:1}}),'正在准备 1/1…');
 assert.equal(syncButtonLabel({id:'job',status:'succeeded',result:result({updated:1})}),'已更新 1 场');
});
