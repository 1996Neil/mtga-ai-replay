import { homedir } from 'node:os';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const OPTIONAL_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);
const isLogName = (name) => /^Player(?:-prev)?\.log$/i.test(name) || /^UTC_Log.*\.log$/i.test(name);

async function optionalRead(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (OPTIONAL_ERRORS.has(error.code)) return '';
    throw error;
  }
}

/** Candidate Arena data directories, including user-configured Steam libraries. */
export async function arenaDataDirectories(home = homedir()) {
  const support = join(home, 'Library', 'Application Support');
  const steamHome = join(support, 'Steam');
  const libraries = new Set([steamHome]);
  const libraryConfig = await optionalRead(join(steamHome, 'steamapps', 'libraryfolders.vdf'));
  for (const match of libraryConfig.matchAll(/"path"\s*"((?:\\.|[^"\\])*)"/g)) {
    libraries.add(match[1].replace(/\\([\\"])/g, '$1'));
  }

  const roots = [
    join(support, 'com.wizards.mtga'),
    join(support, 'Wizards Of The Coast', 'MTGA'),
  ];
  for (const library of libraries) {
    const install = join(library, 'steamapps', 'common', 'MTGA');
    roots.push(join(install, 'MTGA_Data'));
    roots.push(join(install, 'MTGA.app', 'Contents', 'Resources', 'Data'));
  }
  for (const applications of [join(home, 'Applications'), '/Applications']) {
    const app = join(applications, 'MTGA.app', 'Contents', 'Resources');
    roots.push(join(app, 'Data'), join(app, 'MTGA_Data'), app);
  }
  return [...new Set(roots)];
}

async function filesFromDirectory(directory, explicit = false) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (!explicit && OPTIONAL_ERRORS.has(error.code)) return [];
    throw new Error(`Cannot read log directory: ${directory}`, { cause: error });
  }
  return entries.filter((entry) => isLogName(entry.name)).map((entry) => join(directory, entry.name));
}

/** Discover readable Mac Arena logs in chronological modification order. Never changes logs. */
export async function discoverLogs({ home = homedir(), logPath, logDir } = {}) {
  if (logPath && logDir) throw new Error('Choose either --log or --log-dir, not both.');
  let candidates;
  if (logPath) {
    candidates = [resolve(logPath)];
  } else if (logDir) {
    candidates = await filesFromDirectory(resolve(logDir), true);
  } else {
    const dataDirs = await arenaDataDirectories(home);
    const directories = [
      join(home, 'Library', 'Logs', 'Wizards Of The Coast', 'MTGA'),
      ...dataDirs.map((directory) => join(directory, 'Logs', 'Logs')),
      ...dataDirs.map((directory) => join(directory, 'Logs')),
    ];
    candidates = (await Promise.all(directories.map((directory) => filesFromDirectory(directory)))).flat();
  }

  const unique = new Map();
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) {
        if (logPath) throw new Error(`Log path is not a file: ${candidate}`);
        continue;
      }
      const canonical = await realpath(candidate);
      unique.set(canonical, { path: canonical, mtime: info.mtimeMs });
    } catch (error) {
      if (!logPath && OPTIONAL_ERRORS.has(error.code)) continue;
      throw new Error(`Cannot read log file: ${candidate}`, { cause: error });
    }
  }
  return [...unique.values()]
    .sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
}
