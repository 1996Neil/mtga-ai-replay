import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistory, normalizeReplay } from '../src/lib/canonicalAdapter.ts';
import { useReplayStore } from '../src/store/replayStore.ts';

function games(id = 'history-A', count = 2) {
  return normalizeReplay({ match: { id, event: 'Jump In', result: 'Unknown' }, games: [1, 2].map(game_number => ({ game_number,
    steps: Array.from({ length: count }, (_, index) => ({ anchor: `T${index + 1}-A1`, turn: index + 1, event: { type: 'pass' } })),
  })) });
}

test('same-match refresh preserves game, anchor, play/pause, speed and before/after preference', () => {
  const store = useReplayStore;
  store.getState().setMatches(games('history-A', 3)); store.getState().selectMatch(1); store.getState().goToAnchor('T2-A1');
  store.getState().setSpeed(2); store.getState().setViewBefore(true); store.getState().togglePlay();
  assert.equal(store.getState().refreshMatches(games('history-A', 4)), true);
  assert.equal(store.getState().currentMatch()?.gameNumber, 2);
  assert.equal(store.getState().currentStep()?.anchor, 'T2-A1');
  assert.equal(store.getState().isPlaying, true); assert.equal(store.getState().playbackSpeed, 2); assert.equal(store.getState().viewBefore, true);
  store.getState().pause(); assert.equal(store.getState().refreshMatches(games('history-A', 5)), true); assert.equal(store.getState().isPlaying, false);
});

test('an old background response cannot replace a newly selected match or remove its anchor', () => {
  const store = useReplayStore;
  store.getState().setMatches(games('history-B')); store.getState().goToAnchor('T2-A1');
  assert.equal(store.getState().refreshMatches(games('history-A', 4)), false);
  assert.equal(store.getState().currentMatch()?.matchId, 'history-B');
  assert.equal(store.getState().refreshMatches(games('history-B', 1)), false);
  assert.equal(store.getState().currentStep()?.anchor, 'T2-A1');
});

test('history revision detects changed state with unchanged match ID and game count; older providers remain readable', () => {
  const entries = [{ id: 'history-A', started_at: '2026-10-05T00:00:00Z', game_count: 2, replay_revision: 'first' }];
  assert.equal(normalizeHistory(entries)[0].revision, 'first');
  entries[0].replay_revision = 'second'; assert.equal(normalizeHistory(entries)[0].revision, 'second');
  assert.ok(normalizeHistory([{ id: 'old-provider', result: 'Win' }])[0].revision);
});
