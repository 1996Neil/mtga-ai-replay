import { createHash, randomUUID } from 'node:crypto';
import { open, stat, lstat, readFile, readdir, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverDisplayNameDatabase } from './display-names.mjs';
import { coachCardMetadataIds } from './coach-cards.mjs';

export const syncDigest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Full bytes, not size/mtime shortcuts. Detect replacement and writes while hashing. */
export async function fingerprintFile(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return null;
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat({ bigint: true }), current = await stat(path, { bigint: true });
    const identity = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String);
    const first = identity(before);
    if (JSON.stringify(first) !== JSON.stringify(identity(after)) || JSON.stringify(first) !== JSON.stringify(identity(current))) return null;
    return { hash: hash.digest('hex'), identity: first };
  } catch (error) { if (error.code === 'ENOENT') return { missing: true }; throw error; }
  finally { await handle?.close(); }
}

async function fingerprints(paths) {
  const values = [];
  for (const path of paths) {
    const value = await fingerprintFile(path);
    if (!value) return null;
    values.push([path, value]);
  }
  return values;
}

/** Bind parsing, schemas, privacy filtering, codecs, local rules and the actual
 * installed upstream parser bytes. No persistent validation verdict lives here. */
async function diskRulesFingerprint() {
  const root = dirname(fileURLToPath(import.meta.url));
  const paths = (await readdir(root)).filter(name => name.endsWith('.mjs')).sort().map(name => join(root, name));
  const parser = fileURLToPath(new URL('../node_modules/mtga-log-parser/dist/', import.meta.url));
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) paths.push(path);
    }
  }
  await walk(parser);
  paths.push(fileURLToPath(new URL('../package.json', import.meta.url)));
  const hashes = [];
  for (const path of paths) {
    const value = await fingerprintFile(path);
    if (!value || value.missing) return null;
    hashes.push([path.startsWith(parser) ? `parser/${path.slice(parser.length)}` : path.slice(root.length), value.hash]);
  }
  return syncDigest([process.versions.node, hashes]);
}
// Freeze the rules when this module graph starts. A still-running old process
// must never label its old execution as a newly edited on-disk ruleset.
const firstRules = await diskRulesFingerprint();
const loadedRules = firstRules === await diskRulesFingerprint() ? firstRules : null;
export async function syncRulesFingerprint() {
  return loadedRules && loadedRules === await diskRulesFingerprint() ? loadedRules : null;
}

export async function importInputFingerprint(paths, database, all) {
  const files = await fingerprints([...paths, ...(database ? [database, database + '-wal'] : [])]);
  const rules = await syncRulesFingerprint();
  return files && rules ? syncDigest([files, all, rules]) : null;
}
export async function archiveFingerprint(dataDir) {
  const values = await fingerprints([join(dataDir, 'replays.sqlite3'), join(dataDir, 'replays.sqlite3-wal')]);
  // Read-only SQLite opens may create/remove an empty WAL. It carries no
  // archive changes; content hashing still detects every actual frame/write.
  return values ? syncDigest(values.map(([path, value]) => [path,
    path.endsWith('-wal') && (value.missing || value.identity?.[2] === '0') ? 'no-wal-frames' : value.hash ?? 'missing'])) : null;
}

export async function coachInputFingerprint(replay, { dataDir, cardDb, displayNamesZh } = {}) {
  const displayDb = displayNamesZh ? null : await discoverDisplayNameDatabase();
  const coreFiles = await fingerprints([cardDb, displayDb].filter(Boolean).flatMap(path => [path, path + '-wal']));
  const rules = await syncRulesFingerprint();
  if (!coreFiles || !rules) return null;
  const core = syncDigest([replay, coreFiles, rules, displayNamesZh ? [...displayNamesZh].sort((a, b) => a[0] - b[0]) : null]);
  const ids = await coachCardMetadataIds(replay, { cardDb });
  if (!ids) return null;
  // Include absent dependency files as well: a later metadata arrival must
  // invalidate this receipt. DB/WAL, rules, replay and names retain full-byte
  // fingerprints; no mtime-only or persistent validation shortcut is used.
  const metadata = await fingerprints(ids.map(id => join(dataDir, 'cards', `${id}.json`)));
  return metadata ? { core, hash: syncDigest(['replay-metadata-v2', core, metadata]), metadataIds: ids } : null;
}

/** Optimization receipts are private local files; malformed receipts are misses. */
export async function readSyncCache(dataDir, name) {
  if (!['replay-import-cache.json', 'replay-coach-generation-cache.json'].includes(name)) return null;
  try {
    const path = join(dataDir, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return null;
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value?.schema === 'MTGA_SYNC_CACHE_V1' ? value : null;
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
export async function writeSyncCache(dataDir, name, value) {
  if (!['replay-import-cache.json', 'replay-coach-generation-cache.json'].includes(name)) return;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) return;
  const path = join(dataDir, name), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(temporary, JSON.stringify({ ...value, schema: 'MTGA_SYNC_CACHE_V1' }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
