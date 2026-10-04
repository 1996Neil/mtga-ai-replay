import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCollectionSnapshot, validateCollectionSnapshot, saveCollectionSnapshot, loadCollectionSnapshot, MAX_COLLECTION_PART_BYTES } from '../src/collection.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const source = 'mtga-reader@0.1.13/readCollection+readInventory';
const initialInventory = { gold: 100, gems: 50, wildcards: { common: 4, uncommon: 3, rare: 2, mythic: 1 } };
function probe(cards = [{ grpId: 1, qty: 1 }], { inventory = initialInventory, at = '2026-01-01T00:00:00.000Z' } = {}) {
  const result = { schema: 'MTGA_COLLECTION_PROBE_V1', read_at: at, source, stable_reads: 2, cards: structuredClone(cards), inventory: structuredClone(inventory) };
  result.content_hash = digest(JSON.stringify({ cards: result.cards, inventory: result.inventory })); return result;
}
async function fixture(t, rows = []) {
  const root = await mkdtemp(join(tmpdir(), 'mtga-collection-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'cards.mtga'), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE Cards (GrpId INTEGER PRIMARY KEY,TitleId INTEGER,Rarity INTEGER,ExpansionCode TEXT,
    CollectorNumber TEXT,CollectorSuffix TEXT,IsPrimaryCard INTEGER,LinkedFaceGrpIds TEXT);
    CREATE TABLE Localizations_enUS (LocId INTEGER,Loc TEXT,Formatted INTEGER);`);
  const card = db.prepare('INSERT INTO Cards VALUES (?,?,?,?,?,?,?,?)'), name = db.prepare('INSERT INTO Localizations_enUS VALUES (?,?,0)');
  for (const row of rows) {
    card.run(row.id, row.id, row.rarity ?? 2, row.set ?? 'TST', row.number ?? String(row.id), row.suffix ?? '', row.primary ?? 1, row.links ?? '');
    name.run(row.id, row.name ?? `Test Card ${row.id}`);
  }
  db.close(); return { root, cardDb: path, displayNamesZh: new Map(), dataDir: join(root, 'data') };
}
function assertInvalid(action) {
  assert.throws(action, error => ['COLLECTION_INVALID', 'MTGA_SYNC_SECURITY'].includes(error.code));
}

test('client metadata keeps distinct printings, unknown IDs, basic land totals and raw linked faces', async t => {
  const options = await fixture(t, [
    { id: 1, name: 'Forest', rarity: 1 }, { id: 2, name: 'Same Name', set: 'ONE' }, { id: 3, name: 'Same Name', set: 'TWO' },
    { id: 4, name: 'Front Face', links: '5', number: '4', suffix: 'a' }, { id: 5, name: 'Back Face', primary: 0, links: '4', number: '4', suffix: 'b' },
    { id: 6, name: 'A-Rebalanced Card', primary: 0 }, { id: 7, name: 'Quantity Anomaly' },
  ]);
  options.displayNamesZh = new Map([[2, '可信中文'], [3, 'English only']]);
  const snapshot = await buildCollectionSnapshot(probe([{ grpId: 1, qty: 100 }, { grpId: 2, qty: 1 }, { grpId: 3, qty: 2 },
    { grpId: 4, qty: 4 }, { grpId: 5, qty: 4 }, { grpId: 6, qty: 1 }, { grpId: 7, qty: 8 }, { grpId: 99, qty: 3 }]), options);
  assert.equal(validateCollectionSnapshot(snapshot), true);
  assert.equal(snapshot.cards.length, 8); assert.equal(snapshot.summary.card_kinds, 7);
  assert.equal(snapshot.summary.raw_total_quantity, 123); assert.equal(snapshot.summary.total_quantity, 119);
  assert.equal(snapshot.summary.duplicate_face_kinds, 1);
  assert.equal(snapshot.cards.find(card => card.grpId === 5).duplicate_of, 4);
  assert.equal(snapshot.cards.find(card => card.grpId === 5).qty, 4);
  assert.equal(snapshot.cards.find(card => card.grpId === 5).counted_qty, 0);
  assert.equal(snapshot.cards.find(card => card.grpId === 6).counted_qty, 1);
  assert.equal(snapshot.cards.find(card => card.grpId === 1).qty, 100);
  assert.deepEqual(snapshot.cards.filter(card => card.name === 'Same Name').map(card => card.set), ['ONE', 'TWO']);
  assert.equal(snapshot.cards.find(card => card.grpId === 2).display_name_zh, '可信中文');
  assert.equal(snapshot.cards.find(card => card.grpId === 3).display_name_zh, null);
  assert.equal(snapshot.cards.at(-1).grpId, 99); assert.equal(snapshot.cards.at(-1).qty, 3); assert.equal(snapshot.cards.at(-1).status, 'unidentified');
  assert.equal(snapshot.summary.unidentified_card_kinds, 1); assert.equal(snapshot.summary.unidentified_quantity, 3);
  assert.equal(snapshot.summary.warnings.length, 4);
});

test('linked metadata alone does not add owned back-face records; conflicting face quantities fail safely', async t => {
  const options = await fixture(t, [{ id: 1, links: '2', number: '1', suffix: 'a' }, { id: 2, primary: 0, links: '1', number: '1', suffix: 'b' }]);
  const snapshot = await buildCollectionSnapshot(probe([{ grpId: 1, qty: 2 }]), options);
  assert.equal(snapshot.cards.length, 1); assert.deepEqual(snapshot.cards[0].linked_face_ids, [2]); assert.equal(snapshot.summary.total_quantity, 2);
  await assert.rejects(buildCollectionSnapshot(probe([{ grpId: 1, qty: 2 }, { grpId: 2, qty: 1 }]), options), error => error.code === 'COLLECTION_INVALID');
});

test('repeated full reads preserve cards and content hashes; resource changes affect only the snapshot hash', async t => {
  const options = await fixture(t, [{ id: 1 }]);
  const first = await buildCollectionSnapshot(probe(), options);
  const second = await buildCollectionSnapshot(probe(undefined, { at: '2026-01-01T00:00:01.000Z' }), options);
  assert.equal(first.summary.content_hash, second.summary.content_hash);
  assert.equal(first.summary.card_content_hash, second.summary.card_content_hash);
  assert.notEqual(first.summary.read_at, second.summary.read_at);
  const inventory = { ...initialInventory, gold: 101 };
  const third = await buildCollectionSnapshot(probe(undefined, { inventory }), options);
  assert.notEqual(first.summary.content_hash, third.summary.content_hash);
  assert.equal(first.summary.card_content_hash, third.summary.card_content_hash);
});

test('error objects, malformed or partial resources and empty full reads never become successful snapshots', async () => {
  const options = { cardDb: null, displayNamesZh: new Map() };
  const cases = [{ error: 'synthetic denied' }, probe([]), probe([{ grpId: 1, qty: 0 }]),
    probe([{ grpId: 1, qty: -1 }]), probe([{ grpId: 2, qty: 1 }, { grpId: 1, qty: 1 }]), probe([{ grpId: 1, qty: 1 }, { grpId: 1, qty: 1 }])];
  const missing = probe(); delete missing.inventory.wildcards.rare; cases.push(missing);
  const unknown = probe(); unknown.inventory.gems = null; cases.push(unknown);
  const unstable = probe(); unstable.stable_reads = 1; cases.push(unstable);
  const corruptHash = probe(); corruptHash.content_hash = 'a'.repeat(64); cases.push(corruptHash);
  const extra = probe(); extra.account = 'synthetic'; cases.push(extra);
  const badTime = probe(); badTime.read_at = '2026-99-99T00:00:00.000Z'; cases.push(badTime);
  for (const value of cases) await assert.rejects(buildCollectionSnapshot(value, options), error => error.code === 'COLLECTION_INVALID');
});

test('missing local card data leaves quantities and unknown metadata intact', async () => {
  const snapshot = await buildCollectionSnapshot(probe([{ grpId: 90001, qty: 9 }]), { cardDb: null, displayNamesZh: new Map() });
  assert.equal(snapshot.cards[0].name, null); assert.equal(snapshot.cards[0].display_name_zh, null);
  assert.equal(snapshot.cards[0].qty, 9); assert.equal(snapshot.summary.total_quantity, 9);
  assert.equal(snapshot.summary.unidentified_card_kinds, 1);
});

test('UTF-8 shards are complete and independently hashed within the 32 KiB ceiling', async t => {
  const ids = Array.from({ length: 600 }, (_, index) => index + 1), options = await fixture(t, ids.map(id => ({ id })));
  options.displayNamesZh = new Map(ids.map(id => [id, '中文卡牌名称'.repeat(20)]));
  const snapshot = await buildCollectionSnapshot(probe(ids.map(grpId => ({ grpId, qty: grpId % 4 + 1 }))), options);
  assert.ok(snapshot.manifest.parts.length > 1);
  const restored = [];
  for (const path of snapshot.manifest.parts) {
    const bytes = snapshot.files.get(path), metadata = snapshot.manifest.files[path], part = JSON.parse(bytes);
    assert.ok(Buffer.byteLength(bytes) <= MAX_COLLECTION_PART_BYTES);
    assert.equal(metadata.bytes, Buffer.byteLength(bytes)); assert.equal(metadata.sha256, digest(bytes));
    assert.equal(metadata.record_count, part.cards.length); restored.push(...part.cards);
  }
  assert.deepEqual(restored, snapshot.cards); assert.equal(snapshot.summary.record_count, 600);
  assert.equal(digest(JSON.stringify(restored)), snapshot.summary.card_content_hash);
});

test('strict snapshot whitelist rejects hidden fields, noncanonical bytes, missing shards and inconsistent totals', async t => {
  const options = await fixture(t, [{ id: 1 }]), original = await buildCollectionSnapshot(probe(), options);
  const cases = [];
  const hidden = structuredClone(original); hidden.cards[0].account_id = 'synthetic-private'; cases.push(hidden);
  const extra = structuredClone(original); extra.files.set('collection/latest/secret.json', '{}\n'); cases.push(extra);
  const missing = structuredClone(original); missing.files.delete(missing.manifest.parts[0]); cases.push(missing);
  const bytes = structuredClone(original); bytes.files.set(bytes.manifest.parts[0], `${bytes.files.get(bytes.manifest.parts[0])} `); cases.push(bytes);
  const total = structuredClone(original); total.summary.total_quantity++; cases.push(total);
  const hash = structuredClone(original); hash.manifest.files[hash.manifest.parts[0]].sha256 = 'a'.repeat(64); cases.push(hash);
  const inventory = structuredClone(original); inventory.inventory.wildcards.rare = undefined; cases.push(inventory);
  for (const snapshot of cases) assertInvalid(() => validateCollectionSnapshot(snapshot));
});

test('the shared byte scanner rejects unsafe card names without echoing the secret', async t => {
  const secret = 'ghp_SyntheticSecretMustNotEscape', options = await fixture(t, [{ id: 1, name: secret }]);
  await assert.rejects(buildCollectionSnapshot(probe(), options), error => error.code === 'MTGA_SYNC_SECURITY' && !error.message.includes(secret));
});

test('atomic save and load reuse exact card inodes for repeated reads and changed resources', async t => {
  const options = await fixture(t, [{ id: 1 }]);
  assert.equal(await loadCollectionSnapshot(options), null);
  const first = await buildCollectionSnapshot(probe(), options), firstSave = await saveCollectionSnapshot(first, options);
  assert.equal(firstSave.cardContentChanged, true); assert.deepEqual((await loadCollectionSnapshot(options)).cards, first.cards);
  const firstFile = join(options.dataDir, 'collection', 'versions', firstSave.version, 'parts', 'cards-001.json'), firstInfo = await stat(firstFile);
  const second = await buildCollectionSnapshot(probe(undefined, { at: '2026-01-01T00:00:01.000Z', inventory: { ...initialInventory, gold: 101 } }), options);
  const secondSave = await saveCollectionSnapshot(second, options), secondInfo = await stat(join(options.dataDir, 'collection', 'versions', secondSave.version, 'parts', 'cards-001.json'));
  assert.equal(secondSave.cardContentChanged, false); assert.equal(firstInfo.ino, secondInfo.ino); assert.equal(firstInfo.mtimeMs, secondInfo.mtimeMs);
  assert.equal((await loadCollectionSnapshot(options)).inventory.gold, 101);
  // Saving the identical version again is idempotent as well.
  assert.equal((await saveCollectionSnapshot(second, options)).version, secondSave.version);
});

test('normal new cards pass while decreases, missing old cards and abnormal growth preserve the previous pointer', async t => {
  const options = await fixture(t, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  const first = await buildCollectionSnapshot(probe([{ grpId: 1, qty: 2 }, { grpId: 2, qty: 1 }]), options);
  await saveCollectionSnapshot(first, options);
  const normal = await buildCollectionSnapshot(probe([{ grpId: 1, qty: 3 }, { grpId: 2, qty: 1 }, { grpId: 3, qty: 1 }], { at: '2026-01-01T00:00:01.000Z' }), options);
  assert.equal((await saveCollectionSnapshot(normal, options)).cardContentChanged, true);
  const pointer = await readFile(join(options.dataDir, 'collection', 'current.json'), 'utf8');
  const decreased = await buildCollectionSnapshot(probe([{ grpId: 1, qty: 2 }, { grpId: 2, qty: 1 }, { grpId: 3, qty: 1 }], { at: '2026-01-01T00:00:02.000Z' }), options);
  const missing = await buildCollectionSnapshot(probe([{ grpId: 1, qty: 3 }, { grpId: 3, qty: 1 }], { at: '2026-01-01T00:00:02.000Z' }), options);
  for (const snapshot of [decreased, missing]) await assert.rejects(saveCollectionSnapshot(snapshot, options), error => error.code === 'COLLECTION_DECREASE');
  const growthCards = [{ grpId: 1, qty: 3 }, { grpId: 2, qty: 1 }, { grpId: 3, qty: 1 }, ...Array.from({ length: 101 }, (_, index) => ({ grpId: index + 100, qty: 1 }))];
  const growth = await buildCollectionSnapshot(probe(growthCards, { at: '2026-01-01T00:00:02.000Z' }), options);
  await assert.rejects(saveCollectionSnapshot(growth, options), error => error.code === 'COLLECTION_LARGE_CHANGE');
  assert.equal(await readFile(join(options.dataDir, 'collection', 'current.json'), 'utf8'), pointer);
  assert.equal((await loadCollectionSnapshot(options)).summary.total_quantity, 5);
});

test('invalid saved bytes and a symlink destination fail without overwriting the successful snapshot or outside data', async t => {
  const options = await fixture(t, [{ id: 1 }]), snapshot = await buildCollectionSnapshot(probe(), options);
  const saved = await saveCollectionSnapshot(snapshot, options);
  const pointerPath = join(options.dataDir, 'collection', 'current.json'), pointer = await readFile(pointerPath, 'utf8');
  const invalid = structuredClone(snapshot); invalid.summary.total_quantity = 0;
  await assert.rejects(saveCollectionSnapshot(invalid, options), error => error.code === 'COLLECTION_INVALID');
  assert.equal(await readFile(pointerPath, 'utf8'), pointer);
  const part = join(options.dataDir, 'collection', 'versions', saved.version, 'parts', 'cards-001.json');
  await writeFile(part, '{"schema":"broken"}\n');
  await assert.rejects(loadCollectionSnapshot(options), error => error.code === 'COLLECTION_INVALID');
  const symlinkData = join(options.root, 'symlink-data'), outside = join(options.root, 'outside');
  await mkdir(symlinkData); await mkdir(outside); await writeFile(join(outside, 'sentinel'), 'keep');
  await symlink(outside, join(symlinkData, 'collection'));
  await assert.rejects(saveCollectionSnapshot(snapshot, { dataDir: symlinkData }), error => error.code === 'COLLECTION_INVALID');
  assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');
});

test('a live local save lock prevents a second writer; failures leave the selected snapshot unchanged', async t => {
  const options = await fixture(t, [{ id: 1 }]), snapshot = await buildCollectionSnapshot(probe(), options);
  await saveCollectionSnapshot(snapshot, options);
  const root = join(options.dataDir, 'collection'), pointer = await readFile(join(root, 'current.json'), 'utf8');
  await writeFile(join(root, 'save.lock'), String(process.pid));
  await assert.rejects(saveCollectionSnapshot(snapshot, options), error => error.code === 'COLLECTION_BUSY');
  assert.equal(await readFile(join(root, 'current.json'), 'utf8'), pointer);
});
