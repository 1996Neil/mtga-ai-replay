import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReplay } from '../src/lib/canonicalAdapter.ts';
import { observationGroup, observationGroups } from '../src/lib/observationGroups.ts';
import { useReplayStore } from '../src/store/replayStore.ts';

const fixture = () => normalizeReplay({ match: { id: 'synthetic-observations' }, games: [{
  states: { S1: { turn: 1 }, S2: { turn: 1 }, S3: { turn: 2 } },
  steps: ['S1', 'S2', 'S2', 'S2', 'S3'].map((id, i) => ({
    state_id: id, anchor: `T1-A${i + 1}`, before_state_id: i ? 'S1' : undefined,
    event: { type: i === 1 ? 'damage' : i === 2 ? 'dies' : 'state' },
  })),
}] })[0];

test('normal playback traverses observations once while every individual event anchor stays reachable', () => {
  const match = fixture(), store = useReplayStore.getState();
  store.setMatches([match]); store.stepForward();
  assert.equal(useReplayStore.getState().currentStepIndex, 1);
  store.stepForward(); assert.equal(useReplayStore.getState().currentStepIndex, 4);
  store.stepBackward(); assert.equal(useReplayStore.getState().currentStepIndex, 1);
  assert.equal(store.goToAnchor('T1-A3'), true);
  assert.equal(useReplayStore.getState().currentStepIndex, 2);
  store.stepForward(); assert.equal(useReplayStore.getState().currentStepIndex, 4);
  assert.equal(observationGroup(match.steps, 2).steps.length, 3);
  assert.deepEqual(observationGroups(match.steps).map(group => [group.start, group.end]), [[0, 0], [1, 3], [4, 4]]);
});

test('steps lacking state IDs are never pooled and repeated noncontiguous states stay separate', () => {
  const match = fixture();
  delete match.steps[1].stateId; delete match.steps[2].stateId;
  assert.equal(observationGroup(match.steps, 1).steps.length, 1);
  assert.equal(observationGroup(match.steps, 2).steps.length, 1);
  match.steps[4].stateId = 'S1';
  assert.equal(observationGroup(match.steps, 4).steps.length, 1);
});
