import type { DraftPick, DraftRun } from '../types/game.ts';
import { reviewPresentation } from '../replay/reviewPresentation.ts';
import type { Importance, Assessment } from '../replay/reviewPresentation.ts';
import type { ReviewStatus } from '../replay/reviewAvailability.ts';

export type DraftReviewCard = { arena_id: number; name: string };
export interface DraftReviewNote {
  pack_number: number; pick_number: number; importance: Importance; assessment: Assessment;
  confidence: 'high' | 'medium' | 'low'; title: string; observation: string;
  suggestion: string; rationale: string; limitation: string;
  selected: DraftReviewCard; alternative: DraftReviewCard;
}
export interface DraftAiReview {
  schema: 'MTGA_DRAFT_AI_REVIEW_V1'; run_id: string; account_key: string;
  source_fingerprint: string; generated_at: string;
  summary: { headline: string; overview: string; limitations: string[] };
  notes: DraftReviewNote[];
}
export type DraftReviewState = {
  identity: string; account: string; status: ReviewStatus; review: DraftAiReview | null; error: string;
};
export const draftReviewPickKey = (pick: Pick<DraftPick, 'pack_number' | 'pick_number'>) =>
  `${pick.pack_number}-${pick.pick_number}`;

/** Polling creates new objects; only changes to decision evidence reload a review. */
export function draftReviewInputKey(run: DraftRun): string {
  return JSON.stringify([run.run_id, run.event_id, [...run.picks]
    .sort((a, b) => a.pack_number - b.pack_number || a.pick_number - b.pick_number)
    .map(pick => [pick.pack_number, pick.pick_number, pick.candidates.map(card => card.arena_id),
      pick.selected?.arena_id ?? null, pick.pool_before.map(card => card.arena_id),
      pick.pool_after.map(card => card.arena_id), pick.complete])]);
}
export function currentDraftReview(snapshot: DraftReviewState, identity: string, account: string): DraftReviewState {
  if (snapshot.identity !== identity || snapshot.account !== account)
    return { identity, account, status: 'loading', review: null, error: '' };
  return snapshot.status === 'ready' ? snapshot : { ...snapshot, review: null };
}
export function draftNotePresentation(note: DraftReviewNote) {
  return reviewPresentation({ ...note, severity: note.assessment === 'positive' ? 'positive' : 'tip' });
}
export function parseDraftReviewResponse(value: unknown, run: DraftRun, account: string): {
  status: ReviewStatus; review: DraftAiReview | null; error: string;
} {
  const failed = { status: 'error' as const, review: null, error: '轮抽复盘返回的数据不完整，请重新检查。' };
  if (!value || typeof value !== 'object') return failed;
  const data = value as { run_id?: unknown; status?: unknown; review?: DraftAiReview; error?: unknown };
  if (data.run_id !== run.run_id) return failed;
  if (data.status !== 'ready') return {
    status: ['missing', 'stale', 'error'].includes(String(data.status)) ? data.status as ReviewStatus : 'error',
    review: null, error: typeof data.error === 'string' ? data.error : '',
  };
  const review = data.review;
  if (!review || review.schema !== 'MTGA_DRAFT_AI_REVIEW_V1' ||
      review.run_id !== run.run_id || review.account_key !== account ||
      !review.summary || typeof review.summary.headline !== 'string' ||
      typeof review.summary.overview !== 'string' || !Array.isArray(review.summary.limitations) ||
      review.summary.limitations.some(value => typeof value !== 'string') ||
      !Array.isArray(review.notes) || review.notes.length > 90) return failed;
  const picks = new Map(run.picks.map(pick => [draftReviewPickKey(pick), pick])), seen = new Set();
  for (const note of review.notes) {
    if (!note || !Number.isSafeInteger(note.pack_number) || !Number.isSafeInteger(note.pick_number) ||
        seen.has(draftReviewPickKey(note)) || !['critical', 'major', 'normal'].includes(note.importance) ||
        !['positive', 'suggestion', 'possible_error'].includes(note.assessment) ||
        !['high', 'medium', 'low'].includes(note.confidence) ||
        [note.title, note.observation, note.suggestion, note.rationale, note.limitation].some(value => typeof value !== 'string')) return failed;
    seen.add(draftReviewPickKey(note));
    const pick = picks.get(draftReviewPickKey(note));
    if (!pick?.complete || !note.selected || !note.alternative ||
        pick.selected?.arena_id !== note.selected.arena_id ||
        !pick.candidates.some(card => card.arena_id === note.selected.arena_id) ||
        !pick.candidates.some(card => card.arena_id === note.alternative.arena_id)) return failed;
  }
  return { status: 'ready', review, error: '' };
}
