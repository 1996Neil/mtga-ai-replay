import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAllLogsWithDebug, MatchFilters } from 'mtga-log-parser';
import { describeMatchMode } from './match-mode.mjs';
import { PerspectiveState } from './perspective.mjs';
import { visualSnapshot, visibleStateSignature } from './visual-state.mjs';

export const isJumpIn = event => /Jump_?In(?:_|$)/i.test(event ?? '');
const detail = (a, key) => {
  const d = a.details?.find(d => d.key === key);
  return (d?.valueString ?? d?.valueInt32 ?? [])[0];
};
const has = (a, type) => (Array.isArray(a.type) ? a.type : [a.type]).includes(`AnnotationType_${type}`);
const zoneName = (state, id) => (state.zones.get(id)?.type ?? 'Unknown').replace('ZoneType_', '');

function indexMatches(records) {
  const metadata = new Map(); let current;
  for (const obj of records) {
    const info = obj.matchGameRoomStateChangedEvent?.gameRoomInfo;
    if (info?.gameRoomConfig?.matchId) {
      current = info.gameRoomConfig.matchId;
      if (!metadata.has(current)) metadata.set(current, { config: info.gameRoomConfig, timestamp: obj.timestamp });
    }
    for (const msg of obj.greToClientEvent?.greToClientMessages ?? []) {
      if (!current || msg.systemSeatIds?.length !== 1) continue;
      const match = metadata.get(current);
      if (msg.type === 'GREMessageType_ConnectResp') {
        match.localSeat = msg.systemSeatIds[0]; match.seatConfirmed = true;
      } else if (!match.seatConfirmed && match.localSeat === undefined && msg.gameStateMessage) {
        match.localSeat = msg.systemSeatIds[0];
      }
    }
  }
  return metadata;
}

function initialGame(number) {
  return { game_number: number, on_play: null, starting_hand: [], initial_hand: [], mulligans: { me: 0, opponent: 0 },
    turns: [], states: {}, steps: [], _frames: [], result: { outcome: null, reason: 'unknown', life: { me: null, opponent: null } }, warnings: [] };
}

export async function buildReplays(records, names = new Map(), { counterNames = new Map() } = {}) {
  const meta = indexMatches(records), states = new Map(), games = new Map(), sanitized = [];
  const actionEvents = new Map(), seenStates = new Set(), seenAnnotations = new Set(), seenCombat = new Set(); let currentId;
  let sequence = 0;
  function gameFor(id, number) {
    const key = `${id}:${number}`;
    if (!games.has(key)) games.set(key, initialGame(number));
    return games.get(key);
  }
  function push(state, game, event) {
    const n = state.turn.turnNumber;
    if (!n || (state.ended && !state.finalFrame)) return null;
    let turn = game.turns.find(t => t.turn_number === n);
    if (!turn) {
      turn = { turn_number: n, active_player: state.turn.activePlayer === state.localSeat ? 'me' : 'opponent', events: [], decision_points: [] };
      game.turns.push(turn);
    }
    const value = { sequence: ++sequence, phase: state.turn.phase, step: state.turn.step,
      state_id: state.currentFrame?.id, before_state_id: state.currentFrame?.before_id, ...event };
    turn.events.push(value); return value;
  }
  for (const obj of records) {
    const info = obj.matchGameRoomStateChangedEvent?.gameRoomInfo;
    if (info?.gameRoomConfig?.matchId) currentId = info.gameRoomConfig.matchId;
    if (info) {
      const roomType = obj.matchGameRoomStateChangedEvent.stateType ?? info.stateType;
      if (roomType === 'MatchGameRoomStateType_MatchCompleted' || info.finalMatchResult) {
        const completedId = info.finalMatchResult?.matchId ?? info.gameRoomConfig?.matchId ?? currentId;
        for (const [key, state] of states) if (key.startsWith(`${completedId}:`)) {
          if (!state.terminalCards) state.terminalCards = new Map([...state.objects.keys()]
            .map(id => [id, state.card(id, names)]).filter(([, card]) => card));
          state.roomCompleted = true;
        }
      }
      const copy = structuredClone(obj);
      const config = copy.matchGameRoomStateChangedEvent.gameRoomInfo.gameRoomConfig;
      if (config) {
        const seat = meta.get(config.matchId)?.localSeat;
        // Upstream's Mac heuristic can pick the wrong name with two Mac players.
        for (const p of config.reservedPlayers ?? []) {
          p.platformId = p.systemSeatId === seat ? 'Mac' : 'Other';
          p.userId = `seat-${p.systemSeatId}`;
          // Upstream requires a string eventId even for MatchFilters.all.
          // Empty preserves unknown metadata instead of dropping that match.
          if (typeof p.eventId !== 'string') p.eventId = '';
        }
      }
      sanitized.push(copy); continue;
    }
    if (!obj.greToClientEvent) {
      // Jump In's generated deck has no Name and can be wrapped in Course.
      // Normalize those two fields; let upstream parse the card list unchanged.
      const copy = structuredClone(obj);
      const courses = copy.Courses ?? (copy.Course ? [copy.Course] : [copy]);
      for (const course of courses) if (isJumpIn(course.InternalEventName) && course.CourseDeckSummary && course.CourseDeck) {
        course.CourseDeckSummary.Name ??= 'Jump In';
      }
      sanitized.push(copy.Course ?? copy); continue;
    }
    if (!currentId || !meta.has(currentId)) continue;
    const localSeat = meta.get(currentId).localSeat;
    if (!Number.isInteger(localSeat)) continue;
    let currentNumber = [...states.keys()].filter(k => k.startsWith(`${currentId}:`)).map(k => Number(k.split(':').at(-1))).at(-1) ?? 1;
    for (const rawMessage of obj.greToClientEvent.greToClientMessages ?? []) {
      const rawGsm = rawMessage.gameStateMessage;
      if (!rawGsm) continue;
      currentNumber = rawGsm.gameInfo?.gameNumber ?? currentNumber;
      const key = `${currentId}:${currentNumber}`, game = gameFor(currentId, currentNumber);
      if (!states.has(key)) states.set(key, new PerspectiveState(localSeat));
      const state = states.get(key);
      const stateKey = `${key}:${rawGsm.gameStateId ?? rawMessage.msgId}`;
      if (seenStates.has(stateKey)) continue;
      seenStates.add(stateKey);
      if (state.ended) continue;
      const endMessage = rawGsm.gameInfo?.stage === 'GameStage_GameOver';
      const terminalFrame = endMessage || state.roomCompleted;
      // Both ordinary and queued game-state envelopes carry chronological GRE state.
      const message = { ...rawMessage, type: 'GREMessageType_GameStateMessage' };
      const previousLife = new Map([...state.players].map(([id, p]) => [id, p.lifeTotal]));
      const previousHand = [...state.zones.values()].find(z => z.type === 'ZoneType_Hand' && z.ownerSeatId === localSeat);
      const handBefore = (previousHand?.objectInstanceIds ?? []).map(id => state.card(id, names)).filter(Boolean);
      const cardsBefore = new Map([...state.objects.keys()].map(id => [id, state.card(id, names)]).filter(([, card]) => card));
      const objectsBefore = new Map(state.objects);
      const actorsBefore = new Map([...state.objects.keys()].map(id => [id, state.actor(id)]));
      const wasPreGame = !state.turn.turnNumber;
      state.apply(rawGsm);
      // Objects sometimes vanish in the same message as sacrifice/destroy. The
      // transition may still name an identity already visible before that event.
      for (const a of rawGsm.annotations ?? []) if (has(a, 'ObjectIdChanged')) {
        const oldId = detail(a, 'orig_id'), newId = detail(a, 'new_id');
        if (cardsBefore.has(oldId)) cardsBefore.set(newId, { ...cardsBefore.get(oldId), instance_id: newId });
        if (actorsBefore.has(oldId)) actorsBefore.set(newId, actorsBefore.get(oldId));
      }
      if (wasPreGame && state.turn.turnNumber) {
        game.starting_hand = handBefore;
        game.on_play = state.turn.activePlayer === localSeat;
      }
      if (!state.turn.turnNumber) {
        const hand = [...state.zones.values()].find(z => z.type === 'ZoneType_Hand' && z.ownerSeatId === localSeat);
        const cards = (hand?.objectInstanceIds ?? []).map(id => state.card(id, names)).filter(Boolean);
        if (!game.initial_hand.length && cards.length >= 7) game.initial_hand = cards;
        if (cards.length) game.starting_hand = cards;
      }
      for (const p of rawGsm.players ?? []) {
        if (p.mulliganCount !== undefined) {
          const actor = p.systemSeatNumber === localSeat ? 'me' : 'opponent';
          game.mulligans[actor] = Math.max(game.mulligans[actor], p.mulliganCount);
        }
      }
      if (terminalFrame) {
        if (endMessage) state.ended = true;
        state.finalFrame = endMessage;
        state.terminalCards = cardsBefore; // lethal damage can name only previously known identities
      }
      const metadata = meta.get(currentId);
      const player = metadata.config.reservedPlayers.find(p => p.systemSeatId === localSeat);
      const opponent = metadata.config.reservedPlayers.find(p => p.systemSeatId !== localSeat);
      const snapshot = visualSnapshot(state, names, { me: player?.playerName, opponent: opponent?.playerName, counterNames, gameStateId: rawGsm.gameStateId });
      const id = `S${game._frames.length + 1}`;
      state.currentFrame = { id, before_id: game._frames.at(-1)?.id ?? null };
      game.states[id] = snapshot;
      game._frames.push({ ...state.currentFrame, turn: snapshot.turn, meaningful: visibleStateSignature(snapshot) !== state.lastVisualSignature });
      state.lastVisualSignature = visibleStateSignature(snapshot);
      const safe = state.safeMessage(message);
      sanitized.push({ greToClientEvent: { greToClientMessages: [safe] } });
      if (state.turn.turnNumber) {
        // Preserve an empty turn as evidence of chronology, even without an action.
        if (!game.turns.some(t => t.turn_number === state.turn.turnNumber)) game.turns.push({
          turn_number: state.turn.turnNumber, active_player: state.turn.activePlayer === localSeat ? 'me' : 'opponent', events: [], decision_points: [] });
        const annotations = (rawGsm.annotations ?? []).filter(a => {
          if (terminalFrame && !has(a, 'DamageDealt') && !has(a, 'CounterAdded') && !has(a, 'CounterRemoved') &&
              !(has(a, 'ZoneTransfer') && ['SBA_Damage', 'SBA_ZeroToughness', 'Destroy', 'Sacrifice', 'Exile'].includes(detail(a, 'category')))) return false;
          if (a.id === undefined) return true;
          const id = `${key}:${a.id}`;
          if (seenAnnotations.has(id)) return false;
          seenAnnotations.add(id); return true;
        });
        const abilityParents = new Map();
        for (const a of annotations) if (has(a, 'AbilityInstanceCreated')) {
          for (const id of a.affectedIds ?? []) abilityParents.set(id, a.affectorId);
        }
        for (const a of annotations) {
          if (has(a, 'ZoneTransfer')) {
            const category = detail(a, 'category');
            const from = zoneName(state, detail(a, 'zone_src')), to = zoneName(state, detail(a, 'zone_dest'));
            for (const id of a.affectedIds ?? []) {
              const card = state.card(id, names) ?? (category === 'Draw' ? null : cardsBefore.get(id));
              const sourceZone = state.zones.get(detail(a, 'zone_src')), destinationZone = state.zones.get(detail(a, 'zone_dest'));
              const actorSeat = state.objects.get(id)?.controllerSeatId ?? state.objects.get(id)?.ownerSeatId ??
                (category === 'Draw' ? destinationZone?.ownerSeatId : sourceZone?.ownerSeatId);
              const actor = actorSeat === undefined ? actorsBefore.get(id) ?? state.actor(id) : actorSeat === localSeat ? 'me' : 'opponent';
              if (category === 'Draw') {
                const event = push(state, game, { type: 'draw', actor, ...(actor === 'me' && card ? { card } : { amount: 1 }) });
                if (event) actionEvents.set(`${key}:Draw:${id}`, event);
              } else if (category === 'CastSpell' || category === 'ActivateAbility' || category === 'TriggerAbility') {
                const types = { CastSpell: 'cast', ActivateAbility: 'activate', TriggerAbility: 'trigger' };
                const event = push(state, game, { type: types[category], actor, ...(card ? { card } : {}), targets: [] });
                if (event) actionEvents.set(`${key}:${category}:${id}`, event);
              } else {
                const types = { PlayLand: 'land', Sacrifice: 'sacrifice', Destroy: 'destroy', Exile: 'exile', Discard: 'discard', Mill: 'mill', Return: 'return', Put: 'zone_change', SBA_Damage: 'dies', SBA_ZeroToughness: 'dies' };
                const type = ((category === 'Resolve' || category === 'Put') && to === 'Battlefield') ? 'enters' : types[category] ?? 'zone_change';
                if (type === 'zone_change' && category === 'Resolve' && to !== 'Battlefield') continue;
                push(state, game, { type, actor, ...(card ? { card } : {}), from, to, details: category });
              }
            }
          }
          if (has(a, 'AbilityInstanceCreated')) {
            const source = state.card(a.affectorId, names), o = state.objects.get(a.affectorId);
            if (o?.cardTypes?.includes('CardType_Land')) continue; // omit routine mana taps
            for (const id of a.affectedIds ?? []) {
              const ability = state.objects.get(id);
              const activated = annotations.some(b => has(b, 'UserActionTaken') && detail(b, 'actionType') === 2 && b.affectedIds?.includes(id));
              const event = push(state, game, { type: activated ? 'activate' : 'ability', actor: state.actor(a.affectorId), ...(source ? { card: source } : {}), targets: [], details: ability?.type ?? 'Ability created (trigger/activation unspecified)' });
              if (event) actionEvents.set(`${key}:Ability:${id}`, event);
            }
          }
          if (has(a, 'DamageDealt')) push(state, game, { type: 'damage', actor: state.actor(a.affectorId),
            ...(state.card(a.affectorId, names) ? { card: state.card(a.affectorId, names) } : {}),
            targets: (a.affectedIds ?? []).map(id => state.target(id, names)), amount: detail(a, 'damage'),
            damage_kind: /FirstStrike/i.test(state.turn.step ?? '') ? 'first_strike' : /CombatDamage/.test(state.turn.step ?? '') ? 'combat' : 'ability_or_spell' });
          if (has(a, 'CounterAdded') || has(a, 'CounterRemoved')) {
            for (const id of a.affectedIds ?? []) push(state, game, { type: 'counter', actor: state.actor(id),
              ...(state.card(id, names) ? { card: state.card(id, names) } : {}), amount: detail(a, 'transaction_amount'),
              details: `${has(a, 'CounterRemoved') ? 'removed' : 'added'} counter type ${detail(a, 'counter_type')}` });
          }
          if (has(a, 'RevealedCardCreated') || has(a, 'InstanceRevealedToOpponent')) {
            for (const id of a.affectedIds ?? []) {
              const card = state.card(id, names);
              if (card) push(state, game, { type: 'reveal', actor: state.actor(id), card });
            }
          }
        }
        for (const a of [...annotations, ...(terminalFrame ? [] : rawGsm.persistentAnnotations ?? [])]) if (has(a, 'TargetSpec')) {
          const id = a.affectorId;
          const event = actionEvents.get(`${key}:CastSpell:${id}`) ?? actionEvents.get(`${key}:ActivateAbility:${id}`) ?? actionEvents.get(`${key}:Ability:${id}`);
          if (event) {
            const targets = (a.affectedIds ?? []).map(id => state.target(id, names));
            // Target choice can arrive later: emit at its own time, never backfill.
            const signature = JSON.stringify(targets);
            if (event._lastTargets !== signature) {
              push(state, game, { type: 'target', actor: event.actor, card: event.card, targets });
              Object.defineProperty(event, '_lastTargets', { value: signature, writable: true, enumerable: false, configurable: true });
            }
          }
        }
        for (const o of rawGsm.gameObjects ?? []) {
          if (terminalFrame) continue;
          if (o.type === 'GameObjectType_Token' && !objectsBefore.has(o.instanceId) && state.zones.get(o.zoneId)?.type === 'ZoneType_Battlefield') {
            push(state, game, { type: 'token', actor: state.actor(o.instanceId), card: state.card(o.instanceId, names), amount: 1 });
          }
          const attackKey = `${key}:${state.turn.turnNumber}:attack:${o.instanceId}:${o.attackInfo?.targetId}`;
          if (o.attackState === 'AttackState_Declared' && o.attackInfo && !seenCombat.has(attackKey)) {
            seenCombat.add(attackKey);
            push(state, game, { type: 'attack', actor: state.actor(o.instanceId), card: state.card(o.instanceId, names), targets: [state.target(o.attackInfo.targetId, names)] });
          }
          const blockKey = `${key}:${state.turn.turnNumber}:block:${o.instanceId}:${JSON.stringify(o.blockInfo?.attackerIds)}`;
          if (o.blockState === 'BlockState_Declared' && o.blockInfo && !seenCombat.has(blockKey)) {
            seenCombat.add(blockKey);
            push(state, game, { type: 'block', actor: state.actor(o.instanceId), card: state.card(o.instanceId, names), targets: (o.blockInfo.attackerIds ?? []).map(id => state.target(id, names)) });
          }
        }
        const life = {};
        let changed = false;
        for (const [id, p] of state.players) {
          life[id === localSeat ? 'me' : 'opponent'] = p.lifeTotal ?? null;
          if (previousLife.get(id) !== undefined && p.lifeTotal !== previousLife.get(id)) changed = true;
        }
        if (changed) push(state, game, { type: 'life', actor: 'both', life });
      }
      if (rawGsm.gameInfo?.stage === 'GameStage_GameOver') {
        state.finalFrame = false;
        game.result.life = Object.fromEntries([...state.players].map(([id, p]) => [id === localSeat ? 'me' : 'opponent', p.lifeTotal ?? null]));
      }
    }
  }
  const stageDir = await mkdtemp(join(tmpdir(), 'mtga-gpt-replay-'));
  let parsed;
  try {
    await writeFile(join(stageDir, 'UTC_Log - 01-01-2000 00.00.00.log'), sanitized.map(o => JSON.stringify(o)).join('\n'), { mode: 0o600 });
    parsed = await parseAllLogsWithDebug({ logDir: stageDir, matchFilter: MatchFilters.all });
  } finally { await rm(stageDir, { recursive: true, force: true }); }
  const replays = [];
  for (const match of parsed.matches) {
    const metadata = meta.get(match.id), seat = metadata.localSeat;
    const player = metadata.config.reservedPlayers.find(p => p.systemSeatId === seat);
    const opponent = metadata.config.reservedPlayers.find(p => p.systemSeatId !== seat);
    const matchGames = [...games.entries()].filter(([k]) => k.startsWith(`${match.id}:`)).map(([, g]) => g);
    for (const game of matchGames) {
      const snapshot = parsed.gameSnapshots.find(s => s.matchId === match.id && s.gameNumber === game.game_number);
      const outcome = match[`game${game.game_number}`];
      game.result.outcome = outcome === 1 ? 'Win' : outcome === 0 ? 'Loss' : outcome;
      game.result.reason = snapshot?.gameEndReason ?? 'unknown';
      // No defaults: final life remains null if not directly observed.
      if (snapshot) {
        game.mulligans.me = Math.max(game.mulligans.me, snapshot.myMulliganCount);
        game.mulligans.opponent = Math.max(game.mulligans.opponent, snapshot.opponentMulliganCount);
      }
      if (game.mulligans.me > 0) game.decision_points = [{ type: 'mulligan', candidate_only: true, initial_hand: game.initial_hand }];
      delete game.initial_hand;
      game.turns.sort((a, b) => a.turn_number - b.turn_number);
      const events = game.turns.flatMap(turn => turn.events);
      const perTurn = new Map();
      for (const frame of game._frames) {
        let frameEvents = events.filter(event => event.state_id === frame.id);
        if (!frameEvents.length && !frame.meaningful) continue;
        const after = game.states[frame.id], before = game.states[frame.before_id];
        if (!frameEvents.length) {
          if (!after.turn && !after.players.me.hand.length) continue;
          const phaseChanged = before?.phase !== after.phase || before?.step !== after.step || before?.turn !== after.turn;
          const handChanged = JSON.stringify(before?.players.me.hand) !== JSON.stringify(after.players.me.hand);
          frameEvents = [{ type: after.turn === 0 ? 'mulligan_state' : phaseChanged ? 'phase' : 'state',
            actor: after.turn === 0 ? 'me' : after.activePlayer ?? 'unknown', phase: after.phase, step: after.step,
            details: after.turn === 0 ? 'Opening hand / mulligan state' : phaseChanged ? 'Phase / step changed' : handChanged ? 'Hand updated' : 'Visible board / stack updated' }];
        }
        for (const event of frameEvents) {
          const action = (perTurn.get(frame.turn) ?? 0) + 1; perTurn.set(frame.turn, action);
          const anchor = `T${frame.turn}-A${action}`;
          if (event.sequence) event.anchor = anchor;
          game.steps.push({ anchor, turn: frame.turn, action, event, state_id: frame.id, before_state_id: frame.before_id,
            state_boundary: 'after_gre_message', grouped_frame: frameEvents.length > 1, coachNotes: [] });
        }
      }
      delete game._frames;
      // Reuse upstream action identity resolution, but preserve the chronology and
      // visibility already frozen above. Never copy global/final identity maps.
      for (const action of parsed.gameActions.filter(a => a.matchId === match.id && a.gameNumber === game.game_number)) {
        const event = actionEvents.get(`${match.id}:${game.game_number}:${action.type}:${action.sourceInstanceId}`);
        if (event?.card?.arena_id === action.sourceGrpId) {
          event.type = { CastSpell: 'cast', ActivateAbility: 'activate', TriggerAbility: 'trigger' }[action.type];
          event.actor = action.castByMe ? 'me' : 'opponent';
          event.parser_verified = true;
        }
      }
      const expectedDraws = parsed.turnDrawRecords.filter(d => d.matchId === match.id && d.gameNumber === game.game_number).reduce((n, d) => n + d.drawnGrpIds.length, 0);
      game.evidence = { parser: 'mtga-log-parser@4.1.0', own_draws_parsed: expectedDraws,
        actions_parsed: parsed.gameActions.filter(a => a.matchId === match.id && a.gameNumber === game.game_number).length,
        board_snapshots_parsed: parsed.boardSnapshots.filter(s => s.matchId === match.id && s.gameNumber === game.game_number).length };
      if (!game.starting_hand.length) game.warnings.push('Kept starting hand unavailable in this log.');
      if (!states.get(`${match.id}:${game.game_number}`)?.ended) game.warnings.push('Terminal GRE state unavailable; final life and trailing operations may be incomplete.');
    }
    const config = meta.get(match.id)?.config;
    const mode = describeMatchMode({ event_id: player?.eventId ?? match.eventId,
      queue_id: config?.queueId });
    const deckCounts = new Map();
    for (const card of parsed.myDeckListMap.get(match.id)?.main ?? []) deckCounts.set(card.cardId, (deckCounts.get(card.cardId) ?? 0) + card.quantity);
    replays.push({ schema_version: '2.0', perspective: { policy: 'Only identities legally visible to the local player at that event; no future backfill.', hidden_information: 'omitted', post_game_reveals: 'omitted' },
      match: { id: match.id, started_at: new Date(match.timestamp).toISOString(), ...mode, result: match.matchResult, on_play: match.onPlay, player: player?.playerName ?? 'Me', opponent: opponent?.playerName ?? 'Opponent' },
      deck: [...deckCounts].map(([id, quantity]) => ({ name: names.get(id) ?? `Arena card ${id}`, arena_id: id, quantity })),
      games: matchGames, warnings: ['Turns use global Arena numbering (each player turn increments it).', 'Legal alternatives/priority windows are not reconstructed; ability text and counter names may be incomplete.'] });
  }
  return { replays, stats: parsed.stats };
}

export function selectReplays(replays, { count = 1, jumpIn = true } = {}) {
  return replays.filter(r => !jumpIn || r.match.is_jump_in).sort((a, b) => b.match.started_at.localeCompare(a.match.started_at)).slice(0, count);
}
