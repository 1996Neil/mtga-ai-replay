import { createHash } from 'node:crypto';

const severities = new Set(['critical', 'major', 'tip', 'positive']);
const confidences = new Set(['high', 'medium', 'low']);
const text = (v, max = 1500) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const list = (v, max = 4) => Array.isArray(v) ? v.map(item => text(item, 400)).filter(Boolean).slice(0, max) : [];

export function findReviewGame(replay, gameNumber) {
  if (!Number.isSafeInteger(gameNumber) || gameNumber < 1) return null;
  return replay?.games?.find((g, i) => Number(g.game_number ?? i + 1) === gameNumber) ?? null;
}

export function reviewFingerprint(game) {
  // Reimport may keep the same anchors but correct previously missing state.
  // Hash every recorded frame, not only its anchor count.
  return createHash('sha256').update(JSON.stringify({
    steps: game?.steps ?? [], states: game?.states ?? {}, result: game?.result ?? {},
  })).digest('hex');
}

function beforeOf(game, step) {
  return step.state_before ?? game.states?.[step.before_state_id] ?? null;
}
function afterOf(game, step) {
  return step.state ?? game.states?.[step.state_id] ?? null;
}
function isHidden(card) {
  return !card || card.hidden === true || /hidden|post.?game/i.test(String(card.visibility ?? ''));
}
function visibleCardNames(snapshot) {
  // Only card-bearing player-visible zones. Do NOT traverse full snapshots:
  // opponent hidden-hand entries or player names might otherwise look like cards.
  const names = new Set();
  const collect = (items) => {
    for (const card of Array.isArray(items) ? items : []) {
      if (!isHidden(card) && typeof card.name === 'string' && card.name &&
        !card.name.startsWith('Arena card ')) names.add(card.name);
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
export function normalizeReplayReview(replay, gameNumber, raw, { source = 'imported', now = new Date().toISOString() } = {}) {
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
    if (boundary === 'before' && !beforeOf(game, step)) continue; // Never display a post-action frame as a pre-action one.
    const title = text(input.title, 160), observation = text(input.observation, 1400),
      suggestion = text(input.suggestion, 1400);
    if (!title || !observation || !suggestion) continue;
    // English card-name chips are constrained to identities visible at this decision.
    const names = visibleCardNames(boundary === 'before' ? beforeOf(game, step) : afterOf(game, step));
    const lookup = new Map([...names].map(name => [name.toLowerCase(), name]));
    const cards = [...new Set((Array.isArray(input.cards) ? input.cards : [])
      .filter(name => typeof name === 'string').map(name => lookup.get(name.toLowerCase())).filter(Boolean))].slice(0, 8);
    notes.push({ anchor, boundary, severity, confidence, title, observation, suggestion,
      rationale: text(input.rationale, 1300), cards, limitation: text(input.limitation, 500) });
    seen.add(anchor);
  }
  return { schema_version: 'replay-review/1.0', match_id: String(replay.match?.id ?? ''),
    game_number: gameNumber, source: text(source, 100), created_at: now,
    fingerprint: reviewFingerprint(game), summary, notes };
}

export function reviewIsCurrent(replay, review) {
  const game = findReviewGame(replay, review?.game_number);
  return Boolean(game && review?.schema_version === 'replay-review/1.0' &&
    review.match_id === replay?.match?.id && review.fingerprint === reviewFingerprint(game));
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

function compactCard(card) {
  if (isHidden(card)) return { hidden: true };
  return { name: card.name ?? null, arena_id: card.arena_id ?? null,
    power: card.power ?? null, toughness: card.toughness ?? null,
    is_tapped: Boolean(card.is_tapped), counters: card.counters ?? [],
    is_attacking: Boolean(card.is_attacking), is_blocking: Boolean(card.is_blocking) };
}
export function reviewDecisionContext(replay, gameNumber, step) {
  const game = findReviewGame(replay, gameNumber);
  const snapshot = game && beforeOf(game, step);
  if (!snapshot) return null;
  const players = snapshot.players ?? {};
  const player = p => ({ life: p?.life ?? null, hand_size: p?.handSize ?? p?.hand_size ?? null,
    battlefield: (p?.battlefield ?? []).map(compactCard),
    graveyard: (p?.graveyard ?? []).slice(-12).map(compactCard),
    exile: (p?.exile ?? []).slice(-12).map(compactCard) });
  return { anchor: step.anchor, turn: step.turn, action: step.event,
    boundary: 'before_gre_message', grouped_frame: Boolean(step.grouped_frame),
    game_state: { turn: snapshot.turn ?? null, phase: snapshot.phase ?? null, step: snapshot.step ?? null,
      active_player: snapshot.active_player ?? null, priority_player: snapshot.priority_player ?? null,
      me: { ...player(players.me), hand: (players.me?.hand ?? []).map(compactCard) },
      opponent: { ...player(players.opponent), hand_size: players.opponent?.handSize ?? players.opponent?.hand_size ?? null },
      stack: (snapshot.stack ?? []).map(compactCard) },
    warnings: [...new Set([...(game.warnings ?? []), ...(snapshot.warnings ?? [])])],
    policy: 'No future states or unrevealed opponent hand. Priority/legal alternatives are not proved.' };
}
