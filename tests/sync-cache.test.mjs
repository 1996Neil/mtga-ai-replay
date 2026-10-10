import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { coachInputFingerprint, fingerprintFile } from '../src/sync-cache.mjs';
import { coachCardMetadataIds, buildCoachCards } from '../src/coach-cards.mjs';

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const replay = () => ({ deck: [{ arena_id: 100, name: 'Synthetic Front' }], games: [{ states: { S1: {
  players: { opponent: { hand: [{ arena_id: 900, name: 'Synthetic Hidden', visibility: 'hidden' }] } },
} } }] });
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mtga-fingerprint-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'cards'));
  return { dataDir, cardDb: '', displayNamesZh: new Map() };
}
const metadata = (name, extra = {}) => ({ arena_id: 100, name, source: 'scryfall', cache_schema: 2, rules_schema: 1,
  mana_cost: '{1}', type_line: 'Artifact', oracle_text: 'Draw a card.', keywords: [], ...extra });
// Each fixture file describes its own Arena ID. Explicit mismatched identities
// are covered separately by public-card-preparation.test.mjs.
const put = (options, id, value) => writeFile(join(options.dataDir, 'cards', `${id}.json`), JSON.stringify({ ...value, arena_id:id }));

test('replay receipts ignore unrelated and hidden metadata but bind missing, changed and deleted dependencies', async t => {
  const opts = await fixture(t), item = replay();
  const absent = await coachInputFingerprint(item, opts);
  await put(opts, 100, metadata('Synthetic Front'));
  const first = await coachInputFingerprint(item, opts);
  assert.notEqual(first.hash, absent.hash);
  const beforeCards = await buildCoachCards(item, { ...opts, fetchFn: async () => { throw new Error('Unexpected network'); } });
  await put(opts, 999, metadata('Unrelated card'));
  await put(opts, 900, metadata('Hidden card'));
  assert.equal((await coachInputFingerprint(item, opts)).hash, first.hash);
  assert.deepEqual(await buildCoachCards(item, { ...opts, fetchFn: async () => { throw new Error('Unexpected network'); } }), beforeCards);
  const path = join(opts.dataDir, 'cards', '100.json'), info = await stat(path);
  await put(opts, 100, metadata('Synthetic Front', { oracle_text: 'Scry a card.' }));
  await utimes(path, info.atime, info.mtime);
  assert.equal((await stat(path)).size, info.size);
  assert.notEqual((await coachInputFingerprint(item, opts)).hash, first.hash);
  await rm(path);
  assert.equal((await coachInputFingerprint(item, opts)).hash, absent.hash);
});

function createDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE Cards (GrpId INTEGER,TitleId INTEGER,TypeTextId INTEGER,SubtypeTextId INTEGER,OldSchoolManaText TEXT,Power TEXT,Toughness TEXT,AbilityIds TEXT,LinkedFaceGrpIds TEXT);
    CREATE TABLE Localizations_enUS (LocId INTEGER,Formatted INTEGER,Loc TEXT);
    INSERT INTO Cards VALUES (100,1,2,0,'o1','','','1:3','101,999');
    INSERT INTO Cards VALUES (101,4,2,0,'o1','','','1:3','100,102');
    INSERT INTO Cards VALUES (102,5,2,0,'o1','','','1:3','');
    INSERT INTO Localizations_enUS VALUES (1,1,'Synthetic Front'),(2,1,'Artifact'),(3,1,'Draw a card.'),(4,1,'Synthetic Back'),(5,1,'Synthetic Third');
    PRAGMA wal_checkpoint(TRUNCATE);`);
  return db;
}

test('linked-face closure covers cycles, missing DB rows and every metadata read by generation', async t => {
  const opts = await fixture(t); opts.cardDb = join(opts.dataDir, 'cards.mtga');
  const db = createDatabase(opts.cardDb); t.after(() => db.close());
  assert.deepEqual(await coachCardMetadataIds(replay(), opts), [100, 101, 102, 999]);
  await put(opts, 100, { source: 'local', retry_after: Date.now() + 60000 });
  await put(opts, 101, metadata('Synthetic Back', { card_faces: [{ name: 'Synthetic Front', mana_cost: '{1}', type_line: 'Artifact', oracle_text: 'Scry 1.' }] }));
  const observed = [], cards = await buildCoachCards(replay(), { ...opts,
    onMetadata: id => observed.push(id), fetchFn: async () => { throw new Error('Unexpected network'); } });
  const dependencies = new Set(await coachCardMetadataIds(replay(), opts));
  assert.deepEqual(observed, [100, 101]);
  assert.ok(observed.every(id => dependencies.has(id)));
  assert.equal(cards[0].oracle_text, 'Scry 1.');
  const before = await coachInputFingerprint(replay(), opts);
  await put(opts, 101, metadata('Synthetic Back', { card_faces: [{ name: 'Synthetic Front', oracle_text: 'Scry 2.' }] }));
  assert.notEqual((await coachInputFingerprint(replay(), opts)).hash, before.hash);
  const missing = await coachInputFingerprint(replay(), opts);
  await put(opts, 999, metadata('New linked metadata'));
  assert.notEqual((await coachInputFingerprint(replay(), opts)).hash, missing.hash);
});

test('DB WAL changes, replay content and Chinese name maps invalidate generation receipts', async t => {
  const opts = await fixture(t); opts.cardDb = join(opts.dataDir, 'cards.mtga');
  const db = createDatabase(opts.cardDb); t.after(() => db.close());
  const item = replay(), before = await coachInputFingerprint(item, opts), mainBefore = await fingerprintFile(opts.cardDb);
  db.exec("UPDATE Localizations_enUS SET Loc='Scry a card.' WHERE LocId=3");
  assert.equal((await fingerprintFile(opts.cardDb)).hash, mainBefore.hash, 'WAL write leaves database bytes unchanged');
  const afterWal = await coachInputFingerprint(item, opts);
  assert.notEqual(afterWal.core, before.core);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.notEqual((await fingerprintFile(opts.cardDb)).hash, mainBefore.hash);
  assert.notEqual((await coachInputFingerprint(item, opts)).core, afterWal.core);
  const current = await coachInputFingerprint(item, opts);
  item.deck[0].quantity = 4;
  assert.notEqual((await coachInputFingerprint(item, opts)).hash, current.hash);
  const afterReplay = await coachInputFingerprint(item, opts);
  opts.displayNamesZh.set(100, '合成正面');
  assert.notEqual((await coachInputFingerprint(item, opts)).hash, afterReplay.hash);
});

test('an unreadable or incompatible local DB cannot establish a reusable dependency receipt', async t => {
  const opts = await fixture(t); opts.cardDb = join(opts.dataDir, 'unavailable.mtga');
  await put(opts, 100, metadata('Synthetic Front'));
  assert.equal(await coachCardMetadataIds(replay(), opts), null);
  assert.equal(await coachInputFingerprint(replay(), opts), null);
  await writeFile(opts.cardDb, 'Synthetic invalid database');
  assert.equal(await coachCardMetadataIds(replay(), opts), null);
  assert.equal(await coachInputFingerprint(replay(), opts), null);
  let complete;
  const cards = await buildCoachCards(replay(), { ...opts, onDatabaseRead: value => { complete = value; },
    fetchFn: async () => { throw new Error('Unexpected network'); } });
  assert.equal(complete, false); assert.equal(cards.length, 1);
  await rm(opts.cardDb);
  const db = createDatabase(opts.cardDb); db.close();
  const recovered = await coachInputFingerprint(replay(), opts);
  assert.ok(recovered); assert.ok(recovered.metadataIds.includes(101));
});

test('running module rejects changed code and a fresh module binds the new rules bytes', async t => {
  const opts = await fixture(t), isolated = join(opts.dataDir, 'code');
  await cp(join(root, 'src'), join(isolated, 'src'), { recursive: true });
  await cp(join(root, 'node_modules', 'mtga-log-parser'), join(isolated, 'node_modules', 'mtga-log-parser'), { recursive: true });
  await cp(join(root, 'package.json'), join(isolated, 'package.json'));
  const moduleUrl = new URL(`file://${join(isolated, 'src/sync-cache.mjs')}`).href;
  const target = join(isolated, 'src/coach-cards.mjs');
  const child = await exec(process.execPath, ['--input-type=module', '-e', `
    import { appendFile } from 'node:fs/promises';
    const module = await import(${JSON.stringify(moduleUrl)});
    const first = await module.syncRulesFingerprint();
    await appendFile(${JSON.stringify(target)}, '\\n// Synthetic rules version change\\n');
    console.log(JSON.stringify({ first, after: await module.syncRulesFingerprint() }));
  `], { timeout: 15000 });
  const old = JSON.parse(child.stdout.trim()); assert.ok(old.first); assert.equal(old.after, null);
  const fresh = await exec(process.execPath, ['--input-type=module', '-e', `
    const module = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(await module.syncRulesFingerprint()));
  `], { timeout: 15000 });
  assert.notEqual(JSON.parse(fresh.stdout.trim()), old.first);
});
