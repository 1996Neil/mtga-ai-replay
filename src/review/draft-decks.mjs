import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { validAccountKey } from '../account-scope.mjs';
import { draftReviewFingerprint } from './draft-review.mjs';
import { discoverCardDatabase } from '../cards.mjs';

const basicNames = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp', 'Snow-Covered Mountain', 'Snow-Covered Forest']);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw Error('Invalid draft deck data'); };
const keyFor = card => basicNames.has(card.name) ? `basic:${card.name}` : `arena:${card.arena_id}`;
async function localDeckProperties(ids) {
  const result = new Map();
  let db;
  try {
    const path = await discoverCardDatabase();
    if (!path) return result;
    db = new DatabaseSync(path, { readOnly: true });
    const card = db.prepare('SELECT TypeTextId,SubtypeTextId,OldSchoolManaText FROM Cards WHERE GrpId=?');
    const loc = db.prepare(`SELECT Loc FROM Localizations_enUS WHERE LocId=? AND Formatted IN (0,1,2)
      ORDER BY CASE Formatted WHEN 0 THEN 0 WHEN 1 THEN 1 ELSE 2 END LIMIT 1`);
    const label = id => String(loc.get(id)?.Loc ?? '').replace(/<[^>]*>/g, '').trim();
    for (const id of ids) {
      const row = card.get(id);
      if (!row) continue;
      const input = String(row.OldSchoolManaText ?? '');
      const symbols = [...input.matchAll(/o(\d+|\([^)]+\)|[A-Z])/g)];
      const mana_cost = !input ? '' : symbols.map(match => match[0]).join('') === input
        ? symbols.map(([, value]) => `{${value.replace(/^\(|\)$/g, '')}}`).join('') : null;
      result.set(id, { mana_cost, type_line: [label(row.TypeTextId), label(row.SubtypeTextId)].filter(Boolean).join(' — ') });
    }
  } catch { /* Missing static data leaves an explicit unknown cost/type. */ }
  finally { db?.close(); }
  return result;
}

export function canonicalDraftDeck(cards) {
  if (!Array.isArray(cards) || !integer(cards.length, 1, 100)) fail();
  const grouped = new Map();
  for (const card of cards) {
    if (!integer(card.arena_id, 1, 2147483647) || !text(card.name, 180) || !integer(card.quantity, 1, 100)) fail();
    const key = keyFor(card), previous = grouped.get(key);
    if (previous) previous.quantity += card.quantity;
    else grouped.set(key, { arena_id: card.arena_id, name: card.name, quantity: card.quantity, key });
  }
  if ([...grouped.values()].some(card => card.quantity > 100)) fail();
  return [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key));
}
export function draftDeckChanges(from, to) {
  const left = new Map(canonicalDraftDeck(from).map(card => [card.key, card]));
  const right = new Map(canonicalDraftDeck(to).map(card => [card.key, card]));
  const added = [], removed = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const delta = (right.get(key)?.quantity ?? 0) - (left.get(key)?.quantity ?? 0);
    if (delta > 0) added.push({ ...right.get(key), quantity: delta });
    if (delta < 0) removed.push({ ...left.get(key), quantity: -delta });
  }
  return { added, removed };
}
export function draftDeckVersions(matches) {
  const ordered = [...matches].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)) || a.id.localeCompare(b.id));
  const versions = [];
  let previousFingerprint = null;
  for (const match of ordered) {
    if (!match.deck) { previousFingerprint = null; continue; }
    const cards = canonicalDraftDeck(match.deck);
    const fingerprint = hash(JSON.stringify(cards.map(card => [card.key, card.quantity])));
    let version = versions.at(-1);
    if (!version || previousFingerprint !== fingerprint) {
      version = { version: versions.length + 1, fingerprint, cards, matches: [],
        started_at: match.started_at, last_used_at: match.started_at, wins: 0, losses: 0,
        changes_from_previous: versions.length ? draftDeckChanges(versions.at(-1).cards, cards) : { added: [], removed: [] } };
      versions.push(version);
    }
    version.matches.push({ id: match.id, started_at: match.started_at, result: match.result });
    version.last_used_at = match.started_at;
    if (match.result === 'Win') version.wins++;
    if (match.result === 'Loss') version.losses++;
    previousFingerprint = fingerprint;
  }
  return versions;
}
export function draftDeckCategory(typeLine) {
  if (/Creature|生物/i.test(typeLine)) return 'creature';
  if (/Planeswalker|鹏洛客|旅法师/i.test(typeLine)) return 'planeswalker';
  if (/Instant|瞬间/i.test(typeLine)) return 'instant';
  if (/Sorcery|法术/i.test(typeLine)) return 'sorcery';
  if (/Enchantment|结界/i.test(typeLine)) return 'enchantment';
  if (/Artifact|神器/i.test(typeLine)) return 'artifact';
  if (/Land|(?:基本)?地(?:$| —)/i.test(typeLine)) return 'land';
  return 'other';
}
export function draftManaValue(cost) {
  if (typeof cost !== 'string') return null;
  if (cost === '') return 0;
  const symbols = [...cost.matchAll(/\{([^}]+)\}/g)];
  if (symbols.map(match => match[0]).join('') !== cost) return null;
  return symbols.reduce((sum, [, symbol]) => sum + (/^\d+$/.test(symbol) ? Number(symbol)
    : ['X', 'Y', 'Z'].includes(symbol) ? 0 : /^2\//.test(symbol) ? 2 : 1), 0);
}
export function draftSelectionFinished(run) {
  if (!Array.isArray(run?.picks) || !run.picks.length || run.picks.some(pick => !pick.complete)) return false;
  const picks = [...run.picks].sort((a, b) => a.pack_number - b.pack_number || a.pick_number - b.pick_number);
  let count = 0;
  for (let pack = 1; pack <= 3; pack++) {
    const values = picks.filter(pick => pick.pack_number === pack), size = values[0]?.candidates?.length;
    if (!integer(size, 1, 30) || values.length !== size ||
        values.some((pick, index) => pick.pick_number !== index + 1 || !pick.selected ||
          !pick.candidates.some(card => card.arena_id === pick.selected.arena_id))) return false;
    count += values.length;
  }
  return count === picks.length;
}
async function recommendationFile(run, dataDir) {
  let handle;
  try {
    for (const path of [join(dataDir, 'draft-decks'), join(dataDir, 'draft-decks', run.account_key)]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) fail();
    }
    const path = join(dataDir, 'draft-decks', run.account_key, `${run.run_id}.json`);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) fail();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const buffer = Buffer.alloc(128 * 1024 + 1); let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 128 * 1024) fail();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
export function validateDraftRecommendation(value, run, metadata) {
  const fields = ['schema', 'run_id', 'account_key', 'event_id', 'source_fingerprint', 'generated_at', 'title', 'plan', 'choices', 'cards'];
  if (!value || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) ||
      value.schema !== 'MTGA_DRAFT_DECK_RECOMMENDATION_V1' ||
      value.run_id !== run.run_id || value.account_key !== run.account_key ||
      value.event_id !== run.event_id || !/^[a-f0-9]{64}$/.test(value.source_fingerprint ?? '') ||
      !text(value.generated_at, 24) || !Number.isFinite(Date.parse(value.generated_at)) ||
      new Date(value.generated_at).toISOString() !== value.generated_at ||
      !text(value.title, 240) || !text(value.plan, 3000) ||
      !Array.isArray(value.choices) || value.choices.length > 10 ||
      value.choices.some(choice => !choice || Object.keys(choice).length !== 2 ||
        !text(choice.title, 160) || !text(choice.reason, 1200))) fail();
  if (!draftSelectionFinished(run) || value.source_fingerprint !== draftReviewFingerprint(run))
    return { status: 'stale', recommendation: null };
  const pool = new Map();
  for (const pick of run.picks) pool.set(pick.selected.arena_id, (pool.get(pick.selected.arena_id) ?? 0) + 1);
  const cards = canonicalDraftDeck(value.cards);
  if (cards.reduce((sum, card) => sum + card.quantity, 0) !== 40) fail();
  for (const card of cards) {
    const info = metadata.get(card.arena_id);
    const isBasic = basicNames.has(card.name) && info?.name === card.name &&
      /Basic.*Land|基本地/i.test(info.type_line ?? '');
    if (!isBasic && (pool.get(card.arena_id) ?? 0) < card.quantity) fail();
    if (!isBasic && basicNames.has(card.name)) fail();
  }
  return { status: 'ready', recommendation: { title: value.title, plan: value.plan,
    choices: value.choices, generated_at: value.generated_at, cards } };
}

/** Derive deck history from small archived deck fields, never full replay states. */
export async function readDraftDeckComparison(run, { dataDir, accountKey, displayNamesZh = new Map() }) {
  if (!/^[a-f0-9]{32}$/.test(run?.run_id ?? '') || !validAccountKey(accountKey) || run.account_key !== accountKey) fail();
  const result = { run_id: run.run_id, account_key: accountKey, finished: draftSelectionFinished(run),
    status: 'ready', recommendation_status: 'missing', recommendation: null, versions: [] };
  if (!result.finished) return { ...result, status: 'incomplete' };
  let db;
  const metadata = new Map(), raw = [];
  try {
    const dbPath = join(dataDir, 'replays.sqlite3');
    try {
      const info = await lstat(dbPath);
      if (!info.isFile() || info.isSymbolicLink()) fail();
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('BEGIN');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const accountVerified = run.binding_account_status === 'matched' ||
      run.binding_account_status === 'unknown' && run.ownership_corrected === true &&
      run.binding_method === 'exact_card_pool' && run.binding_account_key === accountKey &&
      /^[a-f0-9]{32}$/.test(run.bound_run_id ?? '');
    if (db && run.binding === 'matched_pool' && accountVerified) {
      const query = db.prepare(`SELECT started_at, summary_json, json_extract(replay_json,'$.deck') AS deck
        FROM replays WHERE match_id=?`);
      for (const match of run.matches) {
        const row = query.get(match.id);
        if (!row || !row.deck) { raw.push({ id: match.id, started_at: match.started_at, deck: null }); continue; }
        const summary = JSON.parse(row.summary_json);
        if (summary.account_key !== accountKey) continue;
        raw.push({ id: match.id, started_at: row.started_at, result: summary.result, deck: JSON.parse(row.deck) });
      }
    }
    let value;
    try {
      value = await recommendationFile(run, dataDir);
      if (value && (!Array.isArray(value.cards) || value.cards.length > 100 ||
          value.cards.some(card => !integer(card?.arena_id, 1, 2147483647)))) fail();
    } catch { result.recommendation_status = 'error'; value = null; }
    const ids = new Set([...run.picks.map(pick => pick.selected.arena_id),
      ...raw.flatMap(match => (match.deck ?? []).map(card => card.arena_id)),
      ...(Array.isArray(value?.cards) ? value.cards.map(card => card.arena_id) : [])]);
    if ([...ids].some(id => !integer(id, 1, 2147483647))) fail();
    const cardQuery = db?.prepare('SELECT name,metadata_json FROM cards WHERE arena_id=?');
    for (const id of ids) {
      const saved = cardQuery?.get(id);
      let card = saved ? { ...JSON.parse(saved.metadata_json), name: saved.name } : {};
      if (!card.type_line || card.mana_cost == null) {
        try {
          const path = join(dataDir, 'cards', `${id}.json`), info = await lstat(path);
          if (info.isFile() && !info.isSymbolicLink() && info.size <= 32 * 1024)
            card = { ...JSON.parse(await readFile(path, 'utf8')), ...card };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      metadata.set(id, card);
    }
    const incomplete = [];
    for (const [id, card] of metadata) {
      const face = card.card_faces?.find(face => face.name === card.name) ?? card.card_faces?.[0];
      if (face) {
        card.mana_cost = face.mana_cost ?? card.mana_cost;
        card.type_line = face.type_line ?? card.type_line;
      }
      if (!card.type_line || draftManaValue(card.mana_cost) === null) incomplete.push(id);
    }
    if (incomplete.length) {
      for (const [id, properties] of await localDeckProperties(incomplete)) {
        const card = metadata.get(id);
        if (!card.type_line) card.type_line = properties.type_line;
        if (draftManaValue(card.mana_cost) === null) card.mana_cost = properties.mana_cost;
      }
    }
    if (value) {
      try {
        const checked = validateDraftRecommendation(value, run, metadata);
        result.recommendation_status = checked.status;
        result.recommendation = checked.recommendation;
      } catch { result.recommendation_status = 'error'; }
    }
    const enrich = cards => cards.map(card => {
      const info = metadata.get(card.arena_id) ?? {};
      return { ...card, display_name_zh: displayNamesZh.get(card.arena_id) ?? info.display_name_zh ?? null,
        mana_cost: typeof info.mana_cost === 'string' ? info.mana_cost : null,
        mana_value: draftManaValue(info.mana_cost), type_line: info.type_line ?? '',
        category: draftDeckCategory(info.type_line ?? '') };
    });
    if (result.recommendation) result.recommendation.cards = enrich(result.recommendation.cards);
    result.versions = draftDeckVersions(raw).map(version => ({ ...version, cards: enrich(version.cards),
      comparison: result.recommendation ? draftDeckChanges(version.cards, result.recommendation.cards) : null }));
    return result;
  } finally { db?.close(); }
}
