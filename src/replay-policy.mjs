/** Exclude explicit tutorial modes only; ordinary starter-deck events still count. */
export function isTutorialMatch(match = {}) {
  return [match.event_id, match.queue_id, match.event, match.mode].some(value =>
    typeof value === 'string' && /^(?:NPE[_ -])?Tutorial(?:[_ -]|$)/i.test(value.trim()));
}
