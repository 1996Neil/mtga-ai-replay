import test from 'node:test';
import assert from 'node:assert/strict';
import { tutorialEligibility } from '../src/tutorial-eligibility.mjs';
test('tutorial policy uses explicit event evidence and holds uncertain or contradictory metadata', () => {
  const cases = [
    [{ event_id: 'NPE_Tutorial_PlayFamiliar5' }, 'skip_tutorial'],
    [{ event_id: 'NPE_Tutorial_PlayFamiliar5', event: 'Ladder' }, 'hold_conflict'],
    [{ event_id: 'Ladder', event: '排位（赛制未知）' }, 'not_excluded_by_tutorial_rule'],
    [{ event: 'Play', opponent: 'Sparky', bot: true }, 'not_excluded_by_tutorial_rule'],
    [{ event_id: 'QuickDraft_FRA_20261008' }, 'not_excluded_by_tutorial_rule'],
    [{ opponent: 'Nicol Bolas' }, 'hold_unknown'],
    [{ event_id: 'NPE_Tutorial_NewUnknown' }, 'hold_unknown'],
    [{ event_id: 'Play', queue_id: {} }, 'hold_unknown'],
    [{ event_id: 'Play', event: 'NewEvent' }, 'hold_unknown'],
    [{}, 'hold_unknown'], [null, 'hold_unknown'], [[], 'hold_unknown'],
  ];
  for (const [metadata, expected] of cases) assert.equal(tutorialEligibility(metadata), expected);
});


test('known Midweek Magic tutorial classification compatibility is exact, not a prefix exemption', () => {
  const known = 'MWM_HistoricPauper_20261006';
  assert.equal(tutorialEligibility({ event_id: known, event: known }), 'not_excluded_by_tutorial_rule');
  assert.equal(tutorialEligibility({ event_id: 'MWM_HistoricPauper_20261013' }), 'hold_unknown');
  assert.equal(tutorialEligibility({ event_id: 'MWM_Unreviewed_20261006' }), 'hold_unknown');
  assert.equal(tutorialEligibility({ event_id: known, event: 'MWM_Unreviewed_20261006' }), 'hold_unknown');
  assert.equal(tutorialEligibility({ event_id: known, queue_id: 'NPE_Tutorial_PlayFamiliar5' }), 'hold_conflict');
  assert.equal(tutorialEligibility({ event_id: 'NPE_Tutorial_PlayFamiliar5', event: known }), 'hold_conflict');
});

// Same six parameter permutations as the independent classifier boundary audit;
// import the complete production module, with no patch extraction or VM shim.
const keys = ['event_id', 'queue_id', 'event'];
test('padded tutorial/ordinary aliases preserve conflict across field permutations and JSON reload',()=>{
 for (const tutorialKey of keys) for(const ordinaryKey of keys.filter(k=>k!==tutorialKey)) {
  const blankKey=keys.find(k=>k!==tutorialKey&&k!==ordinaryKey);
  const input={[tutorialKey]:' \tNPE_Tutorial_PlayFamiliar5\r\n',[ordinaryKey]:'\u00a0Play\u00a0',[blankKey]:' \t\r\n'};
  const before=JSON.stringify(input),reloaded=JSON.parse(before);
  const actual=tutorialEligibility(input),afterReload=tutorialEligibility(reloaded);
  assert.equal(actual,'hold_conflict');assert.equal(afterReload,'hold_conflict');assert.equal(JSON.stringify(input),before);
 }
});
