import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archiveReplays, defaultDataDir, getReplay, listReplaySummaries } from './history.mjs';

/** Evidence stays in the archived snapshots: a cast row whose own frame shows
 * the spell on the stack, followed by a frame where the card is back in the
 * local hand and the stack no longer holds it. Arena rolls a canceled,
 * still-tentative cast back this way, and no spell was ever played. */
export function canceledCastSteps(game) {
  const ids = Object.keys(game.states ?? {});
  const dropped = [];
  for (const step of game.steps ?? []) {
    const card = step.event?.card;
    if (step.event?.type !== 'cast' || !card) continue;
    const before = game.states?.[step.state_id], after = game.states?.[ids[ids.indexOf(step.state_id) + 1]];
    if (!before || !after) continue;
    if (!(before.stack ?? []).some(item => item.arena_id === card.arena_id)) continue;
    if ((after.stack ?? []).some(item => item.arena_id === card.arena_id)) continue;
    if (!(after.players?.me?.hand ?? []).some(item => item.arena_id === card.arena_id)) continue;
    dropped.push(step);
  }
  return dropped;
}

/** Remove exactly those rows and their events. Every other anchor, state,
 * comment and stored byte stays as it was. */
export function dropCanceledCasts(replay) {
  const removed = [];
  const games = (replay.games ?? []).map(game => {
    const steps = canceledCastSteps(game);
    if (!steps.length) return game;
    const anchors = new Set(steps.map(step => step.anchor));
    for (const step of steps) removed.push({ game_number: game.game_number, anchor: step.anchor,
      state_id: step.state_id, card: step.event?.card?.name ?? null });
    return { ...game,
      steps: game.steps.filter(step => !anchors.has(step.anchor)),
      turns: (game.turns ?? []).map(turn => ({ ...turn,
        events: (turn.events ?? []).filter(event => !anchors.has(event.anchor)) })) };
  });
  return { replay: removed.length ? { ...replay, games } : replay, removed };
}

/** Explicit single-match maintenance only; no startup, polling or remote write. */
export async function repairCanceledCasts(matchId, { dataDir = defaultDataDir(), apply = false } = {}) {
  if (typeof matchId !== 'string' || !matchId || matchId.length > 200) throw new Error('A single match ID is required.');
  const before = (await listReplaySummaries([matchId], { dataDir }))[0];
  const previous = await getReplay(matchId, { dataDir });
  const after = (await listReplaySummaries([matchId], { dataDir }))[0];
  if (!before || !previous || !after) throw new Error('Unknown archived match.');
  if (before.replay_revision !== after.replay_revision) throw new Error('Archive changed while reading the repair baseline.');
  const { replay, removed } = dropCanceledCasts(previous);
  const report = { match_id: matchId, applied: false, removed_casts: removed.length, removed };
  if (!removed.length) return { ...report, no_change: true };
  if (!apply) return { ...report, replay };
  const backupDir = join(dataDir, 'backups', 'replay-cast-repair');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(matchId).digest('hex').slice(0, 16);
  const backupPath = join(backupDir, `${key}-${randomUUID()}.json`);
  await writeFile(backupPath, JSON.stringify({
    schema: 'replay-cast-repair-backup/1', revision: after.replay_revision, replay: previous,
  }), { flag: 'wx', mode: 0o600 });
  const result = await archiveReplays([replay], {
    dataDir, replaceRevision: after.replay_revision, strictReplaceRevision: true, updateCards: false,
  });
  if (result.archived !== 1) throw new Error('Archive revision changed or the match is excluded; existing data was preserved.');
  return { ...report, applied: true, backup_path: backupPath };
}
