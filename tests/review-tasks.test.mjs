import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewTasks } from '../src/review/review-tasks.mjs';
import { normalizeReplayReview, reviewFingerprint, reviewFingerprintAsync, reviewDecisionContext } from '../src/review/review-model.mjs';
const state = () => ({ activePlayer: 'me', priorityPlayer: 'opponent', players: {
  me: { hand: [{ name: 'Island', instance_id: 10 }], mana_pool: [{ color: 'Blue', amount: 1 }],
    battlefield: [{ name: 'Bear', instance_id: 11, is_blocking: true, blocked_attacker_ids: [22] }] },
  opponent: { hand: [{ name: 'Secret' }], battlefield: [{ name: 'Bear', instance_id: 22 }] } } });
const fixture = () => ({ match: { id: 'synthetic-task' }, warnings: ['global'], games: [{ game_number: 1, warnings: ['game'],
  steps: [{ anchor: 'T1-A1', event: { type: 'cast', actor: 'me', details: 'private-account', targets: [{ hidden: true, name: 'Secret' }] },
    state_before: state(), state: state() }] }] });
const raw = () => ({ summary: { headline: '离线测试', overview: '离线测试' }, notes: [{ anchor: 'T1-A1',
  severity: 'critical', confidence: 'high', title: '观察', observation: '观察', suggestion: '建议' }] });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
async function finish(tasks) { for (let i=0;i<80;i++) { if(tasks.snapshot('synthetic-task',1)?.status !== 'running') return; await new Promise(r=>setTimeout(r,3)); } throw new Error('Task did not finish'); }
function harness(generate) {
  let replay = fixture(), stored = null, writes = 0;
  const tasks = createReviewTasks({ loadReplay: async () => replay, readReview: async () => stored,
    writeReview: async v => { stored = v; writes++; }, generate, deadlineMs: 1000 });
  return { tasks, get writes() { return writes; }, change: fn => fn(replay) };
}
test('context reuses before-state and retains mana, priority and same-name combat IDs without raw private fields', () => {
  const r = fixture(), c = reviewDecisionContext(r,1,r.games[0].steps[0]);
  assert.equal(c.game_state.active_player,'me'); assert.equal(c.game_state.priority_player,'opponent');
  assert.equal(c.game_state.me.mana_pool[0].amount,1);
  assert.equal(c.game_state.me.battlefield[0].instance_id,11);
  assert.deepEqual(c.game_state.me.battlefield[0].blocked_attacker_ids,[22]);
  assert.ok(!JSON.stringify(c).includes('Secret')); assert.ok(!JSON.stringify(c).includes('private-account'));
  assert.equal(normalizeReplayReview(r,1,raw()).notes[0].severity,'tip');
});
test('streaming async fingerprint equals sync and invalidates on warnings and source mutations', async () => {
  const r=fixture(); assert.equal(await reviewFingerprintAsync(r.games[0],r.warnings),reviewFingerprint(r.games[0],r.warnings));
  const first=reviewFingerprint(r.games[0],r.warnings); r.warnings.push('more'); assert.notEqual(reviewFingerprint(r.games[0],r.warnings),first);
  const next=reviewFingerprint(r.games[0],r.warnings); r.games[0].steps[0].state_before.players.me.hand[0].name='Forest';
  assert.notEqual(reviewFingerprint(r.games[0],r.warnings),next);
});
test('POST preparation deduplicates before first await, publishes once and reuses report cache',async () => {
  let calls=0; const g=gate(); const h=harness(async (_r,{onProgress}) => { calls++; onProgress({phase:'decisions',completed:1,total:2}); await g.promise; return raw(); });
  const [a,b]=await Promise.all([h.tasks.start('synthetic-task',1),h.tasks.start('synthetic-task',1)]);
  assert.equal(a.code,202);assert.equal(a.task.id,b.task.id);assert.equal((await h.tasks.start('other',1)).code,409);
  g.resolve(); await finish(h.tasks); assert.equal(calls,1);assert.equal(h.writes,1);assert.equal((await h.tasks.read('synthetic-task',1)).status,'ready');
  await h.tasks.start('synthetic-task',1);await finish(h.tasks);assert.equal(calls,1);await h.tasks.close();
});
test('mutable provider cannot rebind a generated report to changed states',async () => {
  const g=gate(), entered=gate(); let start;
  const h=harness(async r => {start=r.games[0].steps[0].state_before.players.me.hand[0].name;entered.resolve();await g.promise;return raw();});
  await h.tasks.start('synthetic-task',1);await entered.promise;
  h.change(r=>r.games[0].steps[0].state_before.players.me.hand[0].name='Forest');g.resolve();await finish(h.tasks);
  assert.equal(start,'Island');assert.equal(h.tasks.snapshot('synthetic-task',1).status,'stale');assert.equal(h.writes,0);await h.tasks.close();
});
test('cancel and shutdown suppress late results and new jobs',async () => {
  const g=gate(),entered=gate();let received;
  const h=harness(async (_r,{signal})=>{received=signal;entered.resolve();await g.promise;return raw();});
  await h.tasks.start('synthetic-task',1);await entered.promise;h.tasks.cancel('synthetic-task',1);await finish(h.tasks);
  assert.equal(received.aborted,true);assert.equal(h.writes,0);await h.tasks.close();assert.equal((await h.tasks.start('synthetic-task',1)).code,503);
  g.resolve();await new Promise(r=>setTimeout(r,5));assert.equal(h.writes,0);
});
test('generation failure has explicit status and retains readable replay',async () => {
  const h=harness(async()=>{throw new Error('synthetic model failure');});await h.tasks.start('synthetic-task',1);await finish(h.tasks);
  const v=await h.tasks.read('synthetic-task',1);assert.equal(v.status,'missing');assert.equal(v.task.status,'failed');assert.equal(h.writes,0);await h.tasks.close();
});

test('deadline cancels an uncooperative generator without publishing or keeping shutdown alive', async () => {
  const r=fixture(), entered=gate(); let writes=0;
  const tasks=createReviewTasks({loadReplay:async()=>r,readReview:async()=>null,writeReview:async()=>{writes++;},
    generate:async()=>{entered.resolve();await new Promise(()=>{});},deadlineMs:30});
  await tasks.start('synthetic-task',1);await entered.promise;await finish(tasks);
  assert.equal(tasks.snapshot('synthetic-task',1).status,'cancelled');await tasks.close();assert.equal(writes,0);
});
