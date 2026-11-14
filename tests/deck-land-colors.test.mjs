import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadCardLandColors } from '../src/cards.mjs';
import { buildDraftRunIndex, deckLandColors, withDraftRunLandColors } from '../src/draft-runs.mjs';
import { archiveReplays, listReplayDecks, saveCoachNotes } from '../src/history.mjs';

test('missing optional land metadata leaves colors unknown without blocking replay import', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'partial-land-catalog-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const path = join(dir,'cards.sqlite3'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE Cards(GrpId INTEGER PRIMARY KEY)'); db.close();
  const colors = await loadCardLandColors(path);
  assert.equal(colors.size,0);
  assert.equal(deckLandColors([{arena_id:1,quantity:17}], colors).colors_complete,false);
});

test('local land classification ignores hybrid spells and colorless land Colors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'land-labels-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'cards.sqlite3'), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE Enums(Type TEXT, Value INTEGER, LocId INTEGER);
    CREATE TABLE Localizations_enUS(LocId INTEGER, Loc TEXT);
    CREATE TABLE Cards(GrpId INTEGER PRIMARY KEY, Types TEXT, Colors TEXT, ColorIdentity TEXT);
    INSERT INTO Enums VALUES('CardType',5,11);
    INSERT INTO Localizations_enUS VALUES(11,'Land');
    INSERT INTO Cards VALUES(1,'2','3,4','3,4'),(2,'5','','3'),(3,'5','','4'),(4,'5','',''),
      (5,'5','','3,4'),(6,'1,5','','2'),(7,'5','','99');`);
  db.close();
  const colors = await loadCardLandColors(path);
  assert.equal(colors.get(1), null);
  assert.deepEqual(colors.get(2), ['B']);
  assert.deepEqual(colors.get(6), ['U']);
  assert.equal(colors.has(7), false);
  assert.deepEqual(deckLandColors([{arena_id:1,quantity:23},{arena_id:2,quantity:17}], colors), { colors:['B'],colors_complete:true });
  assert.deepEqual(deckLandColors([{arena_id:3,quantity:7},{arena_id:2,quantity:8},{arena_id:5,quantity:1}], colors), { colors:['B','R'],colors_complete:true });
  assert.deepEqual(deckLandColors([{arena_id:4,quantity:17}], colors), { colors:[],colors_complete:true });
  for (const deck of [[], [{arena_id:1}], [{arena_id:99}], [{arena_id:2,quantity:-1}], [{arena_id:2,quantity:1.5}], [{arena_id:7}]]) {
    assert.equal(deckLandColors(deck, colors).colors_complete, false);
  }
  assert.deepEqual(deckLandColors([{arena_id:2,quantity:17},{arena_id:99,quantity:0}], colors).colors, ['B']);
  const localized = new DatabaseSync(path);
  localized.exec("UPDATE Localizations_enUS SET Loc='地' WHERE LocId=11"); localized.close();
  assert.deepEqual([...(await loadCardLandColors(path))], [...colors], 'Chinese type labels preserve the same Arena type enum');
});

test('read adapter uses latest played deck, not pool/spell colors or stale prior deck', () => {
  const run = { colors:['W','U','B','R','G'], colors_complete:true, card_pool:[{arena_id:3}],
    matches:[{id:'latest',started_at:'2026-10-15'}, {id:'older',started_at:'2026-10-14'}] };
  const before = structuredClone(run), catalog = new Map([[1,null],[2,['U']],[3,['R']]]);
  const decks = new Map([['older',[{arena_id:3}]],['latest',[{arena_id:1},{arena_id:2,quantity:17}]]]);
  assert.deepEqual(withDraftRunLandColors([run], decks, catalog)[0].colors, ['U']);
  assert.deepEqual(run, before);
  decks.delete('latest');
  assert.equal(withDraftRunLandColors([run], decks, catalog)[0].colors_complete, false);
});

test('new course summaries classify registered lands rather than hybrid spells or draft pool', () => {
  const [run] = buildDraftRunIndex([
    {Course:{CourseId:'synthetic-course',InternalEventName:'QuickDraft_FRA',CurrentModule:'Play',
      CourseDeck:{MainDeck:[{cardId:1,quantity:23},{cardId:2,quantity:17}]},CardPool:[3]}},
    {matchGameRoomStateChangedEvent:{gameRoomInfo:{gameRoomConfig:{matchId:'synthetic-match',
      reservedPlayers:[{systemSeatId:1,eventId:'QuickDraft_FRA'}]}}}},
    {greToClientEvent:{greToClientMessages:[{type:'GREMessageType_ConnectResp',systemSeatIds:[1]}]}},
  ], [{id:'synthetic-match',event_id:'QuickDraft_FRA',result:'Win'}],
  {cardLandColors:new Map([[1,null],[2,['B']],[3,['G']]])});
  assert.deepEqual(run.colors,['B']); assert.equal(run.colors_complete,true);
});

test('deck projection and cached refresh leave historical replay and notes untouched', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'deck-projection-'));
  t.after(() => rm(dataDir, { recursive:true,force:true }));
  const replay = { schema_version:'2.0',match:{id:'synthetic',started_at:'2026-10-15T00:00:00Z'},deck:[{arena_id:2,quantity:17}],games:[] };
  await archiveReplays([replay], {dataDir});
  await saveCoachNotes('synthetic', [{text:'keep me'}], {dataDir});
  const db = new DatabaseSync(join(dataDir,'replays.sqlite3'), {readOnly:true});
  t.after(() => db.close());
  const snapshot = () => JSON.stringify([db.prepare('SELECT * FROM replays').all(),db.prepare('SELECT * FROM coach_notes').all()]);
  const before = snapshot(), cache = new Map();
  const first = await listReplayDecks(['synthetic','missing'], {dataDir,cache});
  assert.equal(first.size,1);
  assert.deepEqual(first.get('synthetic'),replay.deck);
  assert.strictEqual((await listReplayDecks(['synthetic'], {dataDir,cache})).get('synthetic'), first.get('synthetic'));
  assert.equal(snapshot(),before);
  await new Promise(resolve => setTimeout(resolve, 5));
  replay.deck = [{arena_id:3,quantity:17}];
  await archiveReplays([replay], {dataDir});
  assert.deepEqual((await listReplayDecks(['synthetic'], {dataDir,cache})).get('synthetic'),replay.deck);
});
