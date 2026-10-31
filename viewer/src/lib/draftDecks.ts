import type { DraftRun } from '../types/game.ts';
import { draftReviewInputKey } from './draftReview.ts';

export const deckCategories = [
  ['creature', '生物'], ['planeswalker', '鹏洛客'], ['instant', '瞬间'], ['sorcery', '法术'],
  ['enchantment', '结界'], ['artifact', '神器'], ['other', '其他'], ['land', '地'],
] as const;
export type DeckCategory = typeof deckCategories[number][0];
export interface DraftDeckCard {
  arena_id: number; name: string; quantity: number; key: string; display_name_zh?: string | null;
  mana_cost: string | null; mana_value: number | null; type_line: string; category: DeckCategory;
}
export interface DeckChanges {
  added: Array<{ arena_id: number; name: string; quantity: number; key: string }>;
  removed: Array<{ arena_id: number; name: string; quantity: number; key: string }>;
}
export interface DraftDeckRecommendation {
  title: string; plan: string; cards: DraftDeckCard[];
  choices: Array<{ title: string; reason: string }>;
}
export interface DraftDeckVersion {
  version: number; fingerprint: string; cards: DraftDeckCard[]; started_at: string; last_used_at: string;
  wins: number; losses: number; matches: Array<{ id: string; started_at: string; result: string }>;
  changes_from_previous: DeckChanges; comparison: DeckChanges | null;
}
export interface DraftDeckResponse {
  run_id: string; account_key: string; status: 'ready' | 'incomplete'; finished: boolean;
  recommendation_status: 'ready' | 'missing' | 'stale' | 'error';
  recommendation: DraftDeckRecommendation | null; versions: DraftDeckVersion[];
}
export function draftDeckInputKey(run: DraftRun, account: string): string {
  return JSON.stringify([draftReviewInputKey(run), account, run.binding, run.binding_account_status,
    run.matches.map(match => [match.id, match.started_at, match.result])]);
}
export function deckCardCount(cards: Array<{ quantity: number }>): number {
  return cards.reduce((sum, card) => sum + card.quantity, 0);
}
export function deckManaColumns(cards: DraftDeckCard[]): Array<number | null> {
  const values = new Set(cards.map(card => card.mana_value));
  return [...values].sort((a, b) => a === null ? 1 : b === null ? -1 : a - b);
}
export function deckRows(cards: DraftDeckCard[]) {
  return ([['creature', '生物'], ['other', '其他']] as const).map(([category, label]) => {
    const grouped = cards.filter(card => category === 'creature' ? card.category === 'creature' : card.category !== 'creature');
    return { category, label, cards: grouped, count: deckCardCount(grouped) };
  }).filter(row => row.count > 0);
}
export function deckDifferenceCount(changes: DeckChanges): number {
  return Math.max(deckCardCount(changes.added), deckCardCount(changes.removed));
}
export function draftDeckSelectionFinished(run: DraftRun): boolean {
  const picks = [...run.picks].sort((a, b) => a.pack_number - b.pack_number || a.pick_number - b.pick_number);
  if (!picks.length || picks.some(pick => !pick.complete)) return false;
  let count = 0;
  for (let pack = 1; pack <= 3; pack++) {
    const values = picks.filter(pick => pick.pack_number === pack), size = values[0]?.candidates.length;
    if (!Number.isSafeInteger(size) || size < 1 || size > 30 || values.length !== size ||
        values.some((pick, index) => pick.pick_number !== index + 1 || !pick.selected ||
          !pick.candidates.some(card => card.arena_id === pick.selected!.arena_id))) return false;
    count += values.length;
  }
  return count === picks.length;
}
/** Never render a response from another account/run, even for one frame. */
export function parseDraftDeckResponse(value: unknown, run: DraftRun, account: string): DraftDeckResponse {
  if (!value || typeof value !== 'object') throw Error('无法读取卡组对比，请重试。');
  const data = value as DraftDeckResponse;
  if (data.run_id !== run.run_id || data.account_key !== account || !['ready', 'incomplete'].includes(data.status) ||
      !Array.isArray(data.versions) || data.versions.length > 1000 ||
      !['ready', 'missing', 'stale', 'error'].includes(data.recommendation_status)) throw Error('卡组与当前轮抽不一致。');
  const cardsValid = (cards: DraftDeckCard[]) => Array.isArray(cards) && cards.length <= 100 &&
    cards.every(card => card && Number.isSafeInteger(card.arena_id) && card.arena_id > 0 &&
      Number.isSafeInteger(card.quantity) && card.quantity > 0 && card.quantity <= 100 &&
      typeof card.name === 'string' && typeof card.key === 'string' &&
      deckCategories.some(([category]) => card.category === category) &&
      (card.mana_value === null || Number.isFinite(card.mana_value) && card.mana_value >= 0));
  const changesValid = (changes: DeckChanges) => changes && [changes.added, changes.removed].every(cards =>
    Array.isArray(cards) && cards.length <= 100 && cards.every(card =>
      card && typeof card.key === 'string' && typeof card.name === 'string' &&
      Number.isSafeInteger(card.quantity) && card.quantity > 0));
  if (data.recommendation_status === 'ready' && (!data.recommendation ||
      !cardsValid(data.recommendation.cards) || deckCardCount(data.recommendation.cards) !== 40 ||
      typeof data.recommendation.title !== 'string' || typeof data.recommendation.plan !== 'string' ||
      !Array.isArray(data.recommendation.choices) || data.recommendation.choices.some(choice =>
        typeof choice.title !== 'string' || typeof choice.reason !== 'string'))) throw Error('推荐卡组不完整。');
  for (const [index, version] of data.versions.entries()) {
    if (!cardsValid(version.cards) || version.version !== index + 1 || !Array.isArray(version.matches) ||
        !changesValid(version.changes_from_previous) ||
        version.comparison !== null && !changesValid(version.comparison)) throw Error('卡组版本不完整。');
  }
  return { ...data, recommendation: data.recommendation_status === 'ready' ? data.recommendation : null };
}
