import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archiveReplays, defaultDataDir, getReplay, listReplaySummaries } from './history.mjs';

/** Read only terminal evidence for one indexed match. Never reconstruct logs. */
function terminalEvidence(matchId, dataDir) {
  const database = new DatabaseSync(join(dataDir, 'replay-ingest.sqlite3'), { readOnly: true });
  try {
    return database.prepare(`
      SELECT DISTINCT
        json_extract(m.value, '$.gameStateMessage.gameInfo.gameNumber') AS game_number,
        json_extract(m.value, '$.gameStateMessage.gameStateId') AS state_id
      FROM records r, json_each(r.json, '$.greToClientEvent.greToClientMessages') m
      WHERE r.match_id = ?
        AND json_extract(m.value, '$.gameStateMessage.gameInfo.stage') = 'GameStage_GameOver'
        AND coalesce(json_extract(m.value, '$.gameStateMessage.gameInfo.matchID'),
                     json_extract(m.value, '$.gameStateMessage.gameInfo.matchId'), ?) = ?
    `).all(matchId, matchId, matchId);
  } finally { database.close(); }
}

/** Append a terminal entry to an already archived safe snapshot. No other edits. */
export function appendTerminalSteps(previous, evidence) {
  const changes = [];
  const games = (previous.games ?? []).map(game => {
    if (!Array.isArray(game.steps) || game.steps.some(step => step.event?.type === 'game_over')) return game;
    const source = new Set(evidence.filter(row => row.game_number === game.game_number &&
      Number.isSafeInteger(row.state_id)).map(row => row.state_id));
    const states = Object.entries(game.states ?? {});
    // The first recorded GameOver is authoritative; subsequent end messages
    // must not expose postgame identities or advance a match into another game.
    const terminalIndex = states.findIndex(([, state]) => source.has(state.gameStateId));
    if (terminalIndex < 0) return game;
    const [stateId, snapshot] = states[terminalIndex];
    const last = game.steps.at(-1);
    const lastIndex = last ? states.findIndex(([id]) => id === last.state_id) : -1;
    if (last && (lastIndex < 0 || lastIndex > terminalIndex))
      throw new Error('Terminal evidence precedes the current timeline or its last state is missing.');
    if (!Number.isSafeInteger(snapshot.turn) || snapshot.turn < 1)
      throw new Error('Terminal snapshot lacks an observed turn.');
    const turn = snapshot.turn;
    const occupied = new Set([...game.steps.map(step => step.anchor),
      ...(previous.coachNotes ?? []).map(note => note.anchor)]);
    let suffix = Math.max(0, ...game.steps.map(step =>
      Number(step.anchor?.match(new RegExp(`^T${turn}-A(\\d+)$`))?.[1] ?? 0))) + 1;
    while (occupied.has(`T${turn}-A${suffix}`)) suffix++;
    const anchor = `T${turn}-A${suffix}`;
    const beforeStateId = states[terminalIndex - 1]?.[0] ?? null;
    const count = game.steps.filter(step => step.state_id === stateId).length;
    const terminal = {
      anchor, turn, action: Math.max(0, ...game.steps.filter(step => step.turn === turn).map(step => step.action ?? 0)) + 1,
      event: { type: 'game_over', actor: snapshot.activePlayer ?? 'unknown', phase: snapshot.phase,
        step: snapshot.step, details: 'Game over / terminal snapshot' },
      state_id: stateId, before_state_id: beforeStateId, state_boundary: 'after_gre_message',
      grouped_frame: count > 0, coachNotes: [],
    };
    changes.push({ game_number: game.game_number, anchor, state_id: stateId, game_state_id: snapshot.gameStateId });
    return { ...game, steps: [...game.steps, terminal] };
  });
  return { replay: changes.length ? { ...previous, games } : previous, changes };
}

/** Explicit, sequential maintenance only; no server or polling integration. */
export async function repairTerminalReplay(matchId, { dataDir = defaultDataDir(), apply = false } = {}) {
  if (typeof matchId !== 'string' || !matchId || matchId.length > 200) throw new Error('A single match ID is required.');
  const before = (await listReplaySummaries([matchId], { dataDir }))[0];
  const previous = await getReplay(matchId, { dataDir });
  const after = (await listReplaySummaries([matchId], { dataDir }))[0];
  if (!before || !previous || !after) throw new Error('Unknown archived match.');
  if (before.replay_revision !== after.replay_revision) throw new Error('Archive changed while reading the repair baseline.');
  const { replay, changes } = appendTerminalSteps(previous, terminalEvidence(matchId, dataDir));
  const report = { match_id: matchId, applied: false, added_terminal_steps: changes.length, changes };
  if (!changes.length) return { ...report, no_change: true };
  if (!apply) return { ...report, replay };
  const backupDir = join(dataDir, 'backups', 'replay-terminal-repair');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(matchId).digest('hex').slice(0, 16);
  const backupPath = join(backupDir, `${key}-${randomUUID()}.json`);
  await writeFile(backupPath, JSON.stringify({
    schema: 'replay-terminal-repair-backup/1', revision: after.replay_revision, replay: previous,
  }), { flag: 'wx', mode: 0o600 });
  const result = await archiveReplays([replay], {
    dataDir, replaceRevision: after.replay_revision, strictReplaceRevision: true, updateCards: false,
  });
  if (result.archived !== 1) throw new Error('Archive revision changed or the match is excluded; existing data was preserved.');
  return { ...report, applied: true, backup_path: backupPath };
}
