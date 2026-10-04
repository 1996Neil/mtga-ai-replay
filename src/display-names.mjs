import { homedir } from 'node:os';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arenaDataDirectories } from './discovery.mjs';

const OPTIONAL_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);
const CHINESE_BASICS = ['树林', '山脉', '海岛', '平原', '沼泽'];

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

/** Discover and load once when the local server starts; retain the map in memory. */
export async function loadInstalledChineseDisplayNames(options = {}) {
  return (await discoverInstalledNames(options)).names;
}
