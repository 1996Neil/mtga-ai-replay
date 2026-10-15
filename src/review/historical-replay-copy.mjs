import { buildCoachBundle } from '../coach-bundle.mjs';
import { validateCloudReviewBinding } from './cloud-review.mjs';
import { replayInputFingerprintAsync } from './review-model.mjs';
import { reviewReject } from './cloud-review-contract.mjs';

const list = value => Array.isArray(value) ? value : [];
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const hidden = value => value?.hidden === true || value?.is_face_down === true || value?.face_down === true ||
  /hidden|post.?game|private|face.?down/i.test(String(value?.visibility ?? ''));

/** Explicit historical-copy preparation, NOT a relaxed reader verdict or an
 * archive migration. The caller must keep this returned replay separate from
 * the original. No filesystem, network, database or cache writes happen here.
 *
 * Aliases are an explicit, reviewed input (e.g. a pinned local localization
 * dictionary); the report cannot supply them. Only typed visible card slots
 * with an existing Arena ID/name may change. Every other published field must
 * still reproduce the complete old bundle hash using the unchanged builder.
 */
export async function prepareHistoricalReplayCopy({ replay, source, report, cardAliases = [], counterAliases = [] }) {
  if (validateCloudReviewBinding(report, source).status !== 'ready') reviewReject('historical-source-stale');
  if (replay?.match?.id !== source.match_id) reviewReject('historical-match');
  const options = { cards: source.cards, historyKey: source.history_key, multipart: true };
  // Do not catch privacy/security failures and then try to "repair" them.
  let originalBundle = await buildCoachBundle(replay, options);
  const originalHash = originalBundle.contentHash;
  originalBundle = null;
  const originalFingerprint = await replayInputFingerprintAsync(replay);
  const result = candidate => ({ replay: candidate, receipt: { kind: 'explicit-isolated-historical-copy',
    match_id: source.match_id, source_revision: source.revision, source_content_hash: source.content_hash,
    original_content_hash: originalHash, original_fingerprint: originalFingerprint,
    sequence_offset: offset ?? 0, changed_card_names: changedNames, changed_counter_names: changedCounters,
    changed_sequences: changedSequences, exact_bundle_hash_verified: true } });
  let offset = null, changedNames = 0, changedCounters = 0, changedSequences = 0;
  if (originalHash === source.content_hash) return result(structuredClone(replay));

  const canonical = new Map(), aliases = new Map(), counters = new Map();
  for (const card of source.cards) {
    if (canonical.has(card.arena_id) && canonical.get(card.arena_id) !== card.name) reviewReject('historical-ambiguous-card');
    canonical.set(card.arena_id, card.name);
  }
  if (!Array.isArray(cardAliases) || cardAliases.length > 1024 || !Array.isArray(counterAliases) || counterAliases.length > 64)
    reviewReject('historical-alias-limit');
  for (const row of cardAliases) {
    if (!Number.isSafeInteger(row.arena_id) || row.arena_id < 1 || typeof row.local_name !== 'string' ||
      !row.local_name || row.local_name.length > 180 || !/[\u3400-\u9fff]/u.test(row.local_name) ||
      canonical.get(row.arena_id) !== row.published_name || typeof row.published_name !== 'string' ||
      /[\u3400-\u9fff]/u.test(row.published_name)) reviewReject('historical-card-alias');
    const key = JSON.stringify([row.arena_id, row.local_name]);
    if (aliases.has(key)) reviewReject('historical-ambiguous-alias');
    aliases.set(key, row.published_name);
  }
  // Historical enum compatibility is deliberately limited to the observed
  // loyalty label; counts, enum IDs and all other counter fields remain intact.
  for (const row of counterAliases) {
    if (row.type !== 7 || row.local_name !== '忠诚' || row.published_name !== 'Loyalty' || counters.has(7))
      reviewReject('historical-counter-alias');
    counters.set(7, row);
  }
  const candidate = structuredClone(replay), visited = new WeakSet();
  const card = value => {
    if (!value || typeof value !== 'object' || hidden(value) || visited.has(value)) return;
    visited.add(value);
    if (Number.isSafeInteger(value.arena_id) && typeof value.name === 'string') {
      const ability = value.is_ability === true;
      const suffix = ability ? ' — ability' : '';
      const current = suffix && value.name.endsWith(suffix) ? value.name.slice(0, -suffix.length) : value.name;
      const translated = aliases.get(JSON.stringify([value.arena_id, current]));
      if (translated && (!ability || (value.name.endsWith(suffix) && value.ability_source?.arena_id === value.arena_id &&
        value.ability_source.name === current && !hidden(value.ability_source)))) {
        value.name = translated + suffix; changedNames++;
      }
    }
    for (const counter of list(value.counters)) {
      const row = counters.get(counter.type);
      if (row && counter.name === row.local_name) { counter.name = row.published_name; changedCounters++; }
    }
    for (const item of list(value.targets)) card(item);
    card(value.source); card(value.ability_source);
  };
  const state = value => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    for (const side of ['me', 'opponent']) for (const zone of ['hand', 'battlefield', 'graveyard', 'exile'])
      for (const item of list(value.players?.[side]?.[zone])) card(item);
    for (const item of list(value.stack)) card(item);
  };
  const decision = value => {
    for (const key of ['initial_hand', 'bottomed_cards']) for (const item of list(value?.[key])) card(item);
  };
  for (const item of list(candidate.deck)) card(item);
  const sourceGames = new Map(source.replay.games.map((game, i) => [game.game_number ?? i + 1, game]));
  for (const [i, game] of list(candidate.games).entries()) {
    const published = sourceGames.get(game.game_number ?? i + 1);
    if (!published) reviewReject('historical-game');
    const events = new Map(published.steps.map(step => [step.anchor, step.event]));
    const changedEvents = new WeakSet();
    const event = (value, anchor) => {
      if (!value || typeof value !== 'object' || changedEvents.has(value)) return;
      changedEvents.add(value);
      const expected = events.get(anchor);
      if (!expected || own(value, 'sequence') !== own(expected, 'sequence')) reviewReject('historical-event');
      if (own(value, 'sequence')) {
        const delta = expected.sequence - value.sequence;
        if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isSafeInteger(expected.sequence) ||
          expected.sequence < 1 || !Number.isSafeInteger(delta) || (offset !== null && delta !== offset))
          reviewReject('historical-sequence-offset');
        offset ??= delta;
        if (delta) { value.sequence += delta; changedSequences++; }
      }
      card(value.card); card(value.source); card(value.ability_source);
      for (const item of list(value.targets)) card(item);
    };
    for (const item of list(game.starting_hand)) card(item);
    for (const value of Object.values(game.states ?? {})) state(value);
    for (const step of list(game.steps ?? game.replay_steps)) {
      event(step.event, step.anchor); state(step.state); state(step.state_before);
    }
    for (const turn of list(game.turns)) {
      for (const value of list(turn.events)) event(value, value.anchor);
      for (const value of list(turn.decision_points)) decision(value);
    }
    for (const value of list(game.decision_points)) decision(value);
  }
  // Descriptions/derived context are recomputed by production code, never copied
  // from the remote. ID, order, frames, life, damage, notes, all games and parts
  // remain covered by the complete original source content hash.
  const rebuilt = await buildCoachBundle(candidate, options);
  if (rebuilt.contentHash !== source.content_hash) reviewReject('historical-exact-hash');
  return result(candidate);
}
