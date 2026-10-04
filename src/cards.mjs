import { homedir } from 'node:os';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { arenaDataDirectories } from './discovery.mjs';

const OPTIONAL_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

async function databaseCandidates(rawDirectory) {
  const candidates = [];
  try {
    for (const entry of await readdir(rawDirectory, { withFileTypes: true })) {
      if (!/^Raw_CardDatabase_.*\.mtga$/i.test(entry.name)) continue;
      const path = join(rawDirectory, entry.name);
      const info = await stat(path);
      if (info.isFile()) candidates.push({ path, mtime: info.mtimeMs });
    }
  } catch (error) {
    if (!OPTIONAL_ERRORS.has(error.code)) throw error;
  }
  return candidates;
}

async function hasEnglishBasicLandTitles(path) {
  const { DatabaseSync } = await import('node:sqlite');
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const row = database.prepare(`
      SELECT COUNT(DISTINCT l.Loc) AS count
      FROM Cards AS c JOIN Localizations_enUS AS l ON c.TitleId = l.LocId
      WHERE l.Loc IN ('Forest', 'Mountain', 'Island', 'Plains', 'Swamp')
    `).get();
    // English name variants can coexist with Chinese titles; such a mixed
    // resource cannot supply canonical English names for every card face.
    const translatedBasic = database.prepare(`
      SELECT 1 FROM Cards AS c JOIN Localizations_enUS AS l ON c.TitleId = l.LocId
      WHERE l.Loc IN ('树林', '山脉', '海岛', '平原', '沼泽')
      LIMIT 1
    `).get();
    return row.count === 5 && !translatedBasic;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

async function originalBackupCandidates(home) {
  const backupRoot = join(home, 'Documents', 'Codex', 'MTGA-backups');
  try {
    const entries = await readdir(backupRoot, { withFileTypes: true });
    return (await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
      databaseCandidates(join(backupRoot, entry.name, 'originals', 'MTGA_Data', 'Downloads', 'Raw'))
    ))).flat();
  } catch (error) {
    if (OPTIONAL_ERRORS.has(error.code)) return [];
    throw error;
  }
}

/** Find the newest installed Arena card database; do not download or build a database. */
export async function discoverCardDatabase({ home = homedir(), cardDb } = {}) {
  if (cardDb) {
    const path = resolve(cardDb);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Card database is not a file: ${path}`);
    return realpath(path);
  }
  const candidates = [];
  for (const root of await arenaDataDirectories(home)) {
    candidates.push(...await databaseCandidates(join(root, 'Downloads', 'Raw')));
  }
  candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const installed = candidates[0];
  if (installed && await hasEnglishBasicLandTitles(installed.path)) return realpath(installed.path);

  // A translated installation can overwrite enUS values. A matching local original
  // backup supplies names without changing any game database or game settings.
  const backups = (await originalBackupCandidates(home))
    .filter((candidate) => !installed || basename(candidate.path) === basename(installed.path))
    .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  for (const backup of backups) {
    if (await hasEnglishBasicLandTitles(backup.path)) return realpath(backup.path);
  }
  return installed ? realpath(installed.path) : null;
}

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

/** English display names from Arena's own SQLite database, opened strictly read-only. */
export async function loadCardNames(path) {
  if (!path) return new Map();
  try {
    if (!(await stat(path)).isFile()) return new Map();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return new Map();
    throw error;
  }
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT c.GrpId AS grpId, l.Loc AS name
      FROM Cards AS c
      JOIN Localizations_enUS AS l ON c.TitleId = l.LocId
      WHERE l.Formatted IN (0, 1, 2)
      ORDER BY c.GrpId, CASE l.Formatted WHEN 0 THEN 0 WHEN 1 THEN 1 ELSE 2 END
    `).all();
    const names = new Map();
    for (const row of rows) {
      if (typeof row.grpId !== 'number' || typeof row.name !== 'string' || names.has(row.grpId)) continue;
      const name = plainText(row.name);
      if (name) names.set(row.grpId, name);
    }
    return names;
  } finally {
    database.close();
  }
}

/** Existing English client enum labels; no extra card database is created. */
export async function loadCounterNames(path) {
  if (!path) return new Map();
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare(`SELECT e.Value AS id, l.Loc AS name FROM Enums e
      JOIN Localizations_enUS l ON e.LocId=l.LocId WHERE e.Type='CounterType'
      AND l.Formatted IN (0,1,2) ORDER BY e.Value,l.Formatted`).all();
    const names = new Map();
    for (const row of rows) if (!names.has(row.id) && row.name) names.set(row.id, plainText(row.name));
    return names;
  } catch { return new Map(); } finally { database.close(); }
}
