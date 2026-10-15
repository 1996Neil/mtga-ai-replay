import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEventName, formatMatchTime, draftRunStatusLabel, draftRunScoreMessage, usesCompletedZeroWinDefault } from '../src/lib/historyPresentation.ts';
import { normalizeDraftRuns } from '../src/lib/canonicalAdapter.ts';

test('history dates start with two-digit year and use local calendar day, including midnight', () => {
  assert.equal(formatMatchTime('2026-10-14T19:04:11.920Z', 'Asia/Shanghai'), '26/10/15 03:04');
  assert.equal(formatMatchTime('2025-12-31T16:00:00Z', 'Asia/Shanghai'), '26/01/01 00:00');
  assert.equal(formatMatchTime('2026-10-14T19:04:11.920Z', 'UTC'), '26/10/14 19:04');
  assert.equal(formatMatchTime('', 'UTC'), '时间未记录');
  assert.equal(formatMatchTime('invalid', 'UTC'), '时间未记录');
});

test('ended course and unverified score are independent in the display, with specific reasons', () => {
  const [run] = normalizeDraftRuns([{run_id:'synthetic',event:'QuickDraft_FRA',current_module:'Complete',
    status:'incomplete',score_verified:false,course_wins:3,course_losses:3,replay_wins:1,replay_losses:5,matches:[]}]);
  assert.equal(draftRunStatusLabel(run),'已结束 · 战绩待核对');
  assert.equal(draftRunScoreMessage(run),'结算记录：3胜3负；归档回放：1胜5负。两者不一致，轮抽归属及计数来源需要核查；列表暂按归档回放汇总。');
  assert.match(draftRunScoreMessage({...run,course_wins:null}),/未知胜3负.*缺少胜负计数/);
  assert.equal(draftRunStatusLabel({...run,course_wins:null}),'已结束 · 胜场总数未知');
  assert.match(draftRunScoreMessage({...run,course_wins:null,replay_wins:0}),/整轮总战绩未知.*无法排除归档漏场/);
  assert.equal(draftRunStatusLabel({...run,score_verified:true}),'已结束');
  assert.equal(draftRunScoreMessage({...run,score_verified:true}),'');
  assert.equal(draftRunStatusLabel({...run,current_module:'Play',status:'in_progress'}),'进行中 · 战绩待核对');
  assert.equal(draftRunStatusLabel({...run,current_module:null}),'状态待确认 · 战绩待核对');
});

test('all event displays hide only the trailing eight-digit date and preserve raw identifiers', () => {
  for (const name of ['QuickDraft_FRA', 'PremierDraft_FIN', 'TraditionalDraft_DSK']) {
    const raw = name + '_20261008';
    assert.equal(formatEventName(raw), name);
    assert.equal(raw, name + '_20261008');
  }
  assert.equal(formatEventName('QuickDraft_FRA_20261808'), 'QuickDraft_FRA');
  for (const name of ['Jump In', '标准排位', 'Event_20261008_Finals', 'Event_123', 'Event_123456789', '']) {
    assert.equal(formatEventName(name), name);
  }
});

test('completed three-loss course defaults missing wins to the archived zero without changing verification', () => {
  const [run] = normalizeDraftRuns([{run_id:'synthetic',event:'QuickDraft_FRA',current_module:'Complete',
    status:'incomplete',score_verified:false,course_wins:null,course_losses:3,replay_wins:0,replay_losses:3,
    matches:[1,2,3].map(n => ({id:'match-'+n,started_at:'2026-10-01T00:00:00Z',result:'Loss'}))}]);
  const before = JSON.stringify(run);
  assert.equal(usesCompletedZeroWinDefault(run),true);
  assert.equal(draftRunStatusLabel(run),'已结束');
  assert.equal(draftRunScoreMessage(run),'');
  assert.equal(run.replay_wins,0);
  assert.equal(run.course_wins,null);
  assert.equal(run.score_verified,false);
  assert.equal(JSON.stringify(run),before);
  for (const changed of [
    {...run,status:'in_progress' as const,current_module:'Play'},
    {...run,course_wins:1}, {...run,course_losses:null}, {...run,course_losses:2},
    {...run,replay_wins:1}, {...run,replay_losses:2}, {...run,matches:run.matches.slice(0,2)},
    {...run,matches:run.matches.map((match,n)=>n===0?{...match,result:'Unknown'}:match)},
  ]) {
    assert.equal(usesCompletedZeroWinDefault(changed),false);
    assert.notEqual(draftRunScoreMessage(changed),'');
  }
});
