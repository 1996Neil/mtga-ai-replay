import { createHash } from 'node:crypto';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { createCoachContext } from '../coach-context.mjs';

export const REVIEW_POLICY = 'visible-context/2;sample8;unproved-errors-are-tips';

const severities = new Set(['critical', 'major', 'tip', 'positive']);
const confidences = new Set(['high', 'medium', 'low']);
const text = (v, max = 1500) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const list = (v, max = 4) => Array.isArray(v) ? v.map(item => text(item, 400)).filter(Boolean).slice(0, max) : [];

export function findReviewGame(replay, gameNumber) {
  if (!Number.isSafeInteger(gameNumber) || gameNumber < 1) return null;
  return replay?.games?.find((g, i) => Number(g.game_number ?? i + 1) === gameNumber) ?? null;
}

function* fingerprintParts(game, replayWarnings = []) {
  // Frame-sized serialization avoids a second giant string for large matches.
  yield JSON.stringify([REVIEW_POLICY, game?.result ?? {}, game?.warnings ?? [], replayWarnings]);
  for (const step of game?.steps ?? []) yield JSON.stringify(step);
  for (const [id, state] of Object.entries(game?.states ?? {})) {
    yield JSON.stringify(id); yield JSON.stringify(state);
  }
}
export function reviewFingerprint(game, replayWarnings = []) {
  const hash = createHash('sha256');
  for (const part of fingerprintParts(game, replayWarnings)) hash.update(part).update('\n');
  return hash.digest('hex');
}
export async function reviewFingerprintAsync(game, replayWarnings = [], signal) {
  const hash = createHash('sha256'); let batch = 0;
  for (const part of fingerprintParts(game, replayWarnings)) {
    signal?.throwIfAborted(); hash.update(part).update('\n');
    if (++batch % 16 === 0) await yieldToIO();
  }
  signal?.throwIfAborted(); return hash.digest('hex');
}

/** Cache identity covers the entire local input, including deck, starting hand,
 * match metadata, all games and historical notes. Frame-sized chunks avoid a
 * giant second serialized string; no mutable object-identity cache is used. */
export async function replayInputFingerprintAsync(replay) {
  const hash = createHash('sha256'); let batch = 0;
  const add = value => { const text = JSON.stringify(value); hash.update(String(Buffer.byteLength(text))).update(':').update(text); };
  for (const [key, value] of Object.entries(replay ?? {})) {
    add(key);
    if (key !== 'games' || !Array.isArray(value)) { add(value); continue; }
    add(value.length);
    for (const game of value) { add(Object.keys(game).length); for (const [field, child] of Object.entries(game)) {
      add(field);
      if (Array.isArray(child)) {
        add(['array', child.length]);
        for (const item of child) { add(item); if (++batch % 16 === 0) await yieldToIO(); }
      } else if (field === 'states' && child && typeof child === 'object') {
        add(['states', Object.keys(child).length]);
        for (const [id, state] of Object.entries(child)) { add(id); add(state); if (++batch % 16 === 0) await yieldToIO(); }
      } else add(child);
    } }
  }
  return hash.digest('hex');
}

function observedState(value) {
  // Published coach archives may contain lazy {$ref} entries instead of the
  // actual GRE snapshot. Do not confuse unresolved references with an empty board.
  return value && typeof value === 'object' && !value.$ref &&
    value.players && typeof value.players === 'object' && value.players.me &&
    value.players.opponent ? value : null;
}
function beforeOf(game, step) {
  return observedState(step.state_before) ?? observedState(game.states?.[step.before_state_id]);
}
function afterOf(game, step) {
  return observedState(step.state) ?? observedState(game.states?.[step.state_id]);
}
function isHidden(card) {
  return !card || card.hidden === true || card.is_face_down === true || card.face_down === true ||
    /hidden|post.?game|private|face.?down/i.test(String(card.visibility ?? ''));
}
export function visibleCardNames(snapshot) {
  // Only card-bearing player-visible zones. Do NOT traverse full snapshots:
  // opponent hidden-hand entries or player names might otherwise look like cards.
  const names = new Set();
  const collect = (items) => {
    for (const card of Array.isArray(items) ? items : []) {
      if (!isHidden(card) && typeof card.name === 'string' && card.name &&
        verifiedEnglishName(card.name)) names.add(card.name);
    }
  };
  const me = snapshot?.players?.me ?? {};
  const opponent = snapshot?.players?.opponent ?? {};
  for (const zone of ['hand', 'battlefield', 'graveyard', 'exile']) collect(me[zone]);
  for (const zone of ['battlefield', 'graveyard', 'exile']) collect(opponent[zone]);
  collect(snapshot?.stack);
  return names;
}

/** Strict, source-anchored report. Never silently remap an invalid anchor to a nearby frame. */
export function normalizeReplayReview(replay, gameNumber, raw, { source = 'imported', now = new Date().toISOString(), fingerprint } = {}) {
  const game = findReviewGame(replay, gameNumber);
  if (!game) throw new Error('Review game is not present in this replay.');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Review payload must be an object.');
  if (!raw.summary || typeof raw.summary !== 'object') throw new Error('Review summary is missing.');
  if (!Array.isArray(raw.notes) || raw.notes.length > 24) throw new Error('Review must include at most 24 annotations.');
  const steps = new Map((game.steps ?? []).map(step => [step.anchor, step]));
  const summary = {
    headline: text(raw.summary.headline, 180),
    overview: text(raw.summary.overview, 1300),
    strengths: list(raw.summary.strengths, 3),
    improvements: list(raw.summary.improvements, 3),
    limitations: list(raw.summary.limitations, 4),
  };
  if (!summary.headline || !summary.overview) throw new Error('Review requires a headline and overview.');
  const notes = [], seen = new Set();
  for (const input of raw.notes) {
    if (!input || typeof input !== 'object') continue;
    const anchor = text(input.anchor, 80);
    const step = steps.get(anchor);
    const severity = text(input.severity, 20), confidence = text(input.confidence, 20);
    const boundary = input.boundary === 'after' ? 'after' : 'before';
    if (!step || !severities.has(severity) || !confidences.has(confidence) || seen.has(anchor)) continue;
    // Strong red warnings are never based on explicitly low-confidence model claims.
    const safeSeverity = ['critical', 'major'].includes(severity) ? 'tip' : severity;
    if (!(boundary === 'before' ? beforeOf(game, step) : afterOf(game, step))) continue; // Never display a post-action frame as a pre-action one.
    const title = text(input.title, 160), observation = text(input.observation, 1400),
      suggestion = text(input.suggestion, 1400);
    if (!title || !observation || !suggestion) continue;
    // English card-name chips are constrained to identities visible at this decision.
    const names = visibleCardNames(boundary === 'before' ? beforeOf(game, step) : afterOf(game, step));
    const lookup = new Map([...names].map(name => [name.toLowerCase(), name]));
    const cards = [...new Set((Array.isArray(input.cards) ? input.cards : [])
      .filter(name => typeof name === 'string').map(name => lookup.get(name.toLowerCase())).filter(Boolean))].slice(0, 8);
    notes.push({ anchor, boundary, severity: safeSeverity, confidence, title, observation, suggestion,
      rationale: text(input.rationale, 1300), cards, limitation: text(input.limitation, 500) });
    seen.add(anchor);
  }
  return { schema_version: 'replay-review/1.0', match_id: String(replay.match?.id ?? ''),
    game_number: gameNumber, source: text(source, 100), created_at: now,
    policy_version: REVIEW_POLICY, fingerprint: fingerprint ?? reviewFingerprint(game, replay.warnings), summary, notes };
}

export function reviewIsCurrent(replay, review) {
  const game = findReviewGame(replay, review?.game_number);
  return Boolean(game && review?.schema_version === 'replay-review/1.0' &&
    review.match_id === replay?.match?.id && review.policy_version === REVIEW_POLICY && review.fingerprint === reviewFingerprint(game, replay.warnings));
}

const priority = { mulligan: 9, block: 8, cast: 7, attack: 6, activate: 6,
  discard: 6, sacrifice: 6, land: 2, land_played: 2 };

/** Only pick player decisions for which an actual before-state is available. */
export function selectReviewDecisions(game, limit = 10) {
  const steps = game?.steps ?? [];
  const candidates = steps.map((step, index) => {
    const event = step.event ?? {}, score = priority[event.type] ?? 0;
    return { step, index, score };
  }).filter(row => row.step.event?.actor === 'me' && row.score > 0 && beforeOf(game, row.step));
  if (!candidates.length) return [];
  const buckets = new Map();
  for (const row of candidates) {
    const segment = Math.floor(row.index * Math.min(limit, 10) / Math.max(steps.length, 1));
    const previous = buckets.get(segment);
    if (!previous || row.score > previous.score) buckets.set(segment, row);
  }
  const chosen = [...buckets.values()];
  for (const row of candidates.sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(row)) chosen.push(row);
  }
  return chosen.slice(0, limit).sort((a, b) => a.index - b.index).map(row => row.step);
}

function verifiedEnglishName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 180 &&
    !/^(Arena card |Unknown )/.test(name) && !/[\u3400-\u9fff]/u.test(name);
}
function compactCard(card) {
  if (isHidden(card)) return { hidden: true };
  const value = { name: verifiedEnglishName(card.name) ? card.name : null };
  // Field allowlist retains combat/target identities, never arbitrary log data.
  for (const key of ['arena_id', 'instance_id', 'logical_id', 'owner', 'controller', 'power', 'toughness',
    'damage_marked', 'has_summoning_sickness', 'card_types', 'colors', 'is_tapped', 'counters',
    'is_attacking', 'is_blocking', 'attacking_target_id', 'blocked_attacker_ids', 'attached_to', 'attachments']) {
    if (card[key] !== undefined) value[key] = card[key];
  }
  if (Array.isArray(card.targets)) value.targets = card.targets.map(compactCard);
  if (card.ability_source) value.ability_source = compactCard(card.ability_source);
  return value;
}
export function reviewActionContext(step) {
  const event = step.event ?? {};
  return { type: event.type, actor: event.actor, amount: event.amount ?? null,
    card: event.card ? compactCard(event.card) : null,
    targets: Array.isArray(event.targets) ? event.targets.map(compactCard) : [] };
}
export function reviewDecisionContext(replay, gameNumber, step) {
  const game = findReviewGame(replay, gameNumber);
  if (!game || !beforeOf(game, step)) return null;
  const shared = createCoachContext(replay, { gameNumber, anchor: step.anchor, boundary: 'before' });
  if (!shared || shared.state_boundary !== 'before_gre_message') return null;
  const snapshot = shared.state, players = snapshot.players ?? {};
  const player = p => ({ life: p?.life ?? null, hand_size: p?.handSize ?? p?.hand_size ?? null,
    mana_pool: p?.mana_pool ?? null, mana_pool_source: p?.mana_pool_source ?? 'unknown',
    battlefield: (p?.battlefield ?? []).map(compactCard),
    graveyard: (p?.graveyard ?? []).map(compactCard), exile: (p?.exile ?? []).map(compactCard) });
  return { anchor: step.anchor, turn: step.turn, action: reviewActionContext(step),
    boundary: shared.state_boundary, grouped_frame: shared.grouped_frame,
    game_state: { turn: snapshot.turn ?? null, phase: snapshot.phase ?? null, step: snapshot.step ?? null,
      active_player: snapshot.activePlayer ?? snapshot.active_player ?? null,
      priority_player: snapshot.priorityPlayer ?? snapshot.priority_player ?? null,
      me: { ...player(players.me), hand: (players.me?.hand ?? []).map(compactCard) },
      opponent: player(players.opponent), stack: (snapshot.stack ?? []).map(compactCard) },
    warnings: shared.warnings,
    policy: 'Only observed player-visible state. Mana/priority are last observed, not proof of legal alternatives. Unknown English identities remain null.' };
}
