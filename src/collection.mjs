import { withCollectionLock } from './collection-lock.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, open, rm, link } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discoverCardDatabase, loadCardNames } from './cards.mjs';
import { loadInstalledChineseDisplayNames } from './display-names.mjs';
import { defaultDataDir } from './history.mjs';
import { validateBundleFiles } from './sync-security.mjs';
import { collectionAccountKey, collectionPrefix, collectionReadmePath, collectionStoreRoot } from './collection-scope.mjs';

export const MAX_COLLECTION_PART_BYTES = 32 * 1024;
const SOURCE = 'mtga-reader@0.1.13/readCollection+readInventory';
const HASH = /^[a-f0-9]{64}$/;
const PART = /^collection\/(?:accounts\/[a-f0-9]{64}\/)?latest\/parts\/cards-[0-9]{3,6}\.json$/;
const PREFIX = 'collection/latest/';
const RARITIES = new Map([[0, 'unknown'], [1, 'basic_land'], [2, 'common'], [3, 'uncommon'], [4, 'rare'], [5, 'mythic']]);
const CARD_KEYS = ['grpId', 'qty', 'counted_qty', 'duplicate_of', 'name', 'display_name_zh', 'set', 'collector_number', 'rarity', 'is_primary', 'linked_face_ids', 'status'];
const SUMMARY_KEYS = ['schema', 'read_at', 'verified_at', 'record_count', 'card_kinds', 'total_quantity', 'raw_total_quantity', 'unidentified_card_kinds', 'unidentified_quantity', 'duplicate_face_kinds', 'source', 'stable_reads', 'coverage', 'warnings', 'content_hash', 'card_content_hash'];
const INVENTORY_KEYS = ['schema', 'read_at', 'verified_at', 'content_hash', 'gold', 'gems', 'wildcards'];
const MANIFEST_KEYS = ['schema', 'read_at', 'verified_at', 'content_hash', 'card_content_hash', 'record_count', 'card_kinds', 'total_quantity', 'parts', 'files'];
const RESOURCES = ['gold', 'gems', 'wildcards'];
const WILDCARDS = ['common', 'uncommon', 'rare', 'mythic'];
const WARNING_API = 'Two stable full-collection API reads were validated. This does not independently prove every client card count; consult the separate client comparison evidence.';
const WARNING_UNKNOWN = 'Unidentified cards retain their original Arena IDs and quantities. Missing metadata is unknown.';
const WARNING_QUANTITY = 'Some non-basic-land quantities exceed four. They are retained without truncation and require a client comparison.';
const WARNING_FACE = 'Linked front/back representations were retained with original quantities; duplicate faces have counted_qty zero and duplicate_of identifies the counted printing.';
const README = `# Private MTGA collection snapshot

Read collection/latest/summary.json, inventory.json and manifest.json first.
Use manifest.parts to read every collection/latest/parts/cards-*.json file.
Each part contains complete card records; verify file bytes, SHA256, record counts
and the manifest's complete part list. Empty or truncated connector responses do
not establish a complete collection. Unread records and unavailable metadata
remain unknown. Never infer an empty collection from a missing response.

grpId and qty preserve the full-collection API representation. Different printings
remain separate even when their names match. Do not sum linked face duplicates:
use counted_qty for totals and duplicate_of for the corresponding primary record.
Linked face metadata does not create an additional owned card record. Basic-land
and unusual quantities are preserved. Missing Chinese names remain null.

The inventory and cards share content_hash and read_at. content_hash excludes
verification timestamps; card_content_hash covers normalized card records only.
All quantities and six resources come from one stable full read. This snapshot
does not establish Standard legality, bans, playable-copy equivalence or a deck.
API consistency and local validation do not replace independent client checks.
No raw logs, account identity, credentials, local paths, images or full database
are included. Publication changes only the collection namespace.
`;
const serialize = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = value => createHash('sha256').update(value).digest('hex');
const versionHash = files => digest(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b))));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;
const location = (dataDir, accountKey) => collectionStoreRoot(dataDir ?? defaultDataDir(), accountKey);

export class CollectionError extends Error {
  constructor(code, message) { super(message); this.name = 'CollectionError'; this.code = code; }
}
function fail(code, message) { throw new CollectionError(code, message); }
function requireValue(condition, message = 'Collection snapshot validation failed; the last successful snapshot was preserved.') {
  if (!condition) fail('COLLECTION_INVALID', message);
}
function exactKeys(value, keys) {
  requireValue(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function text(value, max = 512) { return value === null || (typeof value === 'string' && value.length > 0 && value.length <= max); }
function safeTotal(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  requireValue(integer(total)); return total;
}
function resources(value) {
  exactKeys(value, RESOURCES); exactKeys(value.wildcards, WILDCARDS);
  requireValue([value.gold, value.gems, ...WILDCARDS.map(key => value.wildcards[key])].every(integer), 'Gold, Gems and all four wildcard counts must be known integers; no snapshot was saved.');
  return { gold: value.gold, gems: value.gems, wildcards: Object.fromEntries(WILDCARDS.map(key => [key, value.wildcards[key]])) };
}
function validateProbe(probe) {
  exactKeys(probe, ['schema', 'read_at', 'source', 'stable_reads', 'cards', 'inventory', 'content_hash']);
  requireValue(probe.schema === 'MTGA_COLLECTION_PROBE_V1' && probe.source === SOURCE && timestamp(probe.read_at));
  requireValue(integer(probe.stable_reads) && probe.stable_reads >= 2 && probe.stable_reads <= 5);
  requireValue(Array.isArray(probe.cards) && probe.cards.length > 0 && probe.cards.length <= 100000, 'A nonempty full-collection API result is required; no snapshot was saved.');
  let previous = 0;
  for (const card of probe.cards) {
    exactKeys(card, ['grpId', 'qty']);
    requireValue(positive(card.grpId) && card.grpId > previous && integer(card.qty) && card.qty <= 1000000);
    previous = card.grpId;
  }
  requireValue(probe.cards.some(card => card.qty > 0), 'An empty collection cannot replace the last successful snapshot.');
  const inventory = resources(probe.inventory);
  requireValue(HASH.test(probe.content_hash) && digest(JSON.stringify({ cards: probe.cards, inventory })) === probe.content_hash, 'The collection reader result failed its content hash check; no snapshot was saved.');
  return inventory;
}

async function localMetadata(ids, path) {
  const result = new Map();
  if (!path) return result;
  let database;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(path, { readOnly: true });
    const query = database.prepare('SELECT GrpId,Rarity,ExpansionCode,CollectorNumber,CollectorSuffix,IsPrimaryCard,LinkedFaceGrpIds FROM Cards WHERE GrpId=?');
    for (const id of ids) {
      const row = query.get(id);
      if (!row) continue;
      const links = String(row.LinkedFaceGrpIds ?? '').split(',').filter(Boolean).map(Number);
      requireValue(links.every(positive) && new Set(links).size === links.length);
      result.set(id, { set: typeof row.ExpansionCode === 'string' && row.ExpansionCode ? row.ExpansionCode : null,
        number: typeof row.CollectorNumber === 'string' && row.CollectorNumber ? row.CollectorNumber : null,
        suffix: typeof row.CollectorSuffix === 'string' ? row.CollectorSuffix : '',
        rarity: RARITIES.get(row.Rarity) ?? 'unknown',
        primary: row.IsPrimaryCard === 1 ? true : row.IsPrimaryCard === 0 ? false : null,
        links: links.sort((a, b) => a - b) });
    }
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    // An unavailable/incompatible local DB leaves every original owned ID intact.
    return new Map();
  } finally { database?.close(); }
  return result;
}

function normalizeLinkedFaces(cards, metadata) {
  const owned = new Map(cards.map(card => [card.grpId, card]));
  for (const card of cards) {
    const row = metadata.get(card.grpId);
    if (!row) continue;
    for (const linkedId of row.links) {
      const other = owned.get(linkedId), linked = metadata.get(linkedId);
      if (!other || !linked || card.qty === 0 || other.qty === 0) continue;
      // IsPrimaryCard alone is insufficient: rebalanced cards are also nonprimary.
      // Deduplicate only a linked front/back pair of the same client printing.
      const samePrinting = row.set && row.set === linked.set && row.number && row.number === linked.number;
      const primary = row.primary === true && linked.primary === false ? card : row.primary === false && linked.primary === true ? other : null;
      requireValue(samePrinting && primary && card.qty === other.qty, 'Owned linked-face representations are ambiguous; compare them in Arena before replacing the last snapshot.');
      const secondary = primary === card ? other : card;
      requireValue(secondary.duplicate_of === null || secondary.duplicate_of === primary.grpId);
      secondary.counted_qty = 0; secondary.duplicate_of = primary.grpId;
    }
  }
}
function counts(cards) {
  const owned = cards.filter(card => card.counted_qty > 0), unidentified = owned.filter(card => card.status === 'unidentified');
  return { record_count: cards.length, card_kinds: owned.length,
    total_quantity: safeTotal(cards.map(card => card.counted_qty)), raw_total_quantity: safeTotal(cards.map(card => card.qty)),
    unidentified_card_kinds: unidentified.length, unidentified_quantity: safeTotal(unidentified.map(card => card.counted_qty)),
    duplicate_face_kinds: cards.filter(card => card.duplicate_of !== null).length };
}
function warnings(cards) {
  const result = [WARNING_API];
  if (cards.some(card => card.status === 'unidentified' && card.qty > 0)) result.push(WARNING_UNKNOWN);
  if (cards.some(card => card.qty > 4 && card.rarity !== 'basic_land')) result.push(WARNING_QUANTITY);
  if (cards.some(card => card.duplicate_of !== null)) result.push(WARNING_FACE);
  return result;
}
function shardCards(cards, accountKey) {
  const parts = new Map(); let records = [];
  function add() {
    const path = `${collectionPrefix(accountKey)}parts/cards-${String(parts.size + 1).padStart(3, '0')}.json`;
    parts.set(path, serialize({ schema: 'MTGA_COLLECTION_CARD_PART_V1', cards: records })); records = [];
  }
  for (const card of cards) {
    const next = [...records, card];
    if (Buffer.byteLength(serialize({ schema: 'MTGA_COLLECTION_CARD_PART_V1', cards: next })) > MAX_COLLECTION_PART_BYTES) {
      requireValue(records.length > 0, 'A collection card record exceeds the safe shard size; no snapshot was saved.'); add();
    }
    records.push(card);
    requireValue(Buffer.byteLength(serialize({ schema: 'MTGA_COLLECTION_CARD_PART_V1', cards: records })) <= MAX_COLLECTION_PART_BYTES);
  }
  if (records.length) add();
  return parts;
}
function makeFiles(summary, inventory, cards) {
  const prefix = collectionPrefix(summary.account_key), parts = shardCards(cards, summary.account_key);
  const readme = summary.account_key ? README.replaceAll(PREFIX, prefix) +
    '\nThis snapshot belongs only to the hashed account_key in its summary. Ownership was explicitly confirmed by the user.\n' : README;
  const files = new Map([[collectionReadmePath(summary.account_key), readme], [`${prefix}summary.json`, serialize(summary)], [`${prefix}inventory.json`, serialize(inventory)], ...parts]);
  const manifest = { schema: 'MTGA_COLLECTION_MANIFEST_V1', read_at: summary.read_at, verified_at: summary.verified_at,
    content_hash: summary.content_hash, card_content_hash: summary.card_content_hash,
    record_count: summary.record_count, card_kinds: summary.card_kinds, total_quantity: summary.total_quantity,
    parts: [...parts.keys()], files: Object.fromEntries([...files].map(([path, content]) => [path, {
      sha256: digest(content), bytes: Buffer.byteLength(content), record_count: parts.has(path) ? JSON.parse(content).cards.length : 0 }])) };
  files.set(`${prefix}manifest.json`, serialize(manifest));
  return { files, manifest };
}

/** Whitelist and enrich one already stable full API result; never reads account data. */
export async function buildCollectionSnapshot(probe, { cardDb, displayNamesZh, accountKey } = {}) {
  collectionAccountKey(accountKey);
  const rawInventory = validateProbe(probe);
  let path = cardDb;
  if (path === undefined) { try { path = await discoverCardDatabase(); } catch { path = null; } }
  let names = new Map();
  if (path) { try { names = await loadCardNames(path); } catch { /* Unknown names remain unknown. */ } }
  const chinese = displayNamesZh ?? await loadInstalledChineseDisplayNames();
  requireValue(chinese instanceof Map);
  const metadata = await localMetadata(probe.cards.map(card => card.grpId), path);
  const cards = probe.cards.map(({ grpId, qty }) => {
    const row = metadata.get(grpId);
    const possibleName = names.get(grpId);
    const name = typeof possibleName === 'string' && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(possibleName) ? possibleName : null;
    const possibleChinese = chinese.get(grpId);
    const zh = typeof possibleChinese === 'string' && /\p{Script=Han}/u.test(possibleChinese) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(possibleChinese) ? possibleChinese : null;
    return { grpId, qty, counted_qty: qty, duplicate_of: null, name, display_name_zh: zh,
      set: row?.set ?? null, collector_number: row?.number ? `${row.number}${row.suffix}` : null,
      rarity: row?.rarity ?? 'unknown', is_primary: row?.primary ?? null, linked_face_ids: row?.links ?? [],
      status: name && row?.set && row?.number && row.rarity !== 'unknown' ? 'identified' : 'unidentified' };
  });
  normalizeLinkedFaces(cards, metadata);
  const cardContentHash = digest(JSON.stringify(cards)), contentHash = digest(JSON.stringify({
    ...(accountKey ? { account_key: accountKey } : {}), cards, inventory: rawInventory }));
  const verifiedAt = new Date().toISOString();
  const summary = { schema: 'MTGA_COLLECTION_SUMMARY_V1', ...(accountKey ? { account_key: accountKey } : {}),
    read_at: probe.read_at, verified_at: verifiedAt, ...counts(cards),
    source: SOURCE, stable_reads: probe.stable_reads, coverage: 'full_collection_api_result; independent_client_comparison_not_encoded',
    warnings: warnings(cards), content_hash: contentHash, card_content_hash: cardContentHash };
  const inventory = { schema: 'MTGA_COLLECTION_INVENTORY_V1', read_at: probe.read_at, verified_at: verifiedAt, content_hash: contentHash, ...rawInventory };
  const { files, manifest } = makeFiles(summary, inventory, cards);
  const snapshot = { files, summary, inventory, manifest, cards };
  validateCollectionSnapshot(snapshot); return snapshot;
}

/** Strict structure, canonical bytes, complete shards and hashes. Throws safe errors. */
export function validateCollectionSnapshot(snapshot) {
  exactKeys(snapshot, ['files', 'summary', 'inventory', 'manifest', 'cards']);
  const { files, summary, inventory, manifest, cards } = snapshot;
  requireValue(files instanceof Map);
  exactKeys(summary, [...SUMMARY_KEYS, ...(Object.hasOwn(summary ?? {}, 'account_key') ? ['account_key'] : [])]);
  collectionAccountKey(summary.account_key);
  exactKeys(inventory, INVENTORY_KEYS); exactKeys(manifest, MANIFEST_KEYS);
  requireValue(summary.schema === 'MTGA_COLLECTION_SUMMARY_V1' && inventory.schema === 'MTGA_COLLECTION_INVENTORY_V1' && manifest.schema === 'MTGA_COLLECTION_MANIFEST_V1');
  requireValue(timestamp(summary.read_at) && timestamp(summary.verified_at) && summary.verified_at >= summary.read_at);
  requireValue(inventory.read_at === summary.read_at && inventory.verified_at === summary.verified_at && manifest.read_at === summary.read_at && manifest.verified_at === summary.verified_at);
  requireValue(summary.source === SOURCE && integer(summary.stable_reads) && summary.stable_reads >= 2 && summary.stable_reads <= 5 && summary.coverage === 'full_collection_api_result; independent_client_comparison_not_encoded');
  requireValue(Array.isArray(cards) && cards.length > 0 && cards.length <= 100000);
  let previous = 0;
  for (const card of cards) {
    exactKeys(card, CARD_KEYS);
    requireValue(positive(card.grpId) && card.grpId > previous && integer(card.qty) && card.qty <= 1000000 && integer(card.counted_qty) && card.counted_qty <= card.qty);
    previous = card.grpId;
    requireValue(card.duplicate_of === null || (positive(card.duplicate_of) && card.duplicate_of !== card.grpId));
    requireValue(text(card.name) && text(card.display_name_zh) && text(card.set, 64) && text(card.collector_number, 64));
    requireValue(card.name === null || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(card.name));
    requireValue(card.display_name_zh === null || (/\p{Script=Han}/u.test(card.display_name_zh) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(card.display_name_zh)));
    requireValue([...RARITIES.values()].includes(card.rarity) && [true, false, null].includes(card.is_primary));
    requireValue(Array.isArray(card.linked_face_ids) && card.linked_face_ids.length <= 100 && card.linked_face_ids.every((id, index, list) => positive(id) && id !== card.grpId && (index === 0 || id > list[index - 1])));
    requireValue(card.status === (card.name && card.set && card.collector_number && card.rarity !== 'unknown' ? 'identified' : 'unidentified'));
  }
  const byId = new Map(cards.map(card => [card.grpId, card]));
  for (const card of cards) {
    if (card.duplicate_of === null) { requireValue(card.counted_qty === card.qty); continue; }
    const primary = byId.get(card.duplicate_of);
    requireValue(primary && primary.duplicate_of === null && primary.is_primary === true && card.is_primary === false && card.counted_qty === 0 && positive(card.qty) && card.qty === primary.qty && card.set && card.set === primary.set);
    requireValue(card.linked_face_ids.includes(primary.grpId) || primary.linked_face_ids.includes(card.grpId));
    requireValue(card.collector_number?.replace(/[ab]$/, '') === primary.collector_number?.replace(/[ab]$/, ''));
  }
  const computed = counts(cards);
  requireValue(computed.total_quantity > 0 && Object.entries(computed).every(([key, value]) => summary[key] === value));
  requireValue(Array.isArray(summary.warnings) && serialize(summary.warnings) === serialize(warnings(cards)));
  const rawInventory = resources({ gold: inventory.gold, gems: inventory.gems, wildcards: inventory.wildcards });
  requireValue(summary.card_content_hash === digest(JSON.stringify(cards)) && summary.content_hash === digest(JSON.stringify({
    ...(summary.account_key ? { account_key: summary.account_key } : {}), cards, inventory: rawInventory })));
  requireValue(inventory.content_hash === summary.content_hash && manifest.content_hash === summary.content_hash && manifest.card_content_hash === summary.card_content_hash);
  requireValue(Array.isArray(manifest.parts) && object(manifest.files));
  const expected = makeFiles(summary, inventory, cards);
  requireValue(files.size === expected.files.size && serialize(manifest) === serialize(expected.manifest));
  for (const [path, content] of expected.files) {
    requireValue(typeof files.get(path) === 'string' && files.get(path) === content);
    if (PART.test(path)) requireValue(Buffer.byteLength(content) <= MAX_COLLECTION_PART_BYTES);
  }
  // Shared guard checks the exact upload bytes after the collection field whitelist.
  validateBundleFiles(files); return true;
}

async function directory(path) {
  try { const value = await lstat(path); requireValue(value.isDirectory() && !value.isSymbolicLink()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(path, { mode: 0o700 }); }
}
async function existingDirectory(path) {
  const value = await lstat(path); requireValue(value.isDirectory() && !value.isSymbolicLink());
}
async function regularText(path) {
  const info = await lstat(path); requireValue(info.isFile() && !info.isSymbolicLink());
  return readFile(path, 'utf8');
}
async function localLock(root,callback) {
  try { return await withCollectionLock(root,'save.lock',callback); }
  catch(error) { if(error.code==='COLLECTION_BUSY') fail('COLLECTION_BUSY','A collection save/recovery lock is retained; confirm no operation is running before explicit recovery.'); throw error; }
}
function comparePrevious(previous, next) {
  if (!previous) return;
  requireValue(next.summary.read_at >= previous.summary.read_at, 'An older read cannot replace the current collection snapshot.');
  const now = new Map(next.cards.map(card => [card.grpId, card.qty]));
  if (previous.cards.some(card => card.qty > 0 && (now.get(card.grpId) ?? 0) < card.qty)) {
    fail('COLLECTION_DECREASE', 'Owned card quantities decreased or disappeared. Possible partial read or account change; the previous snapshot was preserved.');
  }
  const oldIds = new Set(previous.cards.filter(card => card.qty > 0).map(card => card.grpId));
  const addedKinds = next.cards.filter(card => card.qty > 0 && !oldIds.has(card.grpId)).length;
  const increase = next.summary.raw_total_quantity - previous.summary.raw_total_quantity;
  if (addedKinds > Math.max(100, previous.summary.card_kinds * 0.25) || increase > Math.max(400, previous.summary.raw_total_quantity * 0.5)) {
    fail('COLLECTION_LARGE_CHANGE', 'The collection changed unusually much. Compare the client and account before replacing the previous snapshot.');
  }
}

/** Validate entirely before switching current.json; unchanged card bytes reuse hardlinks. */
async function saveSnapshot(snapshot, { dataDir, accountKey } = {}) {
  validateCollectionSnapshot(snapshot);
  collectionAccountKey(accountKey);
  requireValue(snapshot.summary.account_key === accountKey, 'Collection account does not match the destination; no snapshot was saved.');
  const base = location(dataDir), root = location(dataDir, accountKey);
  await mkdir(resolve(base, '..'), { recursive: true, mode: 0o700 }); await directory(base);
  if (accountKey) { await directory(join(base, 'accounts')); await directory(root); }
  return localLock(root, async () => {
    const previous = await loadCollectionSnapshot({ dataDir, accountKey }); comparePrevious(previous, snapshot);
    await directory(join(root, 'cards')); await directory(join(root, 'versions'));
    const cache = join(root, 'cards', snapshot.summary.card_content_hash);
    const temporaryCache = join(root, 'cards', `.pending-${randomUUID()}`);
    // A cache is created once; existing cached card bytes are never rewritten.
    try { const info = await lstat(cache); requireValue(info.isDirectory() && !info.isSymbolicLink()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await directory(temporaryCache);
      try {
        for (const path of snapshot.manifest.parts) await writeFile(join(temporaryCache, path.split('/').at(-1)), snapshot.files.get(path), { mode: 0o600, flag: 'wx' });
        await rename(temporaryCache, cache);
      } finally { await rm(temporaryCache, { recursive: true, force: true }); }
    }
    for (const path of snapshot.manifest.parts) requireValue(await regularText(join(cache, path.split('/').at(-1))) === snapshot.files.get(path));
    const version = versionHash(snapshot.files);
    const final = join(root, 'versions', version), staging = join(root, 'versions', `.pending-${randomUUID()}`);
    let finalExists = false;
    try {
      await existingDirectory(final); finalExists = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (finalExists) {
      const existing = await readVersion(root, version); requireValue(versionHash(existing.files) === version);
    } else {
      await directory(staging); await directory(join(staging, 'parts'));
      try {
        for (const [path, content] of snapshot.files) {
          if (PART.test(path)) await link(join(cache, path.split('/').at(-1)), join(staging, 'parts', path.split('/').at(-1)));
          else await writeFile(join(staging, path.split('/').at(-1)), content, { mode: 0o600, flag: 'wx' });
        }
        // Validate saved bytes, not merely the original in-memory object.
        const restored = await readVersionDirectory(staging); validateCollectionSnapshot(restored);
        await rename(staging, final);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    const pointer = join(root, `.current-${randomUUID()}.tmp`);
    try {
      await writeFile(pointer, serialize({ schema: 'MTGA_COLLECTION_CURRENT_V1', version }), { mode: 0o600, flag: 'wx' });
      const current = join(root, 'current.json');
      try { const info = await lstat(current); requireValue(info.isFile() && !info.isSymbolicLink()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(pointer, current);
    } finally { await rm(pointer, { force: true }); }
    return { saved: true, cardContentChanged: previous?.summary.card_content_hash !== snapshot.summary.card_content_hash, version, summary: snapshot.summary };
  });
}
async function readVersionDirectory(path) {
  await existingDirectory(path); await existingDirectory(join(path, 'parts'));
  const files = new Map();
  let summary, inventory, manifest;
  try { summary = JSON.parse(await regularText(join(path, 'summary.json'))); inventory = JSON.parse(await regularText(join(path, 'inventory.json'))); manifest = JSON.parse(await regularText(join(path, 'manifest.json'))); }
  catch { fail('COLLECTION_INVALID', 'The local collection snapshot is invalid; no upload was attempted.'); }
  const prefix = collectionPrefix(summary.account_key);
  files.set(collectionReadmePath(summary.account_key), await regularText(join(path, 'README.md')));
  for (const [name, value] of [['summary.json', summary], ['inventory.json', inventory], ['manifest.json', manifest]]) {
    const bytes = await regularText(join(path, name));
    requireValue(bytes === serialize(value)); files.set(`${prefix}${name}`, bytes);
  }
  exactKeys(manifest, MANIFEST_KEYS); requireValue(Array.isArray(manifest.parts) && manifest.parts.length > 0 && manifest.parts.length <= 100000);
  const cards = [];
  for (const relative of manifest.parts) {
    requireValue(typeof relative === 'string' && PART.test(relative));
    const content = await regularText(join(path, 'parts', relative.split('/').at(-1))); files.set(relative, content);
    let part;
    try { part = JSON.parse(content); } catch { fail('COLLECTION_INVALID', 'A local collection part is invalid; no upload was attempted.'); }
    exactKeys(part, ['schema', 'cards']); requireValue(part.schema === 'MTGA_COLLECTION_CARD_PART_V1' && Array.isArray(part.cards)); cards.push(...part.cards);
  }
  const snapshot = { files, summary, inventory, manifest, cards }; validateCollectionSnapshot(snapshot); return snapshot;
}
async function readVersion(root, version) {
  requireValue(HASH.test(version)); await existingDirectory(join(root, 'versions'));
  const snapshot = await readVersionDirectory(join(root, 'versions', version));
  requireValue(versionHash(snapshot.files) === version); return snapshot;
}

/** Read only the atomically selected successful snapshot; game access is unnecessary. */
async function loadSnapshot({ dataDir, accountKey } = {}) {
  const base = location(dataDir), root = location(dataDir, accountKey);
  let bytes;
  try {
    await existingDirectory(base);
    if (accountKey) await existingDirectory(join(base, 'accounts'));
    await existingDirectory(root); bytes = await regularText(join(root, 'current.json'));
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let pointer;
  try { pointer = JSON.parse(bytes); } catch { fail('COLLECTION_INVALID', 'The local collection pointer is invalid; no upload was attempted.'); }
  exactKeys(pointer, ['schema', 'version']); requireValue(pointer.schema === 'MTGA_COLLECTION_CURRENT_V1' && HASH.test(pointer.version) && bytes === serialize(pointer));
  const snapshot = await readVersion(root, pointer.version);
  requireValue(snapshot.summary.account_key === accountKey, 'Saved collection belongs to a different account.');
  return snapshot;
}
function storageFailure(error) {
  if (error instanceof CollectionError || ['MTGA_SYNC_SECURITY', 'COLLECTION_ACCOUNT_INVALID'].includes(error?.code)) throw error;
  fail('COLLECTION_STORAGE', 'Local collection storage is unavailable or incomplete; no snapshot was published.');
}
export async function saveCollectionSnapshot(snapshot, options = {}) {
  try { return await saveSnapshot(snapshot, options); } catch (error) { storageFailure(error); }
}
export async function loadCollectionSnapshot(options = {}) {
  try { return await loadSnapshot(options); } catch (error) { storageFailure(error); }
}
