import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

/** Change hints only. Actual readers retain their own content/identity boundary. */
export async function fileRevision(dataDir, paths) {
  return JSON.stringify(await Promise.all(paths.map(async path => {
    try {
      const info = await lstat(join(dataDir, path), { bigint: true });
      if (path.endsWith('-wal') && info.size === 0n) return [path, 'empty'];
      return [path, String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs)];
    } catch (error) {
      if (error.code === 'ENOENT') return [path, path.endsWith('-wal') ? 'empty' : 'missing'];
      throw error;
    }
  })));
}

/** A single cached result and a single in-flight load, with no timer or worker. */
export function revisionMemo(revision, load) {
  let key, value, active;
  return async () => {
    if (active) return active;
    active = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await revision();
        if (key === before) return value;
        const next = await load();
        if (before === await revision()) { key = before; value = next; return next; }
      }
      // Do not label an older load with the caller's newer version. A busy
      // source stays outstanding and the normal next poll can retry.
      throw Error('Source changed while loading; retry.');
    })().finally(() => { active = null; });
    return active;
  };
}
