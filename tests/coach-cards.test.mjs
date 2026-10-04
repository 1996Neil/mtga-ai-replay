import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildCoachCards } from '../src/coach-cards.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'mtga-coach-cards-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
const card = (arena_id, name, visibility = 'public') => ({ arena_id, name, visibility, instance_id: arena_id + 1000 });
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const rules = name => ({ name, mana_cost: '{2}{G}', type_line: 'Creature — Elk', oracle_text: 'Reach', keywords: ['Reach'], power: '3', toughness: '3',
  id: 'synthetic-provider-id', image_uris: { normal: 'https://cards.scryfall.io/normal/synthetic.jpg' } });

test('rules dictionary covers unplayed full deck and legal public actions, excludes hidden identities, and never copies dynamic stats', async (t) => {
  const dataDir = await directory(t), ids = [];
  const own = card(100, 'Synthetic Own Creature', 'player_known'), publicCard = card(102, 'Synthetic Opponent Creature');
  const privateCard = card(998, 'Synthetic Hidden Hand', 'hidden');
  const replay = { deck: [{ arena_id: 100, name: own.name, quantity: 4 }, { arena_id: 101, name: 'Synthetic Unplayed Creature', quantity: 1 }],
    games: [{ starting_hand: [own], states: { S0: { players: { me: { hand: [own], battlefield: [] },
      opponent: { hand: [privateCard, card(997, 'Injected Untagged Opponent Hand')], battlefield: [publicCard], exile: [card(999, 'Synthetic Face Down', 'hidden')] } }, stack: [] },
      S1: { players: { me: { hand: [], battlefield: [{ ...own, power: 20, toughness: 20 }] }, opponent: { battlefield: [publicCard] } }, stack: [] } },
      steps: [{ event: { type: 'cast', actor: 'opponent', card: card(103, 'Synthetic Public Spell') } },
        { event: { type: 'draw', actor: 'opponent', card: card(996, 'Injected Opponent Draw') } }], turns: [] }],
  };
  const before = structuredClone(replay);
  const result = await buildCoachCards(replay, { dataDir, cardDb: '', displayNamesZh: new Map([[100, '本机中文名']]), fetchFn: async url => {
    const id = Number(String(url).match(/arena\/(\d+)$/)?.[1]); ids.push(id); return response(rules(`Provider Card ${id}`));
  } });
  assert.deepEqual(result.map(value => value.arena_id), [100, 101, 102, 103]);
  assert.deepEqual(ids, [100, 101, 102, 103]);
  assert.equal(result[0].name, 'Synthetic Own Creature');
  assert.equal(result[0].display_name_zh, '本机中文名');
  assert.equal(result[0].power, '3'); assert.equal(result[0].toughness, '3');
  assert.equal(result.every(value => value.metadata_complete), true);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic Hidden|Injected|Face Down|instance_id|image|https:|synthetic-provider-id|\/Users\//);
  assert.deepEqual(replay, before);
});

test('legacy cache upgrades complete both DFC face rules and keywords, with stable output on later cache-only imports', async (t) => {
  const dataDir = await directory(t), replay = { deck: [{ arena_id: 104, name: 'Synthetic Front', quantity: 1 }], games: [] };
  await mkdir(join(dataDir, 'cards'));
  await writeFile(join(dataDir, 'cards', '104.json'), JSON.stringify({ source: 'scryfall', cache_schema: 2, name: 'Synthetic Front', oracle_text: 'Old front only' }));
  let requests = 0;
  const opts = { dataDir, cardDb: '', displayNamesZh: new Map(), fetchFn: async () => { requests++; return response({
    name: 'Synthetic Front // Synthetic Back', keywords: ['Flying', 'Transform'], layout: 'transform', card_faces: [
      { name: 'Synthetic Front', mana_cost: '{1}{U}', type_line: 'Creature — Human', oracle_text: 'Transform this creature.', power: '1', toughness: '1', image_uris: { normal: 'https://cards.scryfall.io/front.jpg' } },
      { name: 'Synthetic Back', mana_cost: '', type_line: 'Creature — Insect', oracle_text: 'Flying', power: '3', toughness: '2', image_uris: { normal: 'https://cards.scryfall.io/back.jpg' } },
    ],
  }); } };
  const first = await buildCoachCards(replay, opts);
  assert.equal(requests, 1);
  assert.equal(first[0].metadata_complete, true);
  assert.deepEqual(first[0].keywords, ['Flying', 'Transform']);
  assert.equal(first[0].card_faces[1].oracle_text, 'Flying');
  assert.equal(first[0].card_faces[1].power, '3');
  assert.match(first[0].oracle_text, /Synthetic Front.*Transform[\s\S]*Synthetic Back.*Flying/s);
  assert.doesNotMatch(JSON.stringify(first), /image_source|https:|fetched_at|generated_at|cache_schema/);
  const second = await buildCoachCards(replay, { ...opts, fetchFn: async () => { throw new Error('Cache must be reused'); } });
  assert.deepEqual(second, first);
});

async function localDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE Cards (GrpId INTEGER,TitleId INTEGER,TypeTextId INTEGER,SubtypeTextId INTEGER,OldSchoolManaText TEXT,Power TEXT,Toughness TEXT,AbilityIds TEXT,LinkedFaceGrpIds TEXT);
    CREATE TABLE Localizations_enUS (LocId INTEGER,Formatted INTEGER,Loc TEXT);
    INSERT INTO Cards VALUES (105,1000,1001,1002,'o4oGoG','6','6','7:1003','');
    INSERT INTO Localizations_enUS VALUES (1000,1,'Synthetic Local Creature'),(1001,1,'Creature'),(1002,1,'Elk'),(1003,1,'Flash');`);
  db.close();
}

test('existing read-only Arena static fields take precedence over dynamic replay and only limited local rules are claimed offline', async (t) => {
  const dataDir = await directory(t), cardDb = join(dataDir, 'synthetic.mtga'); await localDatabase(cardDb);
  const replay = { deck: [{ arena_id: 105, name: 'Synthetic Local Creature', quantity: 1 }], games: [{
    states: { S1: { players: { me: { battlefield: [{ ...card(105, 'Synthetic Local Creature'), power: 20, toughness: 20 }] } } } },
  }] };
  const complete = await buildCoachCards(replay, { dataDir, cardDb, displayNamesZh: new Map(), fetchFn: async () => response({ ...rules('Synthetic Local Creature'), power: '3', mana_cost: '{9}' }) });
  assert.equal(complete[0].mana_cost, '{4}{G}{G}'); assert.equal(complete[0].type_line, 'Creature — Elk');
  assert.equal(complete[0].power, '6'); assert.equal(complete[0].source, 'local_arena+scryfall');
  assert.equal(complete[0].metadata_complete, true);
  const offlineDir = join(dataDir, 'offline');
  const limited = await buildCoachCards(replay, { dataDir: offlineDir, cardDb, displayNamesZh: new Map(), fetchFn: async () => { throw new Error('Synthetic offline'); } });
  assert.equal(limited[0].power, '6'); assert.equal(limited[0].oracle_text, 'Flash');
  assert.equal(limited[0].source, 'local_arena'); assert.equal(limited[0].certainty.rules, 'local_partial');
  assert.equal(limited[0].metadata_complete, false);
  assert.ok(limited[0].missing_fields.includes('complete_oracle_text')); assert.ok(limited[0].quality_warnings.length);
});

test('unavailable oracle or incomplete face rules are explicitly incomplete, while genuine empty vanilla text is complete', async (t) => {
  const dataDir = await directory(t), replay = { deck: [{ arena_id: 106, name: 'Synthetic Vanilla' }, { arena_id: 107, name: 'Synthetic Missing' }], games: [] };
  const result = await buildCoachCards(replay, { dataDir, cardDb: '', displayNamesZh: new Map(), fetchFn: async url => {
    if (String(url).endsWith('/106')) return response({ ...rules('Synthetic Vanilla'), oracle_text: '', keywords: [] });
    return response({ name: 'Synthetic Missing', mana_cost: '', type_line: 'Land', keywords: [], card_faces: [
      { name: 'Synthetic Front', mana_cost: '', type_line: 'Land', oracle_text: '' }, { name: 'Synthetic Back', mana_cost: '', type_line: 'Land' },
    ] });
  } });
  assert.equal(result[0].metadata_complete, true); assert.equal(result[0].oracle_text, '');
  assert.equal(result[1].metadata_complete, false); assert.ok(result[1].missing_fields.includes('card_faces.rules'));
  const missing = await buildCoachCards({ deck: [{ arena_id: 108, name: 'Synthetic Offline' }], games: [] }, { dataDir,
    cardDb: '', displayNamesZh: new Map(), fetchFn: async () => { throw new Error('Synthetic offline'); } });
  assert.equal(missing[0].oracle_text, null); assert.equal(missing[0].metadata_complete, false);
  assert.ok(missing[0].missing_fields.includes('complete_oracle_text'));
});

test('unindexed Arena adventure face reuses the linked primary card full public rules without losing its canonical name', async (t) => {
  const dataDir = await directory(t), cardDb = join(dataDir, 'faces.mtga'); await localDatabase(cardDb);
  const db = new DatabaseSync(cardDb);
  db.exec(`UPDATE Cards SET LinkedFaceGrpIds='106' WHERE GrpId=105;
    INSERT INTO Cards VALUES (106,1004,1005,0,'o1oW','','','8:1006','105');
    INSERT INTO Localizations_enUS VALUES (1004,1,'Synthetic Rebound'),(1005,1,'Instant'),(1006,1,'Draw a card.');`);
  db.close();
  const cards = await buildCoachCards({ deck: [{ arena_id: 106, name: 'Synthetic Rebound' }], games: [] }, {
    dataDir, cardDb, displayNamesZh: new Map(), fetchFn: async url => {
      if (!String(url).endsWith('/105')) return new Response('{}', { status: 404 });
      return response({ name: 'Synthetic Local Creature // Synthetic Rebound', keywords: ['Adventure', 'Vigilance'], card_faces: [
        { name: 'Synthetic Local Creature', mana_cost: '{4}{G}{G}', type_line: 'Creature — Elk', oracle_text: 'Flash', power: '6', toughness: '6' },
        { name: 'Synthetic Rebound', mana_cost: '{1}{W}', type_line: 'Instant — Adventure', oracle_text: 'Draw a card.' },
      ] });
    },
  });
  assert.equal(cards.length, 1); assert.equal(cards[0].arena_id, 106);
  assert.equal(cards[0].name, 'Synthetic Rebound');
  assert.equal(cards[0].oracle_text, 'Draw a card.');
  assert.equal(cards[0].metadata_complete, true);
  assert.equal(cards[0].card_faces.length, 2);
  assert.deepEqual(cards[0].keywords, ['Adventure']);
  assert.doesNotMatch(JSON.stringify(cards), /linked_face_ids|image_source|https:/);
});

test('offline rules-schema upgrade preserves existing safe public oracle cache and marks missing keywords honestly', async (t) => {
  const dataDir = await directory(t); await mkdir(join(dataDir, 'cards'));
  await writeFile(join(dataDir, 'cards', '109.json'), JSON.stringify({ source: 'scryfall', cache_schema: 2,
    name: 'Synthetic Cached Spell', mana_cost: '{R}', type_line: 'Instant', oracle_text: 'Deal 2 damage to any target.' }));
  let requests = 0;
  const opts = { dataDir, cardDb: '', displayNamesZh: new Map(), fetchFn: async () => { requests++; throw new Error('Offline schema upgrade'); } };
  const replay = { deck: [{ arena_id: 109, name: 'Synthetic Cached Spell' }], games: [] };
  const first = await buildCoachCards(replay, opts), second = await buildCoachCards(replay, opts);
  assert.equal(first[0].oracle_text, 'Deal 2 damage to any target.');
  assert.equal(first[0].metadata_complete, false); assert.deepEqual(first[0].missing_fields, ['keywords']);
  assert.equal(requests, 1); assert.deepEqual(first, second);
});
