/** Derived local parser evidence, never a timeout or a claimed game result. */
export const TERMINAL_GRE_WARNING = 'Terminal GRE state unavailable; final life and trailing operations may be incomplete.';

export function isReplayAutoUploadReady(replay) {
  const completion = replay?.match?.completion_evidence, games = replay?.games;
  if (completion?.match_completed !== true || !Number.isSafeInteger(completion.expected_games) ||
      completion.expected_games < 1 || !Array.isArray(games) || games.length !== completion.expected_games) return false;
  const numbers = new Set(games.map(game => game.game_number));
  return numbers.size === completion.expected_games && games.every(game =>
    Number.isSafeInteger(game.game_number) && game.game_number >= 1 && game.game_number <= completion.expected_games &&
    game.evidence?.terminal_state_observed === true && ['Win', 'Loss', 'Draw'].includes(game.result?.outcome) &&
    (game.steps ?? game.replay_steps)?.length > 0 && !(game.warnings ?? []).includes(TERMINAL_GRE_WARNING));
}
