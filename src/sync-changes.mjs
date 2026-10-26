import { validateBundleFiles, allowedPath, validateOutgoingCommit } from './sync-security.mjs';

/** Personal-repository upload mode. Validate only outgoing new/changed files;
 * old history belongs to the separate explicit audit, not every upload. */
export async function validateSyncChanges(git, { branch, onValidation } = {}) {
  const started = performance.now();
  const paths = new Set(String(await git(['diff', '--cached', '--name-only', '-z', '--no-renames'])).split('\0').filter(Boolean));
  const base = String(await git(['for-each-ref', '--format=%(objectname)', `refs/remotes/origin/${branch}`])).trim();
  for (const path of paths) if (!allowedPath(path)) throw Error('Unexpected outgoing data path.');
  let bytes = 0, checked = 0;
  const seen = new Set();
  async function inspect(path, mode, hash, stage = '0') {
    if (!allowedPath(path) || !['100644', '100755'].includes(mode) || stage !== '0' ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(hash)) throw Error('Invalid outgoing data file.');
    const identity = `${path}:${hash}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const content = await git(['cat-file', 'blob', hash], 'buffer');
    validateBundleFiles(new Map([[path, content]]));
    bytes += Buffer.byteLength(content); checked++;
  }
  const head = String(await git(['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`])).trim();
  const commits = head ? String(await git(['rev-list', '--reverse', base ? `${base}..${head}` : head])).trim().split('\n').filter(Boolean) : [];
  // Only newly outgoing commits. Intermediate payloads still travel on push,
  // even if a later queued commit deletes them; do not hide them with a net diff.
  for (const revision of commits) {
    validateOutgoingCommit(await git(['cat-file', 'commit', revision], 'buffer'));
    const changed = String(await git(['diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', revision])).split('\0').filter(Boolean);
    for (const path of changed) if (!allowedPath(path)) throw Error('Unexpected outgoing data path.');
    if (!changed.length) continue;
    for (const entry of String(await git(['ls-tree', '-rz', revision, '--', ...changed])).split('\0').filter(Boolean)) {
      const split = entry.indexOf('\t'), path = entry.slice(split + 1);
      const [mode, type, hash] = entry.slice(0, split).split(' ');
      if (type !== 'blob') throw Error('Invalid outgoing object.');
      await inspect(path, mode, hash);
    }
  }
  if (paths.size) {
    const entries = String(await git(['ls-files', '--stage', '-z', '--', ...paths])).split('\0').filter(Boolean);
    for (const entry of entries) {
      const split = entry.indexOf('\t'), path = entry.slice(split + 1);
      const [mode, hash, stage] = entry.slice(0, split).split(' ');
      await inspect(path, mode, hash, stage);
    }
  }
  const result = { checked, new_commits: commits.length, history_scanned: false, blob_bytes: bytes, duration_ms: Math.round(performance.now() - started) };
  onValidation?.(result);
  return result;
}
