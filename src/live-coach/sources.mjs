import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { discoverLogs } from '../discovery.mjs';
import { createRecordFramer } from '../log-reader.mjs';
import { PerspectiveState } from '../perspective.mjs';
import { visualSnapshot } from '../visual-state.mjs';
import { resolveCoachBundle, serializeCoachJson } from '../coach-bundle.mjs';
import { snapshotToLiveState } from './state.mjs';

const run = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const list = value => Array.isArray(value) ? value : [];
const frozen = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) frozen(child);
  }
  return value;
};
export const LOCKED_REPLAY_REF = '91b60e81e2ddefe4de748623e53d1eb6027a86e9';

async function gitBlob(repoDir, ref, path) {
  const { stdout } = await run('git', ['show', `${ref}:${path}`], { cwd: repoDir, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 10000 });
  return stdout;
}

/** Local immutable Git objects only. No checkout mutation, fetch or GitHub call. */
export class ReplaySource {
  #coach; #frames; #ownKnowledgeIds; #sessionId;
  /** UI history comes from the complete local locked index, not the initial match. */
  static async catalog({ repoDir, ref = LOCKED_REPLAY_REF, readBlob = gitBlob } = {}) {
    if (ref !== LOCKED_REPLAY_REF || !repoDir) throw new Error('Replay catalog requires the locked local repository.');
    const index = JSON.parse(Buffer.from(await readBlob(resolve(repoDir), ref, 'index.json')).toString('utf8'));
    const ids = new Set();
    if (index.schema !== 'MTGA_COACH_INDEX_V1' || !Array.isArray(index.matches)) throw new Error('Invalid locked replay catalog.');
    const entries = index.matches.map(entry => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.match_id ?? '') || ids.has(entry.match_id) ||
        !/^matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.path ?? '') ||
        !Number.isFinite(Date.parse(entry.started_at)) || !/^[a-f0-9]{64}$/.test(entry.content_hash ?? '')) throw new Error('Invalid locked replay catalog entry.');
      ids.add(entry.match_id);
      return { id: entry.match_id, started_at: entry.started_at, event: entry.mode ?? 'Jump In', result: entry.result ?? 'Unknown' };
    });
    return frozen(entries.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id.localeCompare(a.id)));
  }
  static async open({ repoDir, matchId, ref = LOCKED_REPLAY_REF, sessionId = randomUUID(), readBlob = gitBlob } = {}) {
    if (ref !== LOCKED_REPLAY_REF) throw new Error('ReplaySource requires the locked Phase 1 data ref.');
    if (!repoDir || !matchId) throw new Error('ReplaySource requires a local repository and match ID.');
    const root = resolve(repoDir);
    const load = async path => Buffer.from(await readBlob(root, ref, path));
    const index = JSON.parse((await load('index.json')).toString('utf8'));
    const entry = list(index.matches).find(item => item.match_id === matchId);
    if (index.schema !== 'MTGA_COACH_INDEX_V1' || !entry || !/^matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.path ?? '')) throw new Error('Locked replay index has no valid match.');
    const manifest = JSON.parse((await load(`${entry.path}/manifest.json`)).toString('utf8'));
    if (manifest.schema !== 'MTGA_COACH_MANIFEST_V1' || manifest.match_id !== matchId || !manifest.files ||
      manifest.content_hash !== sha256(serializeCoachJson(manifest.files)) || entry.content_hash !== manifest.content_hash) throw new Error('Replay manifest identity/content hash mismatch.');
    const values = new Map(), parts = new Map();
    for (const [name, expected] of Object.entries(manifest.files)) {
      const path = name.startsWith('matches/') ? name : `${entry.path}/${name}`;
      if (!path.startsWith(`${entry.path}/`) || path.includes('..') || path.includes('\\') ||
        !/^(?:matches\/[A-Za-z0-9_-]+\/)?(?:coach\.json|cards\.json|summary\.json|parts\/part-\d+\.json)$/.test(path) ||
        !/^[a-f0-9]{64}$/.test(expected?.sha256 ?? '') || !Number.isSafeInteger(expected?.bytes) || expected.bytes < 0) throw new Error('Invalid replay manifest file.');
      const bytes = await load(path);
      if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error(`Replay integrity mismatch: ${name}`);
      const value = JSON.parse(bytes.toString('utf8')); values.set(name, value);
      if (value.schema === 'MTGA_COACH_PART_V1') parts.set(name, value);
    }
    for (const required of ['coach.json', 'cards.json', 'summary.json']) if (!values.has(required)) throw new Error(`Replay manifest lacks ${required}.`);
    const coach = resolveCoachBundle(values.get('coach.json'), parts);
    if (coach.schema !== 'MTGA_FULL_COACH_V1' || (coach.match?.id ?? coach.match?.match_id) !== matchId || !Array.isArray(coach.games)) throw new Error('Invalid expanded Coach Bundle.');
    return new ReplaySource(coach, values.get('cards.json'), { sessionId, ref, manifest, summary: values.get('summary.json') });
  }
  constructor(coach, cards, { sessionId, ref, manifest, summary }) {
    this.#coach = frozen(coach); this.#sessionId = sessionId;
    this.#ownKnowledgeIds = list(coach.deck).filter(c => !c.hidden).map(c => Number(c.arena_id)).filter(Number.isInteger);
    this.cards = frozen(structuredClone(list(cards)));
    this.summary = frozen({ schema: 'MTGA_REPLAY_SOURCE_V1', match_id: coach.match.id ?? coach.match.match_id,
      ref, mode: summary.mode ?? null, games: coach.games.length, states: manifest.source_coverage?.states ?? null });
    this.#frames = coach.games.flatMap((game, index) => {
      const entries = Object.entries(game.states ?? {});
      if (!entries.every(([id]) => /^S\d+$/.test(id))) throw new Error('Replay state chronology must use canonical S<n> IDs.');
      return entries.sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1))).map(([stateId, snapshot], stateIndex) =>
        ({ stateId, snapshot, gameNumber: game.game_number ?? index + 1,
          sourceEnded: stateIndex === entries.length - 1 }));
    });
  }
  #frame(frame, index, previous) {
    const state = snapshotToLiveState(frame.snapshot, { sessionId: this.#sessionId, matchId: this.summary.match_id,
      gameId: frame.gameNumber, seq: index + 1, stateId: frame.stateId, rules: this.cards, sourceMode: 'replay',
      previous, ownKnowledgeIds: this.#ownKnowledgeIds, terminal: Boolean(frame.snapshot.terminal) || frame.sourceEnded });
    if (frame.sourceEnded) { state.source_ended = true; state.terminal_source = 'end_of_recorded_game'; }
    return frozen(state);
  }
  async *frames() {
    let previous = null;
    for (let i = 0; i < this.#frames.length; i++) { const state = this.#frame(this.#frames[i], i, previous); previous = state; yield state; }
  }
  stateAt(stateId, { gameNumber = 1 } = {}) {
    let previous = null;
    for (let i = 0; i < this.#frames.length; i++) {
      const frame = this.#frames[i], state = this.#frame(frame, i, previous); previous = state;
      if (frame.stateId === stateId && Number(frame.gameNumber) === Number(gameNumber)) return state;
    }
    return null;
  }
  stateForAnchor(anchor, { gameNumber = 1, boundary = 'after' } = {}) {
    if (!['before', 'after'].includes(boundary)) throw new Error('Replay boundary must be before or after.');
    const game = this.#coach.games.find((g, i) => Number(g.game_number ?? i + 1) === Number(gameNumber));
    const step = list(game?.steps).find(s => s.anchor === anchor);
    if (!step) return null;
    const stateId = boundary === 'before' ? step.before_state_id : step.state_id ?? step.after_state_id;
    return stateId ? this.stateAt(stateId, { gameNumber }) : null;
  }
  // Explicit UI-only accessor. Model inputs are exclusively the returned LiveState.
  viewerReplay() { return structuredClone(this.#coach); }
}

/** Read-only official-log tail sharing canonical framing, state and projection.
 * Polling bounds input bytes and GRE/room work. Large startup/backlogs remain
 * silent across polls; start() does not wait for the entire history. One JSON
 * record may still require a synchronous parse up to the 16 MiB framing cap;
 * these are work/memory bounds, not an asserted wall-clock latency guarantee. */
export class LiveSource {
  #options; #file = null; #offset = 0; #identity = null; #prefix = Buffer.alloc(0); #checkpoint = Buffer.alloc(0);
  #decoder = new StringDecoder('utf8'); #framer; #matchId = null; #gameNumber = null;
  #seat = null; #perspective = null; #snapshot = null; #full = false; #ended = false; #seq = 0; #frame = 0;
  #priority = null; #seen = new Set(); #seenRequests = new Set(); #timer = null; #poll = null; #running = false;
  #pendingEvents = []; #pendingIndex = 0; #catchingUp = true;
  constructor({ logPath, logDir, names = new Map(), rules = [], counterNames = new Map(), onState = () => {}, onReset = () => {},
    onError = () => {}, pollIntervalMs = 250, sessionId = randomUUID(), emitBootstrapFrames = false, discover = discoverLogs,
    maxBytesPerPoll = 256 * 1024, maxFramesPerPoll = 128, maxRecordCharacters = 16 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxBytesPerPoll) || maxBytesPerPoll < 1 || maxBytesPerPoll > 4 * 1024 * 1024 ||
      !Number.isSafeInteger(maxFramesPerPoll) || maxFramesPerPoll < 1 || maxFramesPerPoll > 4096 ||
      !Number.isSafeInteger(maxRecordCharacters) || maxRecordCharacters < 2 || maxRecordCharacters > 16 * 1024 * 1024) throw new Error('Invalid live-source polling budget.');
    this.#options = { logPath, logDir, names, rules, counterNames, onState, onReset, onError, pollIntervalMs, sessionId, emitBootstrapFrames, discover,
      maxBytesPerPoll, maxFramesPerPoll, maxRecordCharacters };
    this.#framer = createRecordFramer({ maxRecordCharacters });
    this.currentState = null;
  }
  get progress() { return Object.freeze({ read_offset: this.#offset, catching_up: this.#catchingUp,
    pending_events: this.#pendingEvents.length - this.#pendingIndex,
    framing_characters: this.#framer.bufferedCharacters, integrity_losses: this.#framer.integrityLossCount,
    limits: { bytes_per_poll: this.#options.maxBytesPerPoll, frames_per_poll: this.#options.maxFramesPerPoll,
      record_characters: this.#options.maxRecordCharacters } }); }
  async #reset(reason, { clearFile = false } = {}) {
    this.#matchId = null; this.#gameNumber = null; this.#seat = null; this.#perspective = null; this.#snapshot = null;
    this.#full = false; this.#ended = false; this.#frame = 0; this.#priority = null; this.#seen.clear(); this.#seenRequests.clear(); this.currentState = null;
    if (clearFile) {
      this.#file = null; this.#offset = 0; this.#identity = null; this.#prefix = Buffer.alloc(0); this.#checkpoint = Buffer.alloc(0);
      this.#decoder = new StringDecoder('utf8'); this.#framer = createRecordFramer({ maxRecordCharacters: this.#options.maxRecordCharacters });
      this.#pendingEvents = []; this.#pendingIndex = 0; this.#catchingUp = true;
    }
    await this.#options.onReset({ reason, session_id: this.#options.sessionId });
  }
  #project({ offeredActions = null, terminal = false } = {}) {
    const seq = ++this.#seq;
    if (this.#priority?.fresh) this.#priority.observed_seq = seq;
    if (offeredActions) { offeredActions.observed_seq = seq; offeredActions.state_id = `L${this.#frame}`; }
    const state = frozen(snapshotToLiveState(this.#snapshot, { sessionId: this.#options.sessionId, matchId: this.#matchId,
      gameId: this.#gameNumber, seq, stateId: `L${this.#frame}`, sourceMode: 'live', rules: this.#options.rules,
      previous: this.currentState, stateComplete: this.#full, priorityObservation: this.#priority,
      offeredActions, terminal, observedAtMonotonic: performance.now() }));
    this.currentState = state;
    if (this.#priority) this.#priority.fresh = false;
    return state;
  }
  #offered(message) {
    if (message.systemSeatIds?.length !== 1 || message.systemSeatIds[0] !== this.#seat) return null;
    if (message.gameStateId !== undefined && this.#snapshot.gameStateId !== undefined && message.gameStateId !== this.#snapshot.gameStateId) return null;
    const visible = new Map([...this.#snapshot.players.me.battlefield, ...this.#snapshot.players.me.hand,
      ...this.#snapshot.players.opponent.battlefield, ...this.#snapshot.stack].filter(c => c.visibility !== 'hidden').map(c => [c.instance_id, c]));
    const own = id => visible.get(id)?.controller === 'me' || this.#snapshot.players.me.hand.some(c => c.instance_id === id);
    const request = { window_id: `${this.#matchId}:${this.#gameNumber}:${message.msgId ?? this.#seq + 1}`,
      game_state_id: message.gameStateId ?? this.#snapshot.gameStateId ?? null, source: 'observed_server_request' };
    if (message.actionsAvailableReq) {
      request.kind = 'actions'; request.actions = list(message.actionsAvailableReq.actions).filter(a => !a.instanceId || own(a.instanceId)).slice(0, 256).map(a => {
        const action = { actionType: a.actionType, instanceId: a.instanceId ?? null, facetId: a.facetId ?? null };
        if (visible.get(a.instanceId)) action.grpId = visible.get(a.instanceId).arena_id;
        if (Array.isArray(a.manaCost)) action.manaCost = a.manaCost.map(m => ({ color: list(m.color), count: m.count ?? null }));
        if (Array.isArray(a.targets)) action.targets = a.targets.map(group => ({ targetIdx: group.targetIdx,
          targets: list(group.targets).filter(t => visible.has(t.targetInstanceId) || [1, 2].includes(t.targetInstanceId)).map(t => ({ targetInstanceId: t.targetInstanceId })) }));
        return action;
      });
    } else if (message.declareAttackersReq) {
      request.kind = 'attackers'; request.attackers = list(message.declareAttackersReq.attackers).filter(a => own(a.attackerInstanceId)).map(a => ({ attackerInstanceId: a.attackerInstanceId,
        legalDamageRecipients: list(a.legalDamageRecipients).filter(r => [1, 2].includes(r.playerSystemSeatId) || visible.has(r.instanceId)).map(r => ({ type: r.type,
          ...(r.playerSystemSeatId ? { playerSystemSeatId: r.playerSystemSeatId } : { instanceId: r.instanceId }) })) }));
      request.canSubmitAttackers = message.declareAttackersReq.canSubmitAttackers === true;
    } else if (message.declareBlockersReq) {
      request.kind = 'blockers'; request.blockers = list(message.declareBlockersReq.blockers).filter(b => own(b.blockerInstanceId)).map(b => ({ blockerInstanceId: b.blockerInstanceId,
        attackerInstanceIds: list(b.attackerInstanceIds).filter(id => visible.has(id)), maxAttackers: b.maxAttackers ?? null }));
    } else return null;
    return request;
  }
  #collect(state, output) {
    // Reconstruct a populated/lagging log without retaining or delivering its
    // historical snapshots. Only the current canonical state survives.
    if (this.#catchingUp && !this.#options.emitBootstrapFrames) { output[0] = state; output.length = 1; }
    else output.push(state);
  }
  async #record(record, output) {
    const room = record.matchGameRoomStateChangedEvent?.gameRoomInfo;
    const matchId = room?.gameRoomConfig?.matchId;
    if (matchId && matchId !== this.#matchId) { output.length = 0; await this.#reset('new_match'); this.#matchId = matchId; }
    const completedId = room?.finalMatchResult?.matchId ?? matchId ?? this.#matchId;
    if (room && completedId === this.#matchId && (record.matchGameRoomStateChangedEvent.stateType === 'MatchGameRoomStateType_MatchCompleted' || room.finalMatchResult)) {
      if (this.#snapshot && !this.#ended) { this.#ended = true; this.#collect(this.#project({ terminal: true }), output); }
      return;
    }
    for (const message of record.greToClientEvent?.greToClientMessages ?? []) {
      if (!this.#matchId) continue;
      const seats = list(message.systemSeatIds);
      if (message.type === 'GREMessageType_ConnectResp' && seats.length === 1 && [1, 2].includes(seats[0])) {
        if (this.#seat !== null && this.#seat !== seats[0]) {
          const id = this.#matchId; output.length = 0; await this.#reset('local_seat_changed'); this.#matchId = id;
        }
        this.#seat = seats[0];
      }
      const gsm = message.gameStateMessage;
      if (gsm) {
        if (this.#seat !== null && seats.length === 1 && seats[0] !== this.#seat) continue;
        if (this.#seat === null && seats.length === 1 && [1, 2].includes(seats[0])) this.#seat = seats[0];
        if (this.#seat === null) continue;
        const gameNumber = gsm.gameInfo?.gameNumber ?? this.#gameNumber ?? 1;
        if (gameNumber !== this.#gameNumber) {
          const seat = this.#seat, id = this.#matchId;
          output.length = 0; await this.#reset('new_game'); this.#matchId = id; this.#seat = seat; this.#gameNumber = gameNumber;
        }
        if (this.#ended) continue;
        if (!this.#full && gsm.type !== 'GameStateType_Full') continue;
        const token = gsm.gameStateId ?? message.msgId;
        if (token !== undefined && this.#seen.has(token)) continue;
        if (token !== undefined) { this.#seen.add(token); if (this.#seen.size > 10000) this.#seen.delete(this.#seen.values().next().value); }
        if (!this.#perspective) this.#perspective = new PerspectiveState(this.#seat);
        if (gsm.gameInfo?.stage === 'GameStage_GameOver' && !this.#snapshot) { this.#ended = true; continue; }
        if (gsm.gameInfo?.stage === 'GameStage_GameOver' && this.#snapshot) {
          // Terminal messages may reveal hidden cards. Keep the last legal board
          // and update only directly observed final life, then stop this game.
          const snapshot = structuredClone(this.#snapshot);
          for (const player of gsm.players ?? []) if (player.lifeTotal !== undefined)
            snapshot.players[player.systemSeatNumber === this.#seat ? 'me' : 'opponent'].life = player.lifeTotal;
          this.#snapshot = snapshot; this.#ended = true; this.#frame++; this.#collect(this.#project({ terminal: true }), output); continue;
        }
        this.#perspective.apply(gsm); this.#full = true; this.#frame++;
        this.#snapshot = visualSnapshot(this.#perspective, this.#options.names, { counterNames: this.#options.counterNames, gameStateId: gsm.gameStateId });
        if (Object.hasOwn(gsm.turnInfo ?? {}, 'priorityPlayer')) {
          const player = gsm.turnInfo.priorityPlayer;
          this.#priority = { player: [1, 2].includes(player) ? player === this.#seat ? 'me' : 'opponent' : null,
            source: 'observed_gre', observed_seq: this.#seq + 1, fresh: true };
        } else if (this.#priority) this.#priority.fresh = false;
        this.#collect(this.#project({ terminal: gsm.gameInfo?.stage === 'GameStage_GameOver' }), output);
      } else if (this.#full && this.#snapshot && !this.#ended) {
        const offered = this.#offered(message);
        if (offered) {
          const key = `${message.type}:${message.msgId ?? ''}:${JSON.stringify(offered)}`;
          if (this.#seenRequests.has(key)) continue;
          this.#seenRequests.add(key);
          if (this.#seenRequests.size > 10000) this.#seenRequests.delete(this.#seenRequests.values().next().value);
          this.#priority = { player: 'me', source: 'observed_server_request', observed_seq: this.#seq + 1, fresh: true };
          this.#collect(this.#project({ offeredActions: offered }), output);
        }
      }
    }
  }
  async #consumePending(output, budget) {
    let consumed = 0;
    while (this.#pendingIndex < this.#pendingEvents.length && consumed < budget) {
      const event = this.#pendingEvents[this.#pendingIndex];
      if (event.type === 'integrity_loss') {
        output.length = 0;
        // The lost record may include a new-match identity. Do not reuse its
        // predecessor's match/seat, even if a subsequent Diff looks familiar.
        await this.#reset('log_record_integrity_lost'); this.#pendingIndex++; consumed++; continue;
      }
      event.cursor ??= -1;
      const record = event.record, messages = list(record.greToClientEvent?.greToClientMessages);
      if (event.cursor === -1) {
        if (record.matchGameRoomStateChangedEvent) {
          await this.#record({ matchGameRoomStateChangedEvent: record.matchGameRoomStateChangedEvent }, output); consumed++;
        }
        event.cursor = 0;
        if (consumed >= budget && messages.length) break;
      }
      if (event.cursor < messages.length) {
        await this.#record({ greToClientEvent: { greToClientMessages: [messages[event.cursor++]] } }, output); consumed++;
      } else { this.#pendingEvents[this.#pendingIndex++] = null; if (!messages.length && !record.matchGameRoomStateChangedEvent) consumed++; }
    }
    if (this.#pendingIndex === this.#pendingEvents.length) { this.#pendingEvents = []; this.#pendingIndex = 0; }
    return consumed;
  }
  async #pollOnce() {
    let paths;
    try { paths = await this.#options.discover({ logPath: this.#options.logPath, logDir: this.#options.logDir }); }
    catch (error) { await this.#reset('log_unavailable', { clearFile: true }); await this.#options.onError(error); return []; }
    const path = paths.at(-1);
    if (!path) { if (this.#file || this.currentState) await this.#reset('log_unavailable', { clearFile: true }); return []; }
    const output = [];
    let handle;
    try { handle = await open(path, 'r'); }
    catch (error) { await this.#reset('log_unavailable', { clearFile: true }); await this.#options.onError(error); return []; }
    try {
      const info = await handle.stat(), identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      const sample = async (length, position) => { const bytes = Buffer.alloc(length); const result = await handle.read(bytes, 0, length, position); return bytes.subarray(0, result.bytesRead); };
      let replaced = this.#file !== path || this.#identity !== identity || info.size < this.#offset;
      if (!replaced && this.#prefix.length) replaced = !(await sample(this.#prefix.length, 0)).equals(this.#prefix);
      if (!replaced && this.#checkpoint.length) replaced = !(await sample(this.#checkpoint.length, this.#offset - this.#checkpoint.length)).equals(this.#checkpoint);
      if (replaced) {
        await this.#reset(this.#file ? 'log_replaced_or_truncated' : 'log_opened', { clearFile: true });
        this.#file = path; this.#identity = identity;
      }
      if (!this.#catchingUp && info.size - this.#offset > this.#options.maxBytesPerPoll) {
        this.#catchingUp = true; await this.#options.onReset({ reason: 'log_catching_up', session_id: this.#options.sessionId });
      }
      let bytes = 0, units = await this.#consumePending(output, this.#options.maxFramesPerPoll);
      while (!this.#pendingEvents.length && this.#offset < info.size && bytes < this.#options.maxBytesPerPoll && units < this.#options.maxFramesPerPoll) {
        const chunk = await sample(Math.min(64 * 1024, info.size - this.#offset, this.#options.maxBytesPerPoll - bytes), this.#offset);
        if (!chunk.length) break;
        this.#offset += chunk.length; bytes += chunk.length;
        this.#pendingEvents = this.#framer.feedEvents(this.#decoder.write(chunk)); this.#pendingIndex = 0;
        const lastLoss = this.#pendingEvents.findLastIndex(event => event.type === 'integrity_loss');
        if (lastLoss >= 0) {
          // Framing already knows a record was lost, so revoke immediately,
          // even if the work budget would otherwise defer that event. Earlier
          // parsed records in this chunk are superseded by the unknown gap.
          output.length = 0; await this.#reset('log_record_integrity_lost');
          this.#pendingEvents = this.#pendingEvents.slice(lastLoss + 1);
        }
        units += await this.#consumePending(output, this.#options.maxFramesPerPoll - units);
      }
      this.#prefix = await sample(Math.min(4096, this.#offset), 0);
      this.#checkpoint = await sample(Math.min(4096, this.#offset), Math.max(0, this.#offset - 4096));
      const behind = this.#offset < info.size || this.#pendingEvents.length > 0;
      if (behind && !this.#catchingUp) {
        this.#catchingUp = true; await this.#options.onReset({ reason: 'log_catching_up', session_id: this.#options.sessionId });
      }
      // Bounded startup/recovery spans polls. No intermediate history enters
      // the coach; the latest state is delivered only after reaching the tail.
      if (this.#catchingUp && !this.#options.emitBootstrapFrames) {
        output.length = 0;
        if (!behind && this.currentState) output.push(this.currentState);
      }
      if (!behind) this.#catchingUp = false;
    } finally { await handle.close(); }
    for (const state of output) await this.#options.onState(state);
    return output;
  }
  pollOnce() {
    if (!this.#poll) this.#poll = this.#pollOnce().catch(async error => {
      await this.#reset('log_read_failed', { clearFile: true }); await this.#options.onError(error); return [];
    }).finally(() => { this.#poll = null; });
    return this.#poll;
  }
  async start() {
    if (this.#running) return this;
    this.#running = true; await this.pollOnce();
    if (!this.#running) return this;
    this.#timer = setInterval(() => { this.pollOnce().catch(error => this.#options.onError(error)); }, this.#options.pollIntervalMs);
    this.#timer.unref?.(); return this;
  }
  async stop() {
    this.#running = false; clearInterval(this.#timer); this.#timer = null;
    if (this.#poll) await this.#poll;
    await this.#reset('stopped', { clearFile: true });
  }
}
