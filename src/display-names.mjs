import { homedir } from 'node:os';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { arenaDataDirectories } from './discovery.mjs';

const OPTIONAL_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);
const CHINESE_BASICS = ['树林', '山脉', '海岛', '平原', '沼泽'];
const BUNDLED_GZ = new URL('./card-names/cards.jsonl.gz', import.meta.url);
const BUNDLED_MANIFEST = new URL('./card-names/manifest.json', import.meta.url);
let bundledNamesPromise, bundledFingerprintPromise;
const DISPLAY_SOURCE = Symbol('display-name-source');

function plainText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity.startsWith('#')) {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return entities[entity.toLowerCase()] ?? match;
  }).trim();
}

/** Names-only release bundled at build time; empty when the optional asset is absent. */
export async function loadBundledChineseDisplayNames() {
  if (!bundledNamesPromise) bundledNamesPromise = (async () => {
    const names = new Map();
    try {
      const manifest = JSON.parse(await readFile(BUNDLED_MANIFEST, 'utf8'));
      if (manifest?.schema !== 'MTGA_CARD_NAMES_V1') return names;
      const rows = gunzipSync(await readFile(BUNDLED_GZ)).toString('utf8').split('\n');
      for (const line of rows) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        const id = Number(row.grp_id);
        if (!Number.isSafeInteger(id) || id <= 0 || typeof row.zh !== 'string') continue;
        if (!/\p{Script=Han}/u.test(row.zh) || /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(row.zh)) continue;
        names.set(id, row.zh);
      }
    } catch {
      // Bundled names are optional; installed game data can still supply them.
      return names;
    }
    return names;
  })();
  return bundledNamesPromise;
}

/** Stable hash of the bundled manifest + gzip; used by sync-cache receipts. */
export async function bundledCardNamesFingerprint() {
  if (!bundledFingerprintPromise) bundledFingerprintPromise = (async () => {
    try {
      const [manifest, gz] = await Promise.all([readFile(BUNDLED_MANIFEST), readFile(BUNDLED_GZ)]);
      const version = JSON.parse(manifest.toString('utf8')).data_version ?? 'unknown';
      return `${version}:${createHash('sha256').update(manifest).update(gz).digest('hex')}`;
    } catch {
      return 'missing';
    }
  })();
  return bundledFingerprintPromise;
}

function localizationTable(database) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const table of ['Localizations_zhCN', 'Localizations_zhTW']) if (tables.has(table)) return table;
  if (!tables.has('Localizations_enUS')) return null;
  // This Mac's Chinese patch writes titles into enUS. Verify all five basic
  // land translations before treating that table as Chinese display data.
  const titles = new Set(database.prepare(`SELECT DISTINCT l.Loc AS name
    FROM Cards c JOIN Localizations_enUS l ON c.TitleId=l.LocId
    WHERE l.Formatted IN (0,1,2)`).all().map(row => typeof row.name === 'string' ? plainText(row.name) : ''));
  return CHINESE_BASICS.every(name => titles.has(name)) ? 'Localizations_enUS' : null;
}

/** Read translated display titles only. Canonical replay names are independent. */
export async function loadChineseDisplayNames(path) {
  if (!path) return new Map();
  let database;
  try {
    if (!(await stat(path)).isFile()) return new Map();
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(path, { readOnly: true });
    const table = localizationTable(database);
    if (!table) return new Map();
    // Table is selected only from the fixed identifiers above, never user SQL.
    const rows = database.prepare(`SELECT c.GrpId AS arenaId,l.Loc AS name
      FROM Cards c JOIN ${table} l ON c.TitleId=l.LocId
      WHERE l.Formatted IN (0,1,2)
      ORDER BY c.GrpId,CASE l.Formatted WHEN 0 THEN 0 WHEN 1 THEN 1 ELSE 2 END`).all();
    const names = new Map();
    for (const row of rows) {
      if (!Number.isSafeInteger(row.arenaId) || row.arenaId <= 0 || typeof row.name !== 'string' || names.has(row.arenaId)) continue;
      const name = plainText(row.name);
      if (/\p{Script=Han}/u.test(name) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name)) names.set(row.arenaId, name);
    }
    return names;
  } catch {
    // Display localization is optional; missing, inaccessible or incompatible
    // game data must not prevent the English replay from opening.
    return new Map();
  } finally { database?.close(); }
}

async function discoverInstalledNames({ home = homedir(), displayNameDb } = {}) {
  if (displayNameDb) {
    const path = resolve(displayNameDb);
    const names = await loadChineseDisplayNames(path);
    return { path: names.size ? await realpath(path) : null, names };
  }
  const candidates = [];
  for (const root of await arenaDataDirectories(home)) {
    const directory = join(root, 'Downloads', 'Raw');
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!/^Raw_CardDatabase_.*\.mtga$/i.test(entry.name)) continue;
        const path = join(directory, entry.name), info = await stat(path);
        if (info.isFile()) candidates.push({ path, mtime: info.mtimeMs });
      }
    } catch (error) { if (!OPTIONAL_ERRORS.has(error.code)) throw error; }
  }
  candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  for (const candidate of candidates) {
    const names = await loadChineseDisplayNames(candidate.path);
    if (names.size) return { path: await realpath(candidate.path), names };
  }
  return { path: null, names: new Map() };
}

/** Installed databases only: never select the original English backup resolver. */
export async function discoverDisplayNameDatabase(options = {}) {
  return (await discoverInstalledNames(options)).path;
}

/**
 * Bundled names first, installed game DB overrides. The override keeps a
 * modded client's current strings authoritative for ids it still carries.
 */
export async function loadDisplayNames(options = {}) {
  const bundled = await loadBundledChineseDisplayNames();
  const installed = (await discoverInstalledNames(options)).names;
  const names = new Map([...bundled, ...installed]);
  Object.defineProperty(names, DISPLAY_SOURCE, {
    value: { bundledFingerprint: await bundledCardNamesFingerprint() },
    enumerable: false,
  });
  return names;
}

/** Stable fingerprint for the final display map used by a running process. */
export function displayNamesMapFingerprint(names) {
  if (!(names instanceof Map)) return 'missing';
  const rows = [...names].sort((a, b) => Number(a[0]) - Number(b[0]));
  return createHash('sha256').update(JSON.stringify({
    bundled: names[DISPLAY_SOURCE]?.bundledFingerprint ?? null,
    rows,
  })).digest('hex');
}

/** Legacy name: now includes the bundled names-only release. */
export async function loadInstalledChineseDisplayNames(options = {}) {
  return loadDisplayNames(options);
}
