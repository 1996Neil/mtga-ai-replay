// Slice the canonical, chronologically filtered replay. Do not reconstruct logs
// or resolve names from any later snapshot when exporting a selected decision.
function safeValue(value) {
  if (Array.isArray(value)) return value.map(safeValue);
  if (!value || typeof value !== 'object') return value;
  if (value.hidden === true || /hidden|post.?game/i.test(value.visibility ?? '')) return { hidden: true };
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, safeValue(child)]));
}

export function createCoachContext(replay, { gameNumber = 1, anchor, boundary = 'after' } = {}) {
  if (!['before', 'after'].includes(boundary)) throw new RangeError('Boundary must be before or after.');
  if (!Number.isSafeInteger(gameNumber) || gameNumber < 1) throw new RangeError('Game number must be a positive integer.');
  const game = replay?.games?.find((game, index) => Number(game.game_number ?? index + 1) === gameNumber);
  const step = game?.steps?.find(step => step.anchor === anchor);
  if (!step) return null;
  const after = step.state ?? game.states?.[step.state_id];
  const before = step.state_before ?? game.states?.[step.before_state_id];
  const actualBefore = boundary === 'before' && Boolean(before);
  const snapshot = actualBefore ? before : after;
  if (!snapshot) return null;
  const state = safeValue(snapshot);
  if (state.players?.opponent) state.players.opponent.hand = [];
  const event = actualBefore ? { type: step.event?.type, actor: step.event?.actor } : safeValue(step.event ?? {});
  const warnings = [...new Set([...(replay.warnings ?? []), ...(game.warnings ?? []), ...(snapshot.warnings ?? [])])];
  return {
    schema_version: 'coach-context/1.0', match_id: replay.match?.id,
    game_number: gameNumber, anchor: step.anchor,
    state_boundary: actualBefore ? 'before_gre_message' : 'after_gre_message',
    grouped_frame: step.grouped_frame === true || Boolean(step.state_id && game.steps.filter(other => other.state_id === step.state_id).length > 1),
    perspective: 'Use only information available to Me at this point. Do not infer legality or hidden identities.',
    state, warnings, event,
  };
}
