import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeReplayReview, reviewIsCurrent, selectReviewDecisions,
  reviewDecisionContext, reviewFingerprint } from '../src/review/review-model.mjs';
import { readReplayReview, writeReplayReview } from '../src/review/review-store.mjs';
import { createReplayReviewGenerator } from '../src/review/review-generator.mjs';

const before = {
  turn: 3, phase: 'Phase_Main1', step: 'Step_Main',
  players: { me: { life: 8, hand: [{ name: 'Spell Snare', arena_id: 11 }],
    battlefield: [{ name: 'Island', arena_id: 12 }], graveyard: [], exile: [] },
    opponent: { life: 15, hand: [{ hidden: true, name: 'Secret Opponent Bomb' }],
      hand_size: 4, battlefield: [{ name: 'Forest', arena_id: 14 }], graveyard: [], exile: [] } }, stack: [],
};
const replay = () => ({
  match: { id: 'synthetic-123' }, warnings: ['Some steps share a GRE message.'],
  games: [{ game_number: 1, states: {}, result: { outcome: 'Loss' },
    steps: [{ anchor: 'T3-A1', turn: 3, event: { actor: 'me', type: 'cast', card: { name: 'Spell Snare' } },
      state_before: before, state: { ...before, turn: 4 } },
      { anchor: 'T3-A2', turn: 3, event: { actor: 'opponent', type: 'cast',
        card: { hidden: true, name: 'Secret Opponent Bomb' } }, state_before: before },
      { anchor: 'T5-A1', turn: 5, event: { actor: 'me', type: 'attack' },
        state: { ...before, turn: 5 } /* no true before-state */ },
    ] }],
});
const sample = {
  summary: { headline: '关键回合的资源选择', overview: '日志仅能确认当前可见局面，不足以断言必胜。',
    strengths: ['保留了必要的防守资源'], improvements: ['重新审视反击时机'], limitations: [] },
  notes: [{ anchor: 'T3-A1', severity: 'tip', confidence: 'medium',
    boundary: 'before', title: '反击时机', observation: '选择了 Spell Snare。',
    suggestion: '可以比较保留 Spell Snare 的价值。', rationale: '目前可见的压力有限。',
    cards: ['Spell Snare', 'Secret Opponent Bomb'] }],
};

test('review stores exact English names and rejects unobserved opponent cards', () => {
  const record = normalizeReplayReview(replay(), 1, sample);
  assert.equal(record.notes.length, 1);
  assert.deepEqual(record.notes[0].cards, ['Spell Snare']);
  assert.equal(record.notes[0].boundary, 'before');
  assert.equal(record.summary.headline, sample.summary.headline);
  assert.equal(reviewIsCurrent(replay(), record), true);
});

test('invalid anchors and missing before-states are not relocated or fabricated', () => {
  const record = normalizeReplayReview(replay(), 1, { ...sample,
    notes: [...sample.notes, { ...sample.notes[0], anchor: 'T99-A99' },
      { ...sample.notes[0], anchor: 'T5-A1' }] });
  assert.deepEqual(record.notes.map(note => note.anchor), ['T3-A1']);
  assert.equal(selectReviewDecisions(replay().games[0]).length, 1);
  const context = reviewDecisionContext(replay(), 1, replay().games[0].steps[0]);
  assert.equal(JSON.stringify(context).includes('Secret Opponent Bomb'), false);
  assert.equal(context.game_state.me.hand[0].name, 'Spell Snare');
});

test('an updated replay invalidates annotations rather than showing them at an unrelated action', () => {
  const original = replay(), record = normalizeReplayReview(original, 1, sample);
  assert.equal(record.fingerprint, reviewFingerprint(original.games[0]));
  const changed = structuredClone(original);
  changed.games[0].steps[0].state_before.turn = 99;
  assert.equal(reviewIsCurrent(changed, record), false);
});

test('private SQLite review sidecar persists independently of replay history', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'review-storage-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.equal(await readReplayReview('synthetic-123', 1, { dataDir }), null);
  const record = normalizeReplayReview(replay(), 1, sample);
  await writeReplayReview(record, { dataDir });
  assert.deepEqual(await readReplayReview('synthetic-123', 1, { dataDir }), record);
});

test('review generator only sends each decision its own before-state, then separately summarizes', async () => {
  const calls = [];
  const fakeFetch = async (_url, options) => {
    const input = JSON.parse(options.body);
    const content = JSON.parse(input.messages[1].content);
    calls.push(content);
    const decision = Boolean(content.task);
    const response = decision
      ? { worth_noting: true, severity: 'tip', confidence: 'medium',
          title: '决策', observation: 'Spell Snare 已施放', suggestion: '建议保留更多选择',
          rationale: '无法证明其他行为的合法性', cards: ['Spell Snare', 'Secret Opponent Bomb'] }
      : sample.summary;
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify(response) } }] }), { status: 200 });
  };
  const generate = createReplayReviewGenerator({ apiKey: 'synthetic-test-token',
    fetchImpl: fakeFetch, decisionLimit: 4 });
  const review = await generate(replay(), { gameNumber: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].context.anchor, 'T3-A1');
  assert.equal(JSON.stringify(calls[0]).includes('Secret Opponent Bomb'), false);
  assert.equal(calls[1].timeline.length, 3);
  assert.equal(review.notes.length, 1);
  assert.deepEqual(review.notes[0].cards, ['Spell Snare']);
  assert.ok(review.summary.limitations.some(s => s.includes('仅抽查')));
});
