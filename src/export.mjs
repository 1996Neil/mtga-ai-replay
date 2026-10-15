/** Compact, offline exports of the canonical player-perspective reconstruction. */

const forbiddenVisibility = new Set([
  'hidden', 'opponent_hidden', 'post_game', 'post_game_revealed',
  'post_game_reveal', 'postgame', 'postgame_revealed',
]);

function normalize(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function hiddenCard(card) {
  if (!card || typeof card !== 'object') return false;
  if (card.hidden === true) return true;
  const visibility = normalize(card.visibility);
  return forbiddenVisibility.has(visibility)
    || visibility.includes('post_game') || visibility.includes('hidden');
}

function isOpponent(actor) {
  return ['opponent', 'them', 'opp'].includes(normalize(actor));
}

function isDraw(type) {
  return ['draw', 'drew', 'draw_card', 'card_drawn'].includes(normalize(type));
}

// The adapter is the perspective boundary. These explicit redactions also keep
// an accidental hidden/post-game card object out of either exported format.
function safeReplay(replay) {
  const result = structuredClone(replay);
  for (const game of result.games ?? []) {
    game.starting_hand = (game.starting_hand ?? []).filter(card => !hiddenCard(card));
    for (const decision of game.decision_points ?? []) {
      if (decision && typeof decision === 'object' && decision.initial_hand) {
        decision.initial_hand = decision.initial_hand.filter(card => !hiddenCard(card));
      }
    }
    for (const turn of game.turns ?? []) {
      for (const event of turn.events ?? []) {
        const hasHiddenIdentity = hiddenCard(event.card)
          || (event.targets ?? []).some(hiddenCard);
        if (hiddenCard(event.card)) delete event.card;
        if (event.targets) {
          event.targets = event.targets.map(target => hiddenCard(target)
            ? { visibility: 'hidden' } : target);
        }
        if (hasHiddenIdentity) delete event.details;
        if (isDraw(event.type) && isOpponent(event.actor ?? turn.active_player)) {
          delete event.card;
          delete event.targets;
          delete event.details;
        }
      }
    }
  }
  return result;
}

function text(value) {
  if (value == null) return '';
  return String(value).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function markdown(value) {
  return text(value).replace(/([\\`*_[\]<>])/g, '\\$1');
}

function person(actor) {
  if (normalize(actor) === 'me') return 'Me';
  if (isOpponent(actor)) return 'Opponent';
  if (actor == null || actor === '' || normalize(actor) === 'unknown') return 'Unknown player';
  return markdown(actor);
}

function cardName(card, instance = true) {
  if (card == null || hiddenCard(card)) return 'unknown card';
  if (typeof card === 'string') return markdown(card);
  const name = markdown(card.name) || (card.arena_id != null
    ? `Unknown card (Arena ${text(card.arena_id)})` : 'unknown card');
  return name + (instance && card.instance_id != null ? ` #${text(card.instance_id)}` : '');
}

function targetName(target) {
  if (target?.player != null) return person(target.player);
  if (hiddenCard(target)) return 'unknown target';
  return cardName(target);
}

function lifeSummary(life) {
  if (!life || typeof life !== 'object') return '';
  return ['me', 'opponent'].filter(player => life[player] != null)
    .map(player => `${person(player)} ${text(life[player])}`).join('; ');
}

function count(amount, noun) {
  const n = amount == null ? 1 : amount;
  return `${text(n)} ${noun}${Number(n) === 1 ? '' : 's'}`;
}

function sentence(value) {
  const clean = text(value);
  return clean ? clean + (/[.!?]$/.test(clean) ? '' : '.') : '';
}

function eventLine(event, turn) {
  const type = normalize(event.type);
  const actor = person(event.actor ?? turn.active_player);
  const card = cardName(event.card);
  const targets = (event.targets ?? []).map(targetName).join(', ');
  const targeting = targets ? ` → ${targets}` : '';
  const detail = markdown(event.details);
  const amount = event.amount ?? 1;
  let line;

  switch (type) {
    case 'draw': case 'drew': case 'draw_card': case 'card_drawn':
      line = isOpponent(event.actor ?? turn.active_player)
        ? `${actor} drew ${count(amount, 'card')}`
        : `${actor} drew ${event.card ? card : count(amount, 'card')}`;
      break;
    case 'land': case 'land_played': case 'play_land':
      line = `${actor} played land: ${card}`; break;
    case 'cast': case 'spell_cast': case 'cast_spell':
      line = `${actor} cast ${card}${targeting}`; break;
    case 'enters': case 'entered_battlefield': case 'permanent_entered': case 'enter_battlefield': case 'etb':
      line = `${card} entered the battlefield (${actor})`; break;
    case 'activate': case 'activated': case 'activated_ability': case 'activate_ability':
      line = `${actor} activated ${event.card ? card : 'an ability'}${targeting}`;
      if (detail && !/^(?:GameObjectType|AbilityType|GREMessageType)/.test(detail)) line += `: ${detail}`;
      break;
    case 'trigger': case 'triggered': case 'triggered_ability': case 'trigger_ability':
      line = `${event.card ? card : actor + ' ability'} triggered${targeting}`;
      if (detail && !/^(?:GameObjectType|AbilityType|GREMessageType)/.test(detail)) line += `: ${detail}`;
      break;
    case 'ability':
      line = `Ability created${event.card ? ` from ${card}` : ''} (trigger/activation unspecified)${targeting}`;
      break;
    case 'target':
      line = `${actor} chose targets${event.card ? ` for ${card}` : ''}${targets ? `: ${targets}` : ': unknown'}`;
      break;
    case 'attack': case 'attacked': case 'attacker_declared':
      line = `${actor} attacked with ${card}${targeting}`; break;
    case 'block': case 'blocked': case 'blocker_declared':
      line = `${actor} blocked${targets ? ' ' + targets : ''} with ${card}`; break;
    case 'damage': case 'damage_dealt':
      line = `${event.card ? card : actor} dealt ${text(event.amount ?? '?')} damage${targeting}`;
      if (detail) line += ` (${detail})`;
      break;
    case 'life': case 'life_change': case 'life_changed':
      line = lifeSummary(event.life) ? `Life: ${lifeSummary(event.life)}`
        : `${actor} life changed${event.amount != null ? ` by ${Number(event.amount) > 0 ? '+' : ''}${text(event.amount)}` : ''}`;
      if (detail) line += ` (${detail})`;
      break;
    case 'dies': case 'died': case 'creature_died':
      line = `${card} died`; break;
    case 'destroy': case 'destroyed':
      line = `${card} was destroyed${targets ? ': ' + targets : ''}`; break;
    case 'exile': case 'exiled':
      line = `${card} was exiled`; break;
    case 'sacrifice': case 'sacrificed':
      line = `${actor} sacrificed ${card}`; break;
    case 'discard': case 'discarded':
      line = `${actor} discarded ${card}`; break;
    case 'mill': case 'milled':
      line = `${actor} milled ${event.card ? card : count(amount, 'card')}`; break;
    case 'return': case 'bounce': case 'returned': case 'returned_to_hand':
      line = `${card} returned to ${markdown(event.to) || 'hand'}`; break;
    case 'zone_change': case 'zone_move': case 'zone_transfer': case 'move':
      line = `${card}: ${markdown(event.from) || '?'} → ${markdown(event.to) || '?'}`;
      if (detail) line += ` (${detail})`;
      break;
    case 'token': case 'token_created': case 'create_token':
      line = `${actor} created ${Number(amount) > 1 ? count(amount, 'token') + ': ' : 'token: '}${card}`; break;
    case 'counter': case 'counter_changed': case 'counters_changed':
      line = `${card} counters${event.amount != null ? ` ${Number(event.amount) > 0 ? '+' : ''}${text(event.amount)}` : ' changed'}`;
      if (detail) line += ` (${detail})`;
      break;
    case 'resolve': case 'resolved': case 'spell_resolved': case 'ability_resolved':
      line = `${card} resolved`; break;
    case 'countered': case 'spell_countered':
      line = `${card} was countered`; break;
    case 'reveal': case 'revealed': case 'card_revealed':
      line = `${actor} revealed ${card}`; break;
    case 'mulligan':
      line = `${actor} mulliganed${event.amount != null ? ` (${text(event.amount)})` : ''}`; break;
    case 'game_result': case 'game_end': case 'result':
      line = `Game result: ${detail || actor}`; break;
    default:
      // Unrecognized semantic events remain visible instead of silently vanishing.
      line = `${actor}: ${markdown(event.type) || 'event'}`;
      if (event.card) line += ` — ${card}`;
      if (targeting) line += targeting;
      if (event.from != null || event.to != null) line += ` (${markdown(event.from) || '?'} → ${markdown(event.to) || '?'})`;
      if (event.amount != null) line += ` (${text(event.amount)})`;
      if (detail) line += `: ${detail}`;
      if (lifeSummary(event.life)) line += `; life: ${lifeSummary(event.life)}`;
  }
  return sentence(line);
}

function onPlay(value) {
  return value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
}

/** Pretty JSON without adding or inferring game information. */
export function toJSON(replay) {
  return JSON.stringify(safeReplay(replay), null, 2) + '\n';
}

/** Readable transcript; turn numbers are Arena's global turn counter. */
export function toMarkdown(replay) {
  const safe = safeReplay(replay);
  const match = safe.match ?? {};
  const lines = [
    '# MTGA Replay', '',
    '> Coach each decision using only information available to Me at that moment. Later draws, reveals, plays, and the result are hindsight, not evidence available for earlier decisions. Hidden opponent cards and post-game reveals are omitted. Observed actions do not establish every legal alternative.', '',
    '## Match', '',
    `Event: ${markdown(match.event || match.event_id) || 'Unknown'}${match.event_id && match.event_id !== match.event ? ` (${markdown(match.event_id)})` : ''}. Jump In: ${match.is_jump_in === true ? 'Yes' : match.is_jump_in === false ? 'No' : 'Unknown'}.`,
    `Time: ${markdown(match.started_at) || 'Unknown'}. Result: ${markdown(match.result) || 'Unknown'}. On the play: ${onPlay(match.on_play)}.`,
    `Me: ${markdown(match.player) || 'Unknown'}. Opponent: ${markdown(match.opponent) || 'Unknown'}.`,
    `Match ID: ${markdown(match.id) || 'Unknown'}.`, '',
    '*Arena Turn numbers count each player turn globally: 1, 2, 3…; they are not per-player round numbers.*',
  ];

  for (const game of safe.games ?? []) {
    lines.push('', `## Game ${text(game.game_number ?? 1)}`, '',
      `On the play: ${onPlay(game.on_play ?? match.on_play)}.`, '', '### Starting Hand', '');
    const mulliganCandidates = (game.decision_points ?? []).filter(decision => normalize(decision?.type) === 'mulligan');
    for (const decision of mulliganCandidates) {
      lines.push('[Decision Point candidate] Mulligan — candidate only; no legality inferred.');
      if (decision.initial_hand?.length) {
        lines.push('First offered hand: ' + decision.initial_hand.map(card => cardName(card, false)).join('; ') + '.');
      }
    }
    if (game.starting_hand?.length) {
      lines.push((mulliganCandidates.length ? 'Kept hand: ' : '') + game.starting_hand.map(card => cardName(card, false)).join('; ') + '.');
    } else lines.push(mulliganCandidates.length ? 'Kept hand: Not recorded.' : 'Not recorded.');
    const mulligans = game.mulligans ?? {};
    lines.push(`Mulligans — Me: ${mulligans.me == null ? 'unknown' : text(mulligans.me)}; Opponent: ${mulligans.opponent == null ? 'unknown' : text(mulligans.opponent)}.`);
    for (const turn of game.turns ?? []) {
      lines.push('', `### Arena Turn ${text(turn.turn_number ?? '?')} — ${person(turn.active_player)}`, '');
      for (const event of turn.events ?? []) lines.push(`- ${eventLine(event, turn)}`);
      for (const decision of turn.decision_points ?? []) {
        const label = typeof decision === 'string' ? decision : decision.label ?? decision.reason ?? decision.type;
        lines.push(`- [Decision Point candidate] ${markdown(label) || 'Review this observed choice; legality is not inferred'}.`);
      }
    }
    lines.push('', '### Result', '');
    const result = game.result ?? {};
    lines.push(sentence(`${markdown(result.outcome) || 'Unknown'}${result.reason && result.reason !== 'unknown' ? ` (${markdown(result.reason)})` : ''}${lifeSummary(result.life) ? `. Final life: ${lifeSummary(result.life)}` : ''}`));
    if (game.warnings?.length) {
      lines.push('', '### Reconstruction Warnings', '');
      lines.push(...game.warnings.map(warning => `- ${markdown(warning)}`));
    }
  }

  if (safe.deck?.length) {
    lines.push('', '## My Registered Deck', '',
      safe.deck.map(card => `${text(card.quantity ?? 1)}× ${cardName(card, false)}`).join('; ') + '.',
      '*Deck contents do not establish library order or when a card was available in hand.*');
  }
  if (safe.warnings?.length) {
    lines.push('', '## Reconstruction Warnings', '', ...safe.warnings.map(warning => `- ${markdown(warning)}`));
  }
  return lines.join('\n') + '\n';
}
