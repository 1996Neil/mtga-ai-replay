import { readFile, mkdir, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const settingsDataDir = () => join(homedir(), '.local/share/mtga-gpt-replay');
export function validateReplaySettings(value) {
  if (!value || Object.keys(value).some(key => key !== 'retention_days') ||
      !(value.retention_days === null || Number.isSafeInteger(value.retention_days) &&
        value.retention_days >= 1 && value.retention_days <= 36500)) throw Error('保留天数须为 1–36500 的整数，或选择不限制。');
  return { retention_days: value.retention_days };
}
export async function readReplaySettings(dataDir = settingsDataDir()) {
  try {
    const path = join(dataDir, 'replay-settings.json'), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error('Invalid replay settings file');
    return validateReplaySettings(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) { if (error.code === 'ENOENT') return { retention_days: null }; throw error; }
}
export async function saveReplaySettings(value, dataDir = settingsDataDir()) {
  const settings = validateReplaySettings(value);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = join(dataDir, `replay-settings.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(settings) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(dataDir, 'replay-settings.json'));
  return settings;
}
export function replayInRetention(match, settings, now = Date.now()) {
  if (settings.retention_days === null) return true;
  const started = Date.parse(match?.started_at);
  // Unknown dates cannot safely be classified as expired.
  return !Number.isFinite(started) || started >= now - settings.retention_days * 86400000;
}

const operations = new Map();
/** Cleanup is exclusive. Ingestion and sync may overlap: short SQLite
 * transactions serialize archive writes, and remote replacement uses a CAS. */
export function withReplayOperation(dataDir, callback, { exclusive = true } = {}) {
  let state = operations.get(dataDir);
  if (!state) { state = { barrier: Promise.resolve(), active: new Set() }; operations.set(dataDir, state); }
  const start = exclusive ? Promise.allSettled([state.barrier, ...state.active]) : state.barrier.catch(() => {});
  const next = start.then(callback);
  if (exclusive) state.barrier = next.catch(() => {});
  state.active.add(next);
  return next.finally(() => { state.active.delete(next); });
}
