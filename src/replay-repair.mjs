import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildReplays } from './replay.mjs';
import { archiveReplays, defaultDataDir, getReplay, listReplaySummaries, safeArchive } from './history.mjs';

const compatibleType = type => ({
  attack: 'attack_selection', block: 'block_selection', put_into_graveyard: 'zone_change',
}[type] ?? type);
const discardableEvent = type => ['attack_selection', 'block_selection', 'attack_selection_cancelled', 'block_selection_cancelled'].includes(type);
function eventKey(event = {}) {
  const type = ['SBA_Deathtouch', 'SBA_ZeroLoyalty', 'SBA_UnattachedAura'].includes(event.details) ? 'zone_change' : compatibleType(event.type);
  return JSON.stringify([type, event.card?.instance_id ?? null,
    event.targets?.map(target => target.instance_id ?? target.player ?? (target.hidden ? 'hidden' : null)) ?? [],
    event.amount ?? null, event.details ?? null, event.from ?? null, event.to ?? null]);
}
const stateKey = (game, step) => game.states?.[step.state_id]?.gameStateId ?? step.state_id;

/** A repair changes interpretation, not the identity of existing links and notes. */
export function preserveReplayAnchors(candidate, previous) {
  if (candidate.match.id !== previous.match.id || candidate.match.account_key !== previous.match.account_key)
    throw new Error('Repair must retain match and account identity.');
  for (const old of previous.games ?? []) {
    const game = candidate.games.find(game => game.game_number === old.game_number);
    if (!game) throw new Error('Repair would remove an archived game.');
    const byFrame = new Map();
    for (const step of game.steps) {
      const id = stateKey(game, step);
      if (!byFrame.has(id)) byFrame.set(id, []);
      byFrame.get(id).push(step);
    }
    const used = new Set(), assigned = new Map(), maximum = new Map();
    const unmatched = [];
    // A canceled tentative cast is announced and then rolled back by a
    // full-state resync; the rebuild drops it, so its archived anchor retires
    // instead of blocking the repair.
    const canceled = new Set((game.canceled ?? []).map(item => `${item.state_id}:${item.arena_id}`));
    for (const step of old.steps ?? []) {
      const number = Number(step.anchor?.match(/-A(\d+)$/)?.[1] ?? 0);
      maximum.set(step.turn, Math.max(maximum.get(step.turn) ?? 0, number));
      if (!step.anchor || used.has(step.anchor)) throw new Error('Archived anchors must be unique.');
      used.add(step.anchor);
      const choices = (byFrame.get(stateKey(old, step)) ?? []).filter(value => !assigned.has(value));
      const next = choices.find(value => eventKey(value.event) === eventKey(step.event)) ??
        (['state', 'phase'].includes(step.event?.type) ? choices[0] : undefined);
      if (next) assigned.set(next, step);
      else unmatched.push(step);
    }
    // A committed event can be one GRE frame after its former tentative
    // selection. Match those old selection anchors only after exact-frame
    // actions have claimed their candidates, so a tentative row cannot steal
    // the final committed action's anchor.
    for (const step of unmatched) {
      if (canceled.has(`${step.state_id}:${step.event?.card?.arena_id}`)) continue;
      if (!discardableEvent(step.event?.type)) throw new Error(`Repair cannot preserve archived anchor ${step.anchor}.`);
      const next = game.steps.find(value => !assigned.has(value) && eventKey(value.event) === eventKey(step.event));
      if (next) assigned.set(next, step);
    }
    for (const step of game.steps) {
      if (assigned.has(step) || !['attack', 'block'].includes(step.event?.type)) continue;
      const previousStep = old.steps.find(value => discardableEvent(value.event?.type) &&
        ![...assigned.values()].includes(value) && eventKey(value.event) === eventKey(step.event));
      if (previousStep) assigned.set(step, previousStep);
    }
    for (const step of game.steps) {
      const previousStep = assigned.get(step);
      if (previousStep) {
        step.anchor = previousStep.anchor;
        step.coachNotes = structuredClone(previousStep.coachNotes ?? []);
      } else {
        const number = (maximum.get(step.turn) ?? 0) + 1;
        maximum.set(step.turn, number); step.anchor = `T${step.turn}-A${number}`;
        if (used.has(step.anchor)) throw new Error('Repair generated a duplicate anchor.');
        used.add(step.anchor);
      }
      if (step.event?.sequence) step.event.anchor = step.anchor;
    }
    // Repair evidence only; it must not enter the archived replay.
    delete game.canceled;
    // A truncated source must never replace the complete archive.
    const states = new Set(Object.values(game.states).map(state => state.gameStateId));
    if (Object.values(old.states ?? {}).some(state => !states.has(state.gameStateId)) ||
        JSON.stringify(game.result) !== JSON.stringify(old.result))
      throw new Error('Repair would change observed coverage or the game result.');
  }
  return candidate;
}

/** Explicit single-match rebuild. No background migrations or remote publication. */
export async function repairArchivedReplay(matchId, { dataDir = defaultDataDir(), apply = false } = {}) {
  if (typeof matchId !== 'string' || !matchId || matchId.length > 200) throw new Error('A single match ID is required.');
  const beforeRead = (await listReplaySummaries([matchId], { dataDir }))[0];
  const previous = await getReplay(matchId, { dataDir });
  const baseline = (await listReplaySummaries([matchId], { dataDir }))[0];
  if (!previous || !beforeRead || !baseline) throw new Error('Unknown archived match.');
  if (beforeRead.replay_revision !== baseline.replay_revision) throw new Error('Archive changed while reading the repair baseline; retry the repair.');
  const database = new DatabaseSync(join(dataDir, 'replay-ingest.sqlite3'), { readOnly: true });
  let records;
  try {
    records = database.prepare('SELECT json FROM records WHERE match_id=? OR match_id IS NULL ORDER BY sequence')
      .all(matchId).map(row => JSON.parse(row.json));
  } finally { database.close(); }
  const names = new Map(), counterNames = new Map();
  try {
    const labels = JSON.parse(await readFile(join(dataDir, 'replay-card-labels.json'), 'utf8'));
    for (const [id, name] of labels.names ?? []) names.set(id, name);
    for (const [id, name] of labels.counterNames ?? []) counterNames.set(id, name);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Existing safe names are only a dictionary. Visibility still comes from each
  // chronological observation, and hidden/postgame identities remain omitted.
  function collect(value) {
    if (!value || typeof value !== 'object' || value.hidden || /hidden|post.?game/i.test(value.visibility ?? '')) return;
    if (value.arena_id && value.name && !/^Arena card /.test(value.name) && !names.has(value.arena_id))
      names.set(value.arena_id, value.name);
    for (const child of Object.values(value)) if (child && typeof child === 'object') collect(child);
  }
  collect(previous);
  const { replays } = await buildReplays(records, names, { counterNames, recordCanceled: true });
  const rebuilt = replays.find(replay => replay.match.id === matchId);
  if (!rebuilt) throw new Error('The retained source cannot rebuild this match.');
  // Compare and preview the exact representation that the archive will store,
  // including hidden-card redaction and omitted protobuf defaults.
  const candidate = JSON.parse(JSON.stringify(safeArchive(preserveReplayAnchors(rebuilt, previous))));
  const report = {
    match_id: matchId, schema_version: candidate.schema_version, applied: false,
    states: candidate.games.reduce((n, game) => n + Object.keys(game.states).length, 0),
    steps: candidate.games.reduce((n, game) => n + game.steps.length, 0),
    retained_anchors: previous.games.reduce((n, game) => n + game.steps.length, 0),
  };
  const { coachNotes: previousNotes, ...previousContent } = previous;
  const { coachNotes: candidateNotes, ...candidateContent } = candidate;
  if (isDeepStrictEqual(candidateContent, previousContent)) return apply
    ? { ...report, no_change: true } : { ...report, no_change: true, replay: candidate };
  if (!apply) return { ...report, replay: candidate };
  const backupDir = join(dataDir, 'backups', 'replay-repair');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const key = createHash('sha256').update(matchId).digest('hex').slice(0, 16);
  const backupPath = join(backupDir, `${key}-${Date.now()}.json`);
  await writeFile(backupPath, JSON.stringify({ schema: 'replay-repair-backup/1', revision: baseline.replay_revision, replay: previous }),
    { mode: 0o600, flag: 'wx' });
  const result = await archiveReplays([candidate], { dataDir, replaceRevision: baseline.replay_revision, strictReplaceRevision: true });
  if (result.archived !== 1) throw new Error('Archive changed during repair or is no longer eligible; the existing replay was preserved.');
  return { ...report, applied: true, backup_path: backupPath };
}
