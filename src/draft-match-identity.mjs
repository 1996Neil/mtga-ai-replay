import { createHash } from 'node:crypto';

/** Only facts that establish a draft/match relationship, independent of replay reconstruction. */
export function draftMatchIdentity(match, deck, gameCount = match?.game_count) {
  const id = match?.id ?? match?.match_id, event = match?.event_id ?? match?.event;
  if (typeof id !== 'string' || !id || typeof event !== 'string' || !event ||
    !(match.account_key === null || /^[a-f0-9]{64}$/.test(match.account_key ?? '')) ||
    !Number.isFinite(Date.parse(match.started_at)) ||
    ![null, 'Win', 'Loss', 'Draw'].includes(match.result ?? null) ||
    !Number.isSafeInteger(gameCount) || gameCount < 1 || !Array.isArray(deck) || !deck.length) return null;
  const counts = new Map();
  for (const card of deck) {
    const quantity = card.quantity ?? card.Quantity ?? 1;
    if (!Number.isSafeInteger(card.arena_id) || card.arena_id < 1 ||
      !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 250) return null;
    counts.set(card.arena_id, (counts.get(card.arena_id) ?? 0) + quantity);
  }
  return createHash('sha256').update(JSON.stringify({
    schema: 'draft-match-identity/1', id, event, account_key: match.account_key,
    started_at: new Date(match.started_at).toISOString(), result: match.result ?? null,
    game_count: gameCount, deck: [...counts].sort((a, b) => a[0] - b[0]),
  })).digest('hex');
}
