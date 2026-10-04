import test from 'node:test';
import assert from 'node:assert/strict';
import { CoachViewGuard } from '../src/lib/coachView.ts';
import type { CoachView } from '../src/lib/coachView.ts';

type Snapshot = { generation: number; enabled?: boolean; muted?: boolean };
const view = (match_id = 'first-match', game_number = 1, anchor = 'T6-A4'): CoachView => ({ match_id, game_number, anchor, boundary: 'after' });
const advice = (id: string, generation: number, current = view()) => ({ generation,
  advice: { advice_id: id, match_id: current.match_id, game_id: String(current.game_number) } });
const audio = (advice_id: string, generation: number) => ({ advice_id, generation });
function harness() {
  const calls: { action: string; value: any; resolve: (snapshot: Snapshot) => void; reject: (error: Error) => void }[] = [];
  const guard = new CoachViewGuard<Snapshot>((action, value) => new Promise<Snapshot>((resolve, reject) => {
    calls.push({ action, value, resolve, reject });
  }), 100);
  return { guard, calls };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function ready(current = view(), generation = 4) {
  const result = harness(); result.guard.setView(current);
  const reset = result.guard.invalidate(); result.calls[0].resolve({ generation, enabled: true, muted: false }); await reset;
  return result;
}

test('loading stops admission immediately and observes the new match only after invalidate', async () => {
  const { guard, calls } = await ready();
  assert.equal(guard.acceptAdvice(advice('old', 4)), true);
  assert.equal(guard.acceptAudio(audio('old', 4)), true);
  assert.equal(guard.setView(null), true);
  assert.equal(guard.ready, false);
  assert.equal(guard.acceptAdvice(advice('old', 4)), false);
  assert.equal(guard.acceptAudio(audio('old', 4)), false);
  const resetting = guard.invalidate();
  const next = view('second-match', 2); guard.setView(next);
  const observing = guard.observe(); await tick();
  assert.deepEqual(calls.map(call => call.action), ['invalidate', 'invalidate']);
  assert.equal(guard.acceptAdvice(advice('too-early', 5, next)), false);
  calls[1].resolve({ generation: 5, enabled: true, muted: false }); await resetting; await tick();
  assert.deepEqual(calls[2].value, { ...next, view_seq: 103 });
  calls[2].resolve({ generation: 5, enabled: true, muted: false });
  assert.deepEqual(await observing, { generation: 5, enabled: true, muted: false });
  assert.equal(guard.acceptAdvice(advice('old', 4)), false);
  assert.equal(guard.acceptAudio(audio('old', 4)), false);
  assert.equal(guard.acceptAdvice(advice('new', 5, next)), true);
  assert.equal(guard.acceptAudio(audio('new', 5)), true);
});

test('a failed match GET keeps the null view closed even when invalidate succeeds', async () => {
  const { guard, calls } = await ready(); guard.setView(null);
  const resetting = guard.invalidate(); calls[1].resolve({ generation: 5, enabled: true, muted: false }); await resetting;
  assert.equal(guard.ready, false);
  assert.equal(await guard.observe(), null);
  assert.equal(guard.acceptAdvice(advice('old', 5)), false);
  assert.equal(guard.acceptAudio(audio('old', 5)), false);
  assert.equal(calls.length, 2);
});

test('late observe successes and errors cannot restore a previous match', async () => {
  for (const failure of [false, true]) {
    const { guard, calls } = await ready();
    const oldObserve = guard.observe();
    guard.setView(null); const resetting = guard.invalidate();
    const next = view('new-match'); guard.setView(next); const newObserve = guard.observe();
    calls[2].resolve({ generation: 5 }); await resetting; await tick();
    calls[3].resolve({ generation: 5 }); await newObserve;
    assert.equal(guard.acceptAdvice(advice('current', 5, next)), true);
    if (failure) calls[1].reject(new Error('obsolete observe failed')); else calls[1].resolve({ generation: 4 });
    assert.equal(await oldObserve, null);
    assert.equal(guard.acceptAudio(audio('current', 5)), true);
    assert.equal(guard.acceptAudio(audio('obsolete', 4)), false);
  }
});

test('an intermediate match waiting for invalidate never sends observe after a second switch', async () => {
  const { guard, calls } = await ready(); guard.setView(null); const resetting = guard.invalidate();
  guard.setView(view('intermediate')); const intermediate = guard.observe();
  const latest = view('latest'); guard.setView(latest); const observing = guard.observe();
  calls[1].resolve({ generation: 5 }); await resetting; await tick();
  assert.equal(await intermediate, null); assert.equal(calls.length, 3);
  assert.equal(calls[2].value.match_id, 'latest');
  calls[2].resolve({ generation: 5 }); assert.notEqual(await observing, null);
});

test('failed invalidation keeps events closed and a later explicit retry can recover', async () => {
  const { guard, calls } = await ready(); guard.setView(null);
  const resetting = guard.invalidate(); guard.setView(view('new-match')); const observing = guard.observe();
  const failure = new Error('invalidate failed'); calls[1].reject(failure);
  await assert.rejects(resetting, failure); await assert.rejects(observing, failure);
  assert.equal(guard.ready, false); assert.equal(guard.needsInvalidation, true);
  assert.equal(guard.acceptAdvice(advice('blocked', 5, view('new-match'))), false);
  const retry = guard.invalidate(); calls[2].resolve({ generation: 5 }); await retry;
  assert.equal(guard.ready, true); assert.equal(calls[2].value.view_seq, 103);
});

test('the generation floor never drops when an invalidate response trails newer SSE', async () => {
  const { guard, calls } = await ready(); guard.setView(null); const resetting = guard.invalidate();
  const next = view('next'); guard.setView(next); assert.equal(guard.acceptGeneration(8), true);
  calls[1].resolve({ generation: 5 }); await resetting;
  assert.equal(guard.acceptGeneration(4), false);
  assert.equal(guard.acceptAdvice(advice('too-old', 5, next)), false);
  assert.equal(guard.acceptAdvice(advice('current', 8, next)), true);
  assert.equal(guard.acceptAudio(audio('current', 8)), true);
});

test('audio requires the accepted advice id, generation, current match and game', async () => {
  const { guard } = await ready(view('same-match', 2));
  assert.equal(guard.acceptAudio(audio('unannounced', 4)), false);
  assert.equal(guard.acceptAdvice(advice('wrong-match', 4, view('other-match', 2))), false);
  assert.equal(guard.acceptAdvice(advice('wrong-game', 4, view('same-match', 1))), false);
  assert.equal(guard.acceptAdvice(advice('valid', 4, view('same-match', 2))), true);
  assert.equal(guard.acceptAudio(audio('different-id', 4)), false);
  assert.equal(guard.acceptAudio(audio('valid', 3)), false);
  assert.equal(guard.acceptAudio(audio('valid', 5)), false);
  assert.equal(guard.acceptAudio(audio('valid', 4)), true);
  assert.equal(guard.acceptGeneration(5), true);
  assert.equal(guard.acceptAudio(audio('valid', 4)), false);
  assert.equal(guard.acceptAdvice(advice('latest', 5, view('same-match', 2))), true);
  guard.forgetAdvice(); assert.equal(guard.acceptAudio(audio('latest', 5)), false);
});

test('malformed generation cannot reopen the event gate after a reset', async () => {
  for (const generation of [undefined, -1, NaN, 1.5]) {
    const { guard, calls } = harness(); guard.setView(view()); const resetting = guard.invalidate();
    calls[0].resolve({ generation } as Snapshot);
    await assert.rejects(resetting, /未确认旧回放已失效/);
    assert.equal(guard.ready, false);
  }
});

test('forward replay keeps valid speech, while game changes and backward seeks require reset', async () => {
  const { guard } = await ready(); guard.acceptAdvice(advice('valid', 4));
  assert.equal(guard.setView(view('first-match', 1, 'T6-A5')), false);
  assert.equal(guard.acceptAudio(audio('valid', 4)), true);
  assert.equal(guard.setView(view('first-match', 1, 'T6-A4')), true);
  assert.equal(guard.ready, false); assert.equal(guard.acceptAudio(audio('valid', 4)), false);
  const game = await ready(); assert.equal(game.guard.setView(view('first-match', 2)), true);
  assert.equal(game.guard.ready, false);
});

test('confirmed live mode keeps its independent source lease without observing history', async () => {
  const { guard, calls } = harness(); guard.setView(view('history-match')); guard.setMode('live');
  assert.equal(guard.ready, true); assert.equal(guard.needsInvalidation, false);
  const live = view('official-log-match', 3);
  assert.equal(guard.acceptAdvice(advice('live-advice', 1, live)), true);
  assert.equal(guard.acceptAudio(audio('live-advice', 1)), true);
  assert.equal(guard.setView(null), false);
  assert.equal(guard.acceptAudio(audio('live-advice', 1)), true);
  assert.equal(await guard.observe(), null); assert.equal(calls.length, 0);
  guard.acceptGeneration(2); assert.equal(guard.acceptAudio(audio('live-advice', 1)), false);
});

test('initial invalidate returns the current enabled/muted status and opens loaded replay admission', async () => {
  for (const enabled of [false, true]) {
    const { guard, calls } = harness(); guard.setView(view());
    const resetting = guard.invalidate(); const observing = enabled ? guard.observe() : null;
    const snapshot = { generation: 1, enabled, muted: !enabled };
    calls[0].resolve(snapshot); assert.deepEqual(await resetting, snapshot); await tick();
    assert.equal(guard.ready, true);
    assert.equal(calls.length, enabled ? 2 : 1);
    if (observing) { calls[1].resolve(snapshot); assert.deepEqual(await observing, snapshot); }
  }
});

test('a refreshed muted client never observes an enabled server until explicit user enable', async () => {
  const { guard, calls } = harness(); guard.setView(view()); let enabledIntent = false;
  const resetting = guard.invalidate();
  assert.equal(await guard.observe(() => enabledIntent), null);
  calls[0].resolve({ generation: 1, enabled: true, muted: false }); await resetting;
  assert.equal(await guard.observe(() => enabledIntent), null); assert.equal(calls.length, 1);
  enabledIntent = true; const observing = guard.observe(() => enabledIntent);
  calls[1].resolve({ generation: 1, enabled: true, muted: false }); assert.notEqual(await observing, null);
});

test('mute while awaiting invalidation prevents the queued observe without changing source admission', async () => {
  const { guard, calls } = await ready(); guard.setView(null); const resetting = guard.invalidate();
  guard.setView(view('new-match')); let enabledIntent = true;
  const observing = guard.observe(() => enabledIntent); enabledIntent = false;
  calls[1].resolve({ generation: 5 }); await resetting;
  assert.equal(await observing, null); assert.equal(calls.length, 2); assert.equal(guard.ready, true);
});
