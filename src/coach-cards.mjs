import { stat } from 'node:fs/promises';
import { discoverCardDatabase } from './cards.mjs';
import { loadInstalledChineseDisplayNames } from './display-names.mjs';
import { getCardMetadata } from './card-cache.mjs';
import { defaultDataDir } from './history.mjs';

const hidden = value => value?.hidden === true || value?.is_face_down === true || value?.face_down === true
  || /hidden|post.?game|private|owner.only/i.test(String(value?.visibility ?? ''));
const validId = value => Number.isSafeInteger(value) && value > 0;

function collectIdentities(replay) {
  const found = new Map();
  function collect(value, trusted = false) {
    if (Array.isArray(value)) { for (const item of value) collect(item, trusted); return; }
    if (!value || typeof value !== 'object' || hidden(value)) return;
    const id = value.arena_id ?? value.arenaId ?? value.grpId;
    if (validId(id) && (trusted || ['public', 'player_known'].includes(value.visibility))) {
      const name = typeof value.name === 'string' ? value.name.replace(/\s+—\s+ability$/i, '') : undefined;
      if (!found.has(id) || (!found.get(id) && name)) found.set(id, name);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'opponent' || key === 'library' || key === 'opponent_hand') continue;
      if (child && typeof child === 'object') collect(child, trusted);
    }
  }
  function event(value) {
    if (!value || hidden(value)) return;
    if (!(value.type === 'draw' && value.actor === 'opponent')) collect(value.card, value.actor === 'me');
    collect(value.targets); collect(value.ability_source); collect(value.source);
  }
  collect(replay.deck, true);
  for (const game of replay.games ?? []) {
    for (const opening of [game.starting_hand, game.initial_hand, game.first_offered_hand, game.offered_hands, game.opening]) collect(opening, true);
    for (const snapshot of Object.values(game.states ?? {})) {
      const me = snapshot.players?.me, opponent = snapshot.players?.opponent;
      for (const zone of ['hand', 'battlefield', 'graveyard', 'exile']) collect(me?.[zone], true);
      for (const zone of ['battlefield', 'graveyard', 'exile']) collect(opponent?.[zone]);
      collect(snapshot.stack);
    }
    for (const step of game.steps ?? []) {
      event(step.event);
      for (const snapshot of [step.state, step.state_before]) if (snapshot) {
        for (const zone of ['hand', 'battlefield', 'graveyard', 'exile']) collect(snapshot.players?.me?.[zone], true);
        for (const zone of ['battlefield', 'graveyard', 'exile']) collect(snapshot.players?.opponent?.[zone]);
        collect(snapshot.stack);
      }
    }
    for (const turn of game.turns ?? []) for (const value of turn.events ?? []) event(value);
  }
  return found;
}

function plainText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value ?? '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      if (entity.startsWith('#')) {
        const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
      }
      return entities[entity.toLowerCase()] ?? match;
    }).trim();
}

function manaSymbols(value) {
  const input = String(value ?? '');
  if (!input) return '';
  const symbols = [...input.matchAll(/o(\d+|\([^)]+\)|[A-Z])/g)];
  if (!symbols.length || symbols.map(match => match[0]).join('') !== input) return null;
  return symbols.map(([, symbol]) => `{${symbol.replace(/^\(|\)$/g, '')}}`).join('');
}
function rulesText(value) {
  return plainText(value).replace(/\{(o[^}]+)\}/g, (match, encoded) => manaSymbols(encoded) ?? match);
}

async function localStaticCards(ids, path, onDatabaseRead) {
  const result = new Map();
  if (!path) { onDatabaseRead?.(true); return result; }
  let database, complete = false;
  try {
    if (!(await stat(path)).isFile()) return result;
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(path, { readOnly: true });
    const query = database.prepare(`SELECT TitleId,TypeTextId,SubtypeTextId,OldSchoolManaText,
      Power,Toughness,AbilityIds,LinkedFaceGrpIds FROM Cards WHERE GrpId=?`);
    const localization = database.prepare(`SELECT Loc FROM Localizations_enUS WHERE LocId=?
      AND Formatted IN (0,1,2) ORDER BY CASE Formatted WHEN 0 THEN 0 WHEN 1 THEN 1 ELSE 2 END LIMIT 1`);
    const textCache = new Map();
    const text = id => {
      if (!textCache.has(id)) textCache.set(id, rulesText(localization.get(id)?.Loc));
      return textCache.get(id);
    };
    const queue = [...ids], processed = new Set();
    for (const id of queue) {
      if (processed.has(id)) continue; processed.add(id);
      const card = query.get(id); if (!card) continue;
      const abilityTexts = String(card.AbilityIds ?? '').split(',').filter(Boolean).map(link => text(Number(link.split(':')[1])));
      // Class/station/level wrappers are client engine strings, not complete
      // Oracle text. Never ship those technical encodings as card rules.
      const usable = abilityTexts.filter(value => value && !/\b[A-Z]+LEVEL\b|\{o[^}]+\}/.test(value));
      const type = text(card.TypeTextId), subtype = text(card.SubtypeTextId);
      const linkedFaces = String(card.LinkedFaceGrpIds ?? '').split(',').map(Number).filter(validId);
      queue.push(...linkedFaces.filter(linked => !processed.has(linked)));
      result.set(id, { name: text(card.TitleId), mana_cost: manaSymbols(card.OldSchoolManaText),
        type_line: type ? `${type}${subtype ? ` — ${subtype}` : ''}` : null,
        power: card.Power != null && String(card.Power) !== '' ? String(card.Power) : null,
        toughness: card.Toughness != null && String(card.Toughness) !== '' ? String(card.Toughness) : null,
        rules_text: usable.length ? usable.join('\n') : null,
        keywords: usable.filter(value => /^[A-Z][a-z]+(?: [a-z]+)?$/.test(value)),
        has_linked_faces: Boolean(card.LinkedFaceGrpIds), linked_face_ids: linkedFaces,
      });
    }
    complete = true;
  } catch { /* Optional local static data must not block the public metadata fallback. */ }
  finally { database?.close(); onDatabaseRead?.(complete); }
  return result;
}

function staticFace(face) {
  const result = { name: face.name ?? null, mana_cost: face.mana_cost ?? null, type_line: face.type_line ?? null,
    oracle_text: typeof face.oracle_text === 'string' ? face.oracle_text : null,
    power: face.power ?? null, toughness: face.toughness ?? null };
  if (Array.isArray(face.keywords)) result.keywords = [...face.keywords];
  return result;
}

/** A conservative superset of every metadata file buildCoachCards can read.
 * Share the identity/linked-face resolver with generation so hidden identities
 * and unrelated cached cards cannot enlarge or invalidate a replay receipt. */
export async function coachCardMetadataIds(replay, { cardDb } = {}) {
  const identities = collectIdentities(replay);
  let complete = false;
  const local = await localStaticCards(identities.keys(), cardDb ?? await discoverCardDatabase(), value => { complete = value; });
  // A transient optional DB failure is acceptable for display generation, but
  // cannot establish a complete dependency set for a reusable receipt.
  if (!complete) return null;
  return [...new Set([...identities.keys(), ...local.keys(),
    ...[...local.values()].flatMap(card => card.linked_face_ids ?? [])])].sort((a, b) => a - b);
}

/** Static rules for legal known identities only; no images, paths or dynamic game stats. */
export async function buildCoachCards(replay, { dataDir = defaultDataDir(), fetchFn = fetch, displayNamesZh, cardDb, onMetadata, onDatabaseRead } = {}) {
  const identities = collectIdentities(replay);
  const local = await localStaticCards(identities.keys(), cardDb ?? await discoverCardDatabase(), onDatabaseRead);
  const chinese = displayNamesZh ?? await loadInstalledChineseDisplayNames();
  const result = [];
  for (const [id, observedName] of [...identities].sort(([a], [b]) => a - b)) {
    const arena = local.get(id);
    const canonicalName = observedName && !/^Arena card \d+$/.test(observedName) ? observedName : arena?.name;
    let metadata;
    try { metadata = await getCardMetadata(id, { dataDir, fetchFn, local: { name: canonicalName ?? `Arena card ${id}` } }); }
    catch { metadata = {}; }
    onMetadata?.(id, metadata);
    // Arena gives adventure/back faces their own IDs. Scryfall may index only
    // the primary face, whose public metadata already contains both rule faces.
    if (metadata.source !== 'scryfall' && arena?.linked_face_ids?.length) {
      for (const linkedId of arena.linked_face_ids) {
        if (linkedId === id) continue;
        let linked;
        try { linked = await getCardMetadata(linkedId, { dataDir, fetchFn, local: { name: local.get(linkedId)?.name } }); }
        catch { continue; }
        onMetadata?.(linkedId, linked);
        const face = linked.card_faces?.find(face => face.name === canonicalName);
        if (linked.source === 'scryfall' && face) {
          // Scryfall's top-level keyword list combines all faces. A separately
          // indexed Arena spell face must not inherit a creature face keyword.
          const faceText = `${face.type_line ?? ''}\n${face.oracle_text ?? ''}`.toLowerCase();
          const keywords = Array.isArray(face.keywords) ? face.keywords
            : Array.isArray(linked.keywords) ? linked.keywords.filter(keyword => faceText.includes(keyword.toLowerCase())) : undefined;
          metadata = { ...linked, mana_cost: face.mana_cost, type_line: face.type_line,
            oracle_text: face.oracle_text, keywords, power: face.power, toughness: face.toughness };
          break;
        }
      }
    }
    const publicRules = metadata.source === 'scryfall';
    const faces = publicRules && Array.isArray(metadata.card_faces) ? metadata.card_faces.map(staticFace) : [];
    const card = {
      arena_id: id, name: canonicalName ?? metadata.name ?? `Arena card ${id}`,
      display_name_zh: chinese.get(id) ?? null,
      mana_cost: arena?.mana_cost ?? (publicRules ? metadata.mana_cost : null) ?? null,
      type_line: arena?.type_line ?? (publicRules ? metadata.type_line : null) ?? null,
      oracle_text: publicRules && typeof metadata.oracle_text === 'string' ? metadata.oracle_text : arena?.rules_text ?? null,
      keywords: publicRules && Array.isArray(metadata.keywords) ? [...metadata.keywords] : arena?.keywords ?? [],
      power: arena?.power ?? (publicRules ? metadata.power : null) ?? null,
      toughness: arena?.toughness ?? (publicRules ? metadata.toughness : null) ?? null,
      card_faces: faces,
      source: publicRules ? arena ? 'local_arena+scryfall' : 'scryfall' : arena ? 'local_arena' : 'unavailable',
      certainty: { identity: 'player_known', rules: publicRules ? 'public_oracle' : arena?.rules_text ? 'local_partial' : 'unknown',
        printed_stats: arena ? 'local_arena' : publicRules ? 'public_card_metadata' : 'unknown' },
    };
    const missing = [];
    if (/^Arena card \d+$/.test(card.name)) missing.push('name');
    if (card.mana_cost === null) missing.push('mana_cost');
    if (!card.type_line) missing.push('type_line');
    if (!publicRules || typeof metadata.oracle_text !== 'string') missing.push('complete_oracle_text');
    if (!publicRules || !Array.isArray(metadata.keywords)) missing.push('keywords');
    if (faces.some(face => !face.name || !face.type_line || typeof face.oracle_text !== 'string')) missing.push('card_faces.rules');
    if (arena?.has_linked_faces && !faces.length) missing.push('card_faces');
    if (/Creature|Vehicle|Spacecraft/.test(card.type_line ?? '') && (card.power === null || card.toughness === null)) missing.push('printed_power_toughness');
    card.missing_fields = missing;
    card.metadata_complete = missing.length === 0;
    card.quality_warnings = missing.length ? ['Static card rules are incomplete; do not assume missing rules or keywords.'] : [];
    result.push(card);
  }
  return result;
}
