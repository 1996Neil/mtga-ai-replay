import test from 'node:test';
import assert from 'node:assert/strict';
import type { DraftRun } from '../src/types/game.ts';
import type { DraftAiReview, DraftReviewNote, DraftReviewState } from '../src/lib/draftReview.ts';
import { currentDraftReview, draftNotePresentation, draftReviewInputKey, parseDraftReviewResponse } from '../src/lib/draftReview.ts';

const account = 'a'.repeat(64);
const a = { arena_id: 1, name: 'Synthetic A' }, b = { arena_id: 2, name: 'Synthetic B' };
const run = { run_id: 'b'.repeat(32), event_id: 'QuickDraft_SYNTHETIC', picks: [{
  pack_number: 1, pick_number: 1, candidates: [a, b], selected: a, pool_before: [], pool_after: [a], complete: true, missing: [],
}] } as unknown as DraftRun;
const note = { pack_number: 1, pick_number: 1, importance: 'normal', assessment: 'positive', confidence: 'medium',
  title: '保留', observation: '观察', suggestion: '建议', rationale: '原因', limitation: '限制', selected: a, alternative: b } as DraftReviewNote;
const review = { schema: 'MTGA_DRAFT_AI_REVIEW_V1', run_id: run.run_id, account_key: account,
  summary: { headline: '总结', overview: '说明', limitations: [] }, notes: [note] } as unknown as DraftAiReview;

test('polling reuses input identity but any changed decision evidence invalidates it', () => {
  assert.equal(draftReviewInputKey(structuredClone(run)), draftReviewInputKey(run));
  const changed = structuredClone(run); changed.picks[0].selected = b;
  assert.notEqual(draftReviewInputKey(changed), draftReviewInputKey(run));
  const names = structuredClone(run); names.picks[0].selected!.name = '本地译名';
  assert.equal(draftReviewInputKey(names), draftReviewInputKey(run));
});
test('account switch, run switch and source revision conceal previous ready comments immediately', () => {
  const snapshot: DraftReviewState = { identity: draftReviewInputKey(run), account, status: 'ready', review, error: '' };
  assert.equal(currentDraftReview(snapshot, snapshot.identity, account).review, review);
  assert.equal(currentDraftReview(snapshot, snapshot.identity, 'c'.repeat(64)).review, null);
  assert.equal(currentDraftReview(snapshot, snapshot.identity + 'changed', account).status, 'loading');
  assert.equal(currentDraftReview({ ...snapshot, status: 'stale' }, snapshot.identity, account).review, null);
});
test('reviews only mark real selected and alternative cards in the current complete pick', () => {
  const response = { run_id: run.run_id, status: 'ready', review };
  assert.equal(parseDraftReviewResponse(response, run, account).status, 'ready');
  assert.equal(parseDraftReviewResponse(response, run, 'c'.repeat(64)).status, 'error');
  const changed = structuredClone(response); changed.review.notes[0].alternative.arena_id = 9;
  assert.equal(parseDraftReviewResponse(changed, run, account).review, null);
  const duplicate = structuredClone(response); duplicate.review.notes.push(duplicate.review.notes[0]);
  assert.equal(parseDraftReviewResponse(duplicate, run, account).status, 'error');
  assert.equal(parseDraftReviewResponse({ ...response, status: 'missing' }, run, account).review, null);
});
test('draft comments use exactly the battle review colors, symbols and uncertainty semantics', () => {
  assert.equal(draftNotePresentation(note).tone, 'positive');
  assert.equal(draftNotePresentation(note).symbol, '✓');
  assert.equal(draftNotePresentation({ ...note, assessment: 'suggestion' }).tone, 'tip');
  const possible = draftNotePresentation({ ...note, importance: 'major', assessment: 'possible_error' });
  assert.equal(possible.tone, 'major'); assert.equal(possible.symbol, '◆');
  assert.equal(possible.judgment, '建议核查');
  assert.doesNotMatch(possible.accessible, /确定错误|已证实/);
});
