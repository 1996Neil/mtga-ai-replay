import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekModelProvider, PaidModelBudget, PlanModelProvider, BudgetLedger, DEEPSEEK_CEILINGS } from '../src/live-coach/providers/index.mjs';
import { parseSelection } from '../src/live-coach/providers/selection.mjs';

// Fake transport, fake keys and synthetic grants only. No model quality is graded here.
const candidates = [{ action_id: 'checked-A', immutable_facts: { damage: 3 } }, { action_id: 'checked-B' }];
const grant = { approved: true, provider: 'deepseek', model: 'deepseek-flash', metadata: true, inference: true,
  ...DEEPSEEK_CEILINGS, expiresAt: '2099-01-01T00:00:00Z' };
const paidBudget = options => new PaidModelBudget({ grant, ...options });
const catalog = { object: 'list', data: [{ id: 'deepseek-flash', name: 'Official fake catalog name' }] };
const completed = (content = '{"action_id":"checked-A","reason":"current candidate"}', finish_reason = 'stop') => ({
  model: 'deepseek-flash', choices: [{ finish_reason, message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
const make = (fetchImpl, budget = paidBudget()) => new DeepSeekModelProvider({ apiKey: 'synthetic-key', budget, model: 'deepseek-flash', fetchImpl });
const response = value => Response.json(value);
const deferred = () => { let resolve; const promise = new Promise(res => { resolve = res; }); return { promise, resolve }; };

test('DeepSeek is blocked before metadata or inference with no separate grant, even with a key and Phase 1 budget', async () => {
  let calls = 0;
  for (const budget of [new PaidModelBudget(), paidBudget({ grant: { ...grant, approved: false } }), new BudgetLedger({ grant: { approved: true, plan: true, maxPlanRequests: 20 } })]) {
    const model = make(async () => { calls++; }, budget);
    await assert.rejects(model.availableModels()); await assert.rejects(model.select({ state: {}, candidates }));
  }
  assert.equal(calls, 0);
  assert.throws(() => paidBudget({ grant: { ...grant, expiresAt: '2020-01-01T00:00:00Z' } }).reserve('deepseek-flash', 100), { code: 'paid_model_not_authorized' });
  assert.throws(() => paidBudget({ grant: { ...grant, maxRequests: 13 } }).reserve('deepseek-flash', 100), { code: 'paid_model_not_authorized' });
});

test('DeepSeek official catalog and JSON request use fixed endpoints, no redirects and bounded non-thinking output', async () => {
  const calls = [], budget = paidBudget();
  const model = make(async (url, options) => { calls.push({ url, options }); return response(url.endsWith('/models') ? catalog : completed()); }, budget);
  const selected = await model.select({ state: { current_only: true }, candidates });
  assert.equal(selected.action_id, 'checked-A'); assert.equal(selected.provider, 'deepseek'); assert.equal(selected.model, 'deepseek-flash');
  assert.deepEqual(calls.map(row => row.url), ['https://api.deepseek.com/models', 'https://api.deepseek.com/chat/completions']);
  for (const { options } of calls) { assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer synthetic-key'); }
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.max_tokens, 256); assert.equal(body.stream, false);
  assert.deepEqual(body.response_format, { type: 'json_object' }); assert.match(body.messages[0].content, /JSON/);
  assert.equal(body.tools, undefined); assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(JSON.parse(body.messages[1].content), { state: { current_only: true }, candidates });
  assert.equal(budget.summary().requests, 1); assert.equal(budget.summary().actualUsd, null);
  assert.equal(budget.data.entries[0].usage.input_tokens, 20);
});

test('unavailable models, malformed catalogs, incomplete outputs and invented speech cannot produce a selection', async () => {
  let inference = 0;
  const missing = make(async url => { if (!url.endsWith('/models')) inference++; return response({ object: 'list', data: [] }); });
  await assert.rejects(missing.select({ state: {}, candidates }), { code: 'model_unavailable' }); assert.equal(inference, 0);
  await assert.rejects(make(async () => response({ models: [] })).availableModels(), { code: 'invalid_catalog' });
  for (const payload of [completed('{"action_id":"unknown"}'), completed('{"action_id":"checked-A","speech":"bad"}'), completed('invalid'),
    completed('{"action_id":"checked-A"}', 'length'), { ...completed(), model: 'other-model' }]) {
    const budget = paidBudget(), model = make(async url => response(url.endsWith('/models') ? catalog : payload), budget);
    await assert.rejects(model.select({ state: {}, candidates })); assert.equal(budget.data.entries[0].status, 'failed_usage_unknown');
    assert.ok(budget.summary().reservedUsd > 0);
  }
  assert.throws(() => parseSelection('{"action_id":null,"reason":1}', candidates));
  assert.throws(() => parseSelection(' '.repeat(8193), candidates), { code: 'model_output_too_large' });
});

test('paid budget persists before calls, enforces bytes/request/cash limits and never refunds cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mtga-paid-contract-'));
  try {
    const filePath = join(directory, 'usage.json'), budget = paidBudget({ filePath, grant: { ...grant, maxRequests: 1 } });
    const first = budget.reserve('deepseek-flash', 100); budget.finish(first, { status: 'canceled_usage_unknown' });
    const resumed = paidBudget({ filePath, grant: { ...grant, maxRequests: 1 } });
    assert.equal(resumed.summary().requests, 1); assert.ok(resumed.summary().reservedUsd > 0);
    assert.throws(() => resumed.reserve('deepseek-flash', 100), { code: 'budget_exhausted' });
    assert.throws(() => paidBudget().reserve('deepseek-flash', 65537), { code: 'model_input_too_large' });
    assert.throws(() => paidBudget({ grant: { ...grant, maxUsd: 0.000001 } }).reserve('deepseek-flash', 100), { code: 'budget_exhausted' });
    const lockPath = join(directory, 'locked.json'); writeFileSync(`${lockPath}.lock`, '', { mode: 0o600 });
    assert.throws(() => paidBudget({ filePath: lockPath }).reserve('deepseek-flash', 100), { code: 'budget_busy' });
    let calls = 0;
    const model = make(async url => { if (!url.endsWith('/models')) calls++; return response(catalog); }, resumed);
    await assert.rejects(model.select({ state: {}, candidates }), { code: 'budget_exhausted' }); assert.equal(calls, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('DeepSeek cancellation discards a late success, keeps its reservation, and prevents concurrent selection', async () => {
  const late = deferred(), budget = paidBudget(), abort = new AbortController(); let signal;
  const model = make(async (url, options) => { if (url.endsWith('/models')) return response(catalog); signal = options.signal; return late.promise; }, budget);
  const pending = model.select({ state: {}, candidates, signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(model.select({ state: {}, candidates }), { code: 'model_busy' });
  abort.abort(); assert.equal(signal.aborted, true); late.resolve(response(completed()));
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(budget.data.entries[0].status, 'canceled_usage_unknown'); assert.equal(model.inflight, false);
});

test('SIWC supports an explicitly selected catalog model without changing account or falling back', async () => {
  const budget = new BudgetLedger({ grant: { approved: true, plan: true, maxPlanRequests: 2 } });
  const calls = [], model = new PlanModelProvider({ auth: { accessToken: async () => 'synthetic-token' }, budget, model: 'gpt-5.6-sol', siwc_plan_only_confirmed: true,
    fetchImpl: async (url, options) => { calls.push({ url, options });
      if (url.endsWith('/models')) return response({ models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }] });
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"action_id":"checked-A"}' }] }] } })}\n\n`);
    } });
  const selected = await model.select({ state: {}, candidates });
  assert.equal(selected.provider, 'siwc'); assert.equal(selected.model, 'gpt-5.6-sol');
  assert.equal(JSON.parse(calls[1].options.body).model, 'gpt-5.6-sol'); assert.equal(budget.data.entries[0].actualUsd, null);
  model.model = 'missing'; await assert.rejects(model.select({ state: {}, candidates }), { code: 'model_unavailable' }); assert.equal(calls.length, 2);
});
