import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { createRecordFramer, readRecords } from '../src/log-reader.mjs';
import { LiveSource, ReplaySource, LOCKED_REPLAY_REF } from '../src/live-coach/sources.mjs';
import { snapshotToLiveState } from '../src/live-coach/state.mjs';

const repoDir = process.env.MTGA_PRIVATE_CORPUS_DIR ?? fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);
const room = matchId => ({ matchGameRoomStateChangedEvent: { gameRoomInfo: { gameRoomConfig: { matchId,
  reservedPlayers: [{ systemSeatId: 2, playerName: 'private-me' }, { systemSeatId: 1, playerName: 'private-opponent' }] } } } });
const envelope = (...messages) => ({ greToClientEvent: { greToClientMessages: messages } });
const msg = (id, gsm, seats = [2]) => ({ type: 'GREMessageType_GameStateMessage', systemSeatIds: seats, msgId: id, gameStateMessage: gsm });
const zone = (zoneId, type, ownerSeatId, ids = []) => ({ zoneId, type: `ZoneType_${type}`, ownerSeatId,
  visibility: type === 'Hand' ? 'Visibility_Private' : 'Visibility_Public', objectInstanceIds: ids });
const object = (instanceId, grpId, ownerSeatId, zoneId, extra = {}) => ({ instanceId, grpId, ownerSeatId,
  controllerSeatId: ownerSeatId, zoneId, type: 'GameObjectType_Card', visibility: 'Visibility_Public',
  power: { value: 2 }, toughness: { value: 2 }, cardTypes: ['CardType_Creature'], ...extra });
const full = (id = 1, extra = {}) => ({ type: 'GameStateType_Full', gameStateId: id, gameInfo: { gameNumber: 1 },
  turnInfo: { turnNumber: 1, activePlayer: 2, priorityPlayer: 2, phase: 'Phase_Main1' },
  players: [{ systemSeatNumber: 2, lifeTotal: 20 }, { systemSeatNumber: 1, lifeTotal: 20 }],
  zones: [zone(20, 'Battlefield', 0, [101, 201]), zone(30, 'Hand', 2, [102]), zone(31, 'Hand', 1, [202]),
    zone(32, 'Graveyard', 2), zone(33, 'Graveyard', 1), zone(34, 'Exile', 2), zone(35, 'Exile', 1), zone(40, 'Stack', 0)],
  gameObjects: [object(101, 1001, 2, 20), object(201, 2001, 1, 20), object(102, 1002, 2, 30),
    object(202, 9999, 1, 31, { visibility: 'Visibility_Private', viewers: [1] })], ...extra });
const diff = (id, extra = {}) => ({ type: 'GameStateType_Diff', gameStateId: id, ...extra });
const text = (...records) => records.map(r => JSON.stringify(r, null, 2)).join('\n') + '\n';
const names = new Map([[1001, 'My creature'], [1002, 'My spell'], [2001, 'Their public creature'], [9999, 'Future secret sentinel']]);
const rules = [...names].map(([arena_id, name]) => ({ arena_id, name, oracle_text: 'Visible static rule.' }));
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'mtga-live-source-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('shared framing handles UTF-8 boundaries, partial records, strings containing braces and old dedup', async t => {
  const dir = await temp(t), path = join(dir, 'Player.log');
  const record = envelope(msg(1, full(1, { harmlessText: '中文 } [ \\"' })));
  const bytes = Buffer.from(text(record)), index = bytes.indexOf(Buffer.from('中')) + 1;
  const decoder = new StringDecoder('utf8'), framer = createRecordFramer();
  assert.deepEqual(framer.feed(decoder.write(bytes.subarray(0, index))), []);
  const result = framer.feed(decoder.write(bytes.subarray(index)));
  assert.deepEqual(result, [record]);
  framer.feed('DETAILED LOGS: EN'); framer.feed('ABLED'); assert.equal(framer.detailed, true);
  await writeFile(path, text(record, record) + '{"greToClientEvent":');
  const batch = await readRecords([path, path]); assert.equal(batch.records.length, 1);
});

test('shared framing reports ordered integrity loss and discards oversized nested fragments until the outer record ends', () => {
  const framer = createRecordFramer({ acceptRecord: () => true, maxRecordCharacters: 32 });
  const oversized = JSON.stringify({ padding: 'x'.repeat(80), nested: { greToClientEvent: {} } });
  const events = framer.feedEvents('{"before":1}' + oversized.slice(0, 70));
  assert.deepEqual(events.map(event => event.type), ['record', 'integrity_loss']);
  assert.equal(framer.integrityLossCount, 1); assert.equal(framer.pending, true);
  assert.ok(framer.bufferedCharacters <= 32);
  const recovered = framer.feedEvents(oversized.slice(70) + '{"after":2}');
  assert.deepEqual(recovered, [{ type: 'record', record: { after: 2 } }]);
  assert.equal(framer.pending, false);
  assert.deepEqual(framer.feed('{"compatible":3}'), [{ compatible: 3 }], 'old feed API still returns only records');
});

test('LiveState omits future names, opponent identities and results; dynamic stats stay current', () => {
  const snapshot = { turn: 9, phase: 'Phase_Main2', activePlayer: 'me', priorityPlayer: 'me', stack: [],
    result: 'future-result-sentinel', known_opponent_information: { hidden: 'future-secret' },
    players: { me: { name: 'private-name', life: 20, hand: [], battlefield: [{ name: 'Current creature', arena_id: 1,
      instance_id: 10, power: 4, toughness: 4, counters: [{ type: 1, name: '+1/+1', count: 1 }] }], graveyard: [], exile: [] },
    opponent: { name: 'private-opponent', life: 20, handSize: 1, hand: [{ name: 'future-secret' }], battlefield: [], graveyard: [], exile: [] } } };
  const state = snapshotToLiveState(snapshot, { sessionId: 's', matchId: 'm', gameId: 1, seq: 1, stateId: 'S1',
    rules: [{ arena_id: 1, name: 'Current creature', oracle_text: '' }, { arena_id: 2, name: 'future-secret', oracle_text: '' }] });
  assert.equal(state.board.players.me.battlefield[0].power, 4);
  assert.deepEqual(state.board.players.opponent.hand, []); assert.equal(state.board.players.opponent.handSize, 1);
  assert.equal(state.board.players.opponent.name, 'Opponent'); assert.deepEqual(state.rules.map(r => r.arena_id), [1]);
  assert.equal(JSON.stringify(state).includes('future-'), false); assert.equal(state.priority.fresh, false);
  assert.equal(state.life_lost_this_turn.opponent, null);
});

test('incremental tail emits complete ordered GREs only and binds real offered actions to the current window', async t => {
  const dir = await temp(t), path = join(dir, 'Player.log'); await writeFile(path, '');
  const source = new LiveSource({ logPath: path, names, rules }); t.after(() => source.stop());
  await source.pollOnce();
  const first = text(room('match-one'), envelope(msg(1, full())));
  await appendFile(path, first.slice(0, -15)); assert.deepEqual(await source.pollOnce(), []);
  await appendFile(path, first.slice(-15)); const [state] = await source.pollOnce();
  assert.equal(state.coverage.state_complete, true); assert.equal(state.priority.fresh, true);
  assert.equal(JSON.stringify(state).includes('Future secret sentinel'), false);
  const offered = { type: 'GREMessageType_ActionsAvailableReq', systemSeatIds: [2], msgId: 2, gameStateId: 1,
    actionsAvailableReq: { actions: [{ actionType: 'ActionType_Cast', instanceId: 102, grpId: 1002 }] } };
  await appendFile(path, text(envelope(offered, offered, msg(3, diff(2, { gameObjects: [{ instanceId: 101, power: 4 }] })),
    msg(4, diff(3, { players: [{ systemSeatNumber: 1, lifeTotal: 17 }] })))));
  const changes = await source.pollOnce(); assert.equal(changes.length, 3);
  assert.equal(changes[0].offered_actions.actions[0].instanceId, 102);
  assert.equal(changes[0].offered_actions.observed_seq, changes[0].seq);
  assert.equal(changes[1].offered_actions, null); assert.equal(changes[1].priority.fresh, false);
  assert.equal(changes[1].board.players.me.battlefield[0].power, 4);
  assert.equal(changes[2].life_lost_this_turn.opponent, true);
  assert.ok(changes[0].seq < changes[1].seq && changes[1].seq < changes[2].seq);
  await appendFile(path, text(envelope(msg(4, diff(3)), { ...offered, msgId: 99 })));
  assert.deepEqual(await source.pollOnce(), [], 'duplicate GSM and stale offered state ID are ignored');
});

test('same-size and larger in-place replacement reset state, UTF-8 decoder and require a new Full', async t => {
  const dir = await temp(t), path = join(dir, 'Player.log'), resets = [];
  const initial = text(room('match-one'), envelope(msg(1, full()))); await writeFile(path, initial);
  const source = new LiveSource({ logPath: path, names, rules, onReset: value => resets.push(value.reason) }); t.after(() => source.stop());
  assert.equal((await source.pollOnce())[0].match_id, 'match-one');
  const replacement = text(room('match-two'), envelope(msg(2, diff(2))));
  await writeFile(path, replacement.padEnd(Buffer.byteLength(initial), ' '));
  assert.deepEqual(await source.pollOnce(), []); assert.equal(source.currentState, null);
  assert.ok(resets.includes('log_replaced_or_truncated'));
  await appendFile(path, text(envelope(msg(3, full(3, { turnInfo: { turnNumber: 9, activePlayer: 2, phase: 'Phase_Main1' } })))));
  const [next] = await source.pollOnce(); assert.equal(next.match_id, 'match-two'); assert.equal(next.priority.player, null);
  assert.equal(next.life_lost_this_turn.opponent, null);
  await writeFile(path, text(room('match-three'), envelope(msg(4, diff(4)))).padEnd(Buffer.byteLength(initial) + 300, ' '));
  assert.deepEqual(await source.pollOnce(), []); assert.equal(source.currentState, null);
});

test('inode replacement and truncation cannot stitch unfinished JSON or retain a previous game', async t => {
  const dir = await temp(t), path = join(dir, 'Player.log');
  await writeFile(path, text(room('match-one'), envelope(msg(1, full()))) + '{"greToClientEvent":');
  const source = new LiveSource({ logPath: path, names, rules }); t.after(() => source.stop());
  await source.pollOnce();
  const replacement = join(dir, 'replacement');
  await writeFile(replacement, text(room('match-two'), envelope(msg(1, full())))); await rename(replacement, path);
  assert.equal((await source.pollOnce())[0].match_id, 'match-two');
  await writeFile(path, '{}\n'); assert.deepEqual(await source.pollOnce(), []); assert.equal(source.currentState, null);
});

test('a running reader discovers a newly created log and clears committed combat on cancellation/end combat', async t => {
  const dir = await temp(t), oldPath = join(dir, 'Player.log');
  await writeFile(oldPath, text(room('match-old'), envelope(msg(1, full())))); await utimes(oldPath, new Date(1000), new Date(1000));
  const source = new LiveSource({ logDir: dir, names, rules }); t.after(() => source.stop());
  await source.pollOnce();
  const path = join(dir, 'UTC_Log - fresh.log');
  await writeFile(path, text(room('match-new'), envelope(msg(1, full()))));
  assert.equal((await source.pollOnce())[0].match_id, 'match-new');
  await appendFile(path, text(envelope(msg(2, diff(2, { turnInfo: { phase: 'Phase_Combat' },
    gameObjects: [object(101, 1001, 2, 20, { attackState: 'AttackState_Declared', attackInfo: { targetId: 1 } })] })),
    msg(3, diff(3, { gameObjects: [object(101, 1001, 2, 20)] })))));
  const [selected, cancelled] = await source.pollOnce();
  assert.deepEqual(selected.committed_combat.attackers, [101]); assert.deepEqual(cancelled.committed_combat.attackers, []);
  assert.equal(cancelled.tentative.known, false);
  await appendFile(path, text(envelope(msg(4, diff(4, { gameObjects: [object(101, 1001, 2, 20,
    { attackState: 'AttackState_Attacking', attackInfo: { targetId: 1 } })] })), msg(5, diff(5, { turnInfo: { step: 'Step_EndCombat' } })))));
  const changes = await source.pollOnce(); assert.deepEqual(changes.at(-1).committed_combat.attackers, []);
});

test('unknown local seat, missing Full, new game and terminal reveal all fail closed', async t => {
  const dir = await temp(t), path = join(dir, 'Player.log');
  await writeFile(path, text(room('m'), envelope(msg(1, full(), [1, 2]))));
  const source = new LiveSource({ logPath: path, names, rules }); t.after(() => source.stop());
  assert.deepEqual(await source.pollOnce(), []);
  await appendFile(path, text(envelope(msg(1, diff(1))))); assert.deepEqual(await source.pollOnce(), []);
  await appendFile(path, text(envelope(msg(1, full())))); assert.equal((await source.pollOnce()).length, 1, 'prior Diff cannot suppress same-ID Full recovery');
  await appendFile(path, text(envelope(msg(2, diff(2, { gameInfo: { gameNumber: 2 } })))));
  assert.deepEqual(await source.pollOnce(), []); assert.equal(source.currentState, null);
  await appendFile(path, text(envelope(msg(3, full(3, { gameInfo: { gameNumber: 2 } })))));
  assert.equal((await source.pollOnce())[0].game_id, '2');
  await appendFile(path, text(envelope(msg(4, diff(4, { gameInfo: { gameNumber: 2, stage: 'GameStage_GameOver' },
    players: [{ systemSeatNumber: 1, lifeTotal: 0 }], gameObjects: [object(202, 9999, 1, 20)],
    zones: [zone(20, 'Battlefield', 0, [101, 201, 202])] })))));
  const [ended] = await source.pollOnce(); assert.equal(ended.terminal, true); assert.equal(ended.board.players.opponent.life, 0);
  assert.equal(JSON.stringify(ended).includes('Future secret sentinel'), false);
  await appendFile(path, text(envelope(msg(5, diff(5))))); assert.deepEqual(await source.pollOnce(), []);
});

test('automatic polling discovers appended records and stop removes the polling lifecycle', async t => {
  const dir = await temp(t), path = join(dir, 'Player.log'); await writeFile(path, '');
  let deliver, calls = 0;
  const event = new Promise(resolve => { deliver = resolve; });
  const source = new LiveSource({ logPath: path, names, rules, pollIntervalMs: 5,
    onState: state => { calls++; deliver(state); } }); t.after(() => source.stop());
  await source.start(); await appendFile(path, text(room('automatic'), envelope(msg(1, full()))));
  let timeout;
  const state = await Promise.race([event, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('automatic poll did not deliver')), 1000); })]);
  clearTimeout(timeout); assert.equal(state.match_id, 'automatic');
  await source.stop(); await appendFile(path, text(envelope(msg(2, diff(2)))));
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(calls, 1); assert.equal(source.currentState, null);
});

test('large bootstrap and subsequent backlog obey byte/GRE budgets and never deliver historical intermediate frames', async t => {
  const dir = await temp(t), path = join(dir, 'Player.log'), delivered = [], resets = [];
  const history = [room('bounded'), envelope(msg(1, full())), envelope(...Array.from({ length: 1200 }, (_, i) => msg(i + 2,
    diff(i + 2, { gameObjects: [{ instanceId: 101, power: i + 3 }] }))))];
  const initial = text(...history); await writeFile(path, initial);
  const maxBytesPerPoll = 8 * 1024, maxFramesPerPoll = 17;
  const source = new LiveSource({ logPath: path, names, rules, maxBytesPerPoll, maxFramesPerPoll, pollIntervalMs: 60000,
    onState: state => delivered.push(state), onReset: value => resets.push(value.reason) }); t.after(() => source.stop());
  await source.start();
  assert.equal(delivered.length, 0, 'start returns after one budget, before historical replay reaches the tail');
  assert.equal(source.progress.catching_up, true); assert.ok(source.progress.read_offset <= maxBytesPerPoll);
  assert.ok((source.currentState?.seq ?? 0) <= maxFramesPerPoll);
  let polls = 1;
  while (source.progress.catching_up && polls++ < 300) {
    const before = source.progress.read_offset, seq = source.currentState?.seq ?? 0, frames = await source.pollOnce();
    assert.ok(source.progress.read_offset - before <= maxBytesPerPoll, 'payload read budget applies to every poll');
    assert.ok((source.currentState?.seq ?? seq) - seq <= maxFramesPerPoll, 'single large GRE envelope is resumed by message cursor');
    assert.ok(frames.length <= 1, 'bootstrap keeps only the latest state rather than an array of historical snapshots');
  }
  assert.ok(polls < 300); assert.equal(delivered.length, 1);
  assert.equal(delivered[0].seq, 1201); assert.equal(delivered[0].board.players.me.battlefield[0].power, 1202);
  assert.equal(source.progress.pending_events, 0);
  const appended = envelope(...Array.from({ length: 300 }, (_, i) => msg(1202 + i,
    diff(1202 + i, { gameObjects: [{ instanceId: 101, power: 2000 + i }] }))));
  await appendFile(path, text(appended)); const initialBacklog = await source.pollOnce();
  assert.deepEqual(initialBacklog, []); assert.equal(delivered.length, 1);
  assert.ok(resets.includes('log_catching_up'), 'existing advice is revoked when the observer falls behind');
  polls = 0;
  while (source.progress.catching_up && polls++ < 100) assert.ok((await source.pollOnce()).length <= 1);
  assert.ok(polls < 100); assert.equal(delivered.length, 2);
  assert.equal(delivered[1].board.players.me.battlefield[0].power, 2299);
});

test('framing overflow revokes old Full immediately; following Diffs stay unknown until identity and a reliable Full recover', async t => {
  const dir = await temp(t), path = join(dir, 'Player.log'), resets = [], observed = [];
  await writeFile(path, text(room('integrity'), envelope(msg(1, full()))));
  const source = new LiveSource({ logPath: path, names, rules, maxRecordCharacters: 8192,
    onReset: value => resets.push(value.reason), onState: state => observed.push(state) }); t.after(() => source.stop());
  assert.equal((await source.pollOnce()).length, 1); assert.equal(source.currentState.coverage.state_complete, true);
  const oversized = envelope(msg(2, diff(2, { padding: 'x'.repeat(9000), gameObjects: [{ instanceId: 101, power: 99 }] })));
  await appendFile(path, text(oversized, envelope(msg(3, diff(3, { gameObjects: [{ instanceId: 101, power: 7 }] })))));
  assert.deepEqual(await source.pollOnce(), []); assert.equal(source.currentState, null);
  assert.ok(resets.includes('log_record_integrity_lost')); assert.equal(source.progress.integrity_losses, 1);
  assert.ok(source.progress.framing_characters <= 8192); assert.equal(observed.length, 1);
  await appendFile(path, text(envelope(msg(4, full(4)))));
  assert.deepEqual(await source.pollOnce(), [], 'a missed room record could have changed match, so old identity is not reused');
  await appendFile(path, text(room('integrity'), envelope(msg(5, full(5, {
    gameObjects: [object(101, 1001, 2, 20, { power: { value: 6 } }), object(201, 2001, 1, 20), object(102, 1002, 2, 30)],
    players: [{ systemSeatNumber: 2, lifeTotal: 11 }, { systemSeatNumber: 1, lifeTotal: 17 }]
  })))));
  const [recovered] = await source.pollOnce(); assert.equal(recovered.match_id, 'integrity');
  assert.equal(recovered.board.players.me.battlefield[0].power, 6); assert.equal(recovered.board.players.me.life, 11);
  assert.equal(recovered.life_lost_this_turn.opponent, null); assert.equal(recovered.coverage.state_complete, true);
});

test('locked real ReplaySource verifies every SHA/byte count and freezes only the chronological prefix', { skip: (!process.env.MTGA_PRIVATE_CORPUS_DIR) ? 'Private locked corpus is excluded from this source export' : false }, async () => {
  const source = await ReplaySource.open({ repoDir, matchId: '32cdbcfa-61f6-4a18-a0a1-afad6dab3062', sessionId: 'regression' });
  const state = source.stateAt('S110'); assert.equal(state.seq, 110); assert.equal(state.turn, 6); assert.equal(state.terminal, false);
  assert.equal(state.coverage.state_complete, true); assert.equal(state.result, undefined); assert.equal(state.board.result, undefined);
  assert.equal(state.priority.fresh, false); assert.deepEqual(state.board.players.opponent.hand, []);
  assert.ok(state.board.players.me.hand.some(c => c.name === 'Rabid Gnaw'));
  assert.equal(Object.isFrozen(state.board.players.me.hand), true);
  const replay = source.viewerReplay(); const anchor = replay.games[0].steps.find(s => s.state_id === 'S110').anchor;
  assert.equal(source.stateForAnchor(anchor).state_id, 'S110');
  const frames = []; for await (const frame of source.frames()) frames.push(frame);
  assert.equal(frames.length, 265); assert.equal(frames.at(-1).terminal, true); assert.equal(frames.at(-1).terminal_source, 'end_of_recorded_game');
  await assert.rejects(ReplaySource.open({ repoDir, matchId: source.summary.match_id, ref: 'HEAD' }), /locked/);
  await assert.rejects(ReplaySource.open({ repoDir, matchId: source.summary.match_id,
    readBlob: async (root, ref, path) => {
      const { stdout } = await run('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      return path.endsWith('/cards.json') ? Buffer.concat([stdout, Buffer.from(' ')]) : stdout;
    } }), /integrity mismatch/);
  assert.equal(source.summary.ref, LOCKED_REPLAY_REF);
});

test('real final attacker and dynamic P/T seeds use complete snapshots, not accumulated event labels', { skip: (!process.env.MTGA_PRIVATE_CORPUS_DIR) ? 'Private locked corpus is excluded from this source export' : false }, async () => {
  const attacks = await ReplaySource.open({ repoDir, matchId: 'd48bc0ac-23ed-448e-b742-a1146df534f0' });
  const frame = attacks.stateAt('S232'), cards = frame.board.players.opponent.battlefield;
  assert.ok(cards.find(c => c.name === 'Wedgelight Rammer').is_attacking);
  assert.equal(cards.find(c => c.name === 'Dawnwing Marshal').is_attacking, false);
  assert.equal(frame.committed_combat.attackers.length, 1);
  const dynamic = await ReplaySource.open({ repoDir, matchId: '8e6f1b7e-4240-4b86-a96e-9ec2b354c44e' });
  const state = dynamic.stateAt('S207'), spark = state.board.players.me.battlefield.find(c => c.name === 'Frilled Sparkshooter');
  assert.equal(spark.power, 4); assert.equal(spark.toughness, 4); assert.equal(spark.counters[0].count, 1);
  assert.equal(state.life_lost_this_turn.opponent, true);
});
