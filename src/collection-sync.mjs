import { readFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultDataDir } from './history.mjs';
import { serializeCoachJson } from './coach-bundle.mjs';
import { validateCollectionSnapshot } from './collection.mjs';
import { validateBundleFiles, isCollectionSyncPath } from './sync-security.mjs';
import { collectionAccountKey, collectionPrefix, collectionReadmePath, collectionStatePath } from './collection-scope.mjs';
import { CoachSyncError, withCoachSyncLock, coachSyncRunner, verifyPrivateSyncRepository,
  prepareSyncCheckout, coachSyncLocations, readCoachSyncState, atomicSyncWrite,
  safeSyncOutputParents, verifySyncRemote, assertOutgoingSyncOwnership,
  assertStagedSyncOwnership } from './coach-sync.mjs';

const REPOSITORY = '1996Neil/mtga-ai-replay-data';
const PART_PATH = /^collection\/(?:accounts\/[a-f0-9]{64}\/)?latest\/parts\/cards-[0-9]{3,6}\.json$/;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const statePath = (dataDir, accountKey) => join(dataDir, collectionStatePath(accountKey));
const initialState = () => ({ schema: 'MTGA_COLLECTION_SYNC_V1', repository: REPOSITORY,
  pending: false, last_synced: null, last_error: null });
const fail = (code, message) => { throw new CoachSyncError(code, message); };
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function validState(state) {
  const keys = ['schema', 'repository', 'pending', 'last_synced', 'last_error', ...(state?.pending === true ? ['pending_content_hash'] : [])];
  if (!exactKeys(state, keys) || state.schema !== 'MTGA_COLLECTION_SYNC_V1' || state.repository !== REPOSITORY || typeof state.pending !== 'boolean' ||
      (state.pending && (typeof state.pending_content_hash !== 'string' || !SHA.test(state.pending_content_hash)))) return false;
  const synced = state.last_synced;
  if (synced !== null && (!exactKeys(synced, ['at', 'commit', 'content_hash', 'verified']) ||
      !timestamp(synced.at) || typeof synced.commit !== 'string' || !COMMIT.test(synced.commit) ||
      typeof synced.content_hash !== 'string' || !SHA.test(synced.content_hash) || synced.verified !== true)) return false;
  const error = state.last_error;
  return error === null || (exactKeys(error, ['code', 'message', 'at']) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) &&
    typeof error.message === 'string' && error.message.length > 0 && error.message.length <= 1024 && timestamp(error.at));
}

async function readState(dataDir, accountKey) {
  try {
    await safeSyncOutputParents(dataDir, collectionStatePath(accountKey));
    const path = statePath(dataDir, accountKey), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('COLLECTION_SYNC_STATE', 'Collection sync state must be a regular file.');
    const text = await readFile(path, 'utf8');
    // State can appear in CLI diagnostics. Scan the raw bytes (including
    // discarded duplicate properties) before returning any persisted values.
    validateBundleFiles(new Map([['collection/latest/summary.json', text]]));
    const state = JSON.parse(text);
    if (!validState(state)) fail('COLLECTION_SYNC_STATE', 'Collection sync state is invalid; no upload was attempted.');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return initialState();
    if (error instanceof CoachSyncError) throw error;
    fail('COLLECTION_SYNC_STATE', 'Collection sync state is invalid; no upload was attempted.');
  }
}
async function saveState(dataDir, state, accountKey) {
  await safeSyncOutputParents(dataDir, collectionStatePath(accountKey));
  await atomicSyncWrite(statePath(dataDir, accountKey), serializeCoachJson(state));
}
export async function getCollectionSyncStatus(options = {}) {
  const state = await readState(options.dataDir ?? defaultDataDir(), options.accountKey);
  return { repository: state.repository, pending: state.pending ? 1 : 0,
    last_synced: state.last_synced, last_error: state.last_error };
}

async function verifyPublishedSnapshot(snapshot, git, branch, validate, accountKey) {
  // Verify fetched remote objects, rather than treating the local HEAD or a
  // successful transport exit as proof that GPT has the intended snapshot.
  await git(['fetch', '--prune', 'origin']);
  const ref = `refs/remotes/origin/${branch}`;
  const commit = String(await git(['rev-parse', '--verify', ref])).trim();
  if (!COMMIT.test(commit)) fail('COLLECTION_REMOTE_VERIFY', 'Published collection commit could not be verified.');
  await git(['merge-base', '--is-ancestor', 'HEAD', ref]);
  await validate();
  const paths = String(await git(['ls-tree', '-r', '--name-only', '-z', '--full-tree', commit, '--',
    collectionPrefix(accountKey), collectionReadmePath(accountKey)])).split('\0').filter(Boolean).sort();
  if (JSON.stringify(paths) !== JSON.stringify([...snapshot.files.keys()].sort())) fail('COLLECTION_REMOTE_VERIFY', 'Published collection file coverage differs from the validated snapshot.');
  for (const [path, expected] of snapshot.files) {
    const actual = await git(['show', `${commit}:${path}`], 'buffer');
    if (digest(actual) !== digest(expected) || Buffer.byteLength(actual) !== Buffer.byteLength(expected)) fail('COLLECTION_REMOTE_VERIFY', 'Published collection bytes differ from the validated snapshot.');
  }
  return commit;
}

async function publish(snapshot, options, dataDir) {
  const accountKey = collectionAccountKey(options.accountKey), prefix = collectionPrefix(accountKey), readme = collectionReadmePath(accountKey);
  const accountPathAllowed = path => path === readme || path.startsWith(prefix);
  const configured = await readCoachSyncState(dataDir);
  if (!configured.enabled || configured.repository !== REPOSITORY) fail('COLLECTION_SYNC_REPOSITORY', 'Collection upload requires the existing configured private data repository.');
  const run = coachSyncRunner(options), meta = await verifyPrivateSyncRepository(REPOSITORY, run);
  if (meta.nameWithOwner !== REPOSITORY) fail('COLLECTION_SYNC_REPOSITORY', 'Collection repository identity does not match the required private data repository.');
  const repoDir = coachSyncLocations(dataDir).repo;
  const { git, branch, validate } = await prepareSyncCheckout(configured, meta, run, repoDir);
  await assertOutgoingSyncOwnership(git, branch, 'collection', Boolean(meta.defaultBranchRef?.name), accountPathAllowed);

  const obsolete = String(await git(['ls-files', '-z', '--', `${prefix}parts/`])).split('\0').filter(Boolean)
    .filter(path => !snapshot.files.has(path));
  for (const path of obsolete) {
    if (!PART_PATH.test(path)) fail('COLLECTION_SYNC_PATH', 'Unexpected file in the collection parts directory; no files were removed.');
  }
  for (const [path, content] of snapshot.files) {
    await safeSyncOutputParents(repoDir, path);
    const target = join(repoDir, path);
    let existing;
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('COLLECTION_SYNC_PATH', 'Collection output must be a regular file.');
      existing = await readFile(target, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Rechecking unchanged cards only updates lightweight verification files.
    if (existing !== content) await atomicSyncWrite(target, content);
  }
  for (const path of obsolete) await rm(join(repoDir, path));
  // The existing data checkout may ignore the new namespace. This explicit
  // whitelist stages only collection files and its own obsolete shard deletes.
  await git(['add', '-f', '--', ...snapshot.files.keys(), ...obsolete]);
  await assertStagedSyncOwnership(git, 'collection', accountPathAllowed);
  await validate();
  if (String(await git(['diff', '--cached', '--name-only', '-z'])).length) await git(['commit', '-m', 'Update sanitized collection snapshot']);

  const checked = await verifyPrivateSyncRepository(REPOSITORY, run);
  if (checked.nameWithOwner !== REPOSITORY || (checked.defaultBranchRef?.name && checked.defaultBranchRef.name !== branch)) fail('COLLECTION_SYNC_REPOSITORY', 'Collection repository identity or default branch changed; no push was attempted.');
  await verifySyncRemote(git, REPOSITORY);
  await assertStagedSyncOwnership(git, 'collection', accountPathAllowed);
  if (String(await git(['diff', '--cached', '--name-only', '-z'])).length) fail('SYNC_DIRTY', 'Unexpected staged changes appeared before upload; no push was attempted.');
  await assertOutgoingSyncOwnership(git, branch, 'collection', Boolean(meta.defaultBranchRef?.name), accountPathAllowed);
  await validate();
  const outgoing = meta.defaultBranchRef?.name ? Number(String(await git(['rev-list', '--count', `origin/${branch}..HEAD`])).trim()) : 1;
  if (outgoing) await git(['push', '--set-upstream', 'origin', branch]);
  return verifyPublishedSnapshot(snapshot, git, branch, validate, accountKey);
}

export async function syncCollectionSnapshot(snapshot, options = {}) {
  const dataDir = options.dataDir ?? defaultDataDir();
  const accountKey = collectionAccountKey(options.accountKey);
  if (snapshot.summary?.account_key !== accountKey) fail('COLLECTION_ACCOUNT_INVALID', 'Collection ownership does not match the selected account; no upload was attempted.');
  return withCoachSyncLock(dataDir, async () => {
    const state = await readState(dataDir, accountKey);
    try {
      try { validateCollectionSnapshot(snapshot); }
      catch { fail('COLLECTION_SNAPSHOT_INVALID', 'Collection snapshot is invalid; no upload was attempted.'); }
      if (!(snapshot.files instanceof Map) || !SHA.test(snapshot.summary?.content_hash ?? '') ||
          [...snapshot.files].some(([path, text]) => !isCollectionSyncPath(path) || typeof text !== 'string')) fail('COLLECTION_SNAPSHOT_INVALID', 'Collection snapshot is invalid; no upload was attempted.');
      validateBundleFiles(snapshot.files);
      state.pending = true; state.pending_content_hash = snapshot.summary.content_hash;
      await saveState(dataDir, state, accountKey);
      const commit = await publish(snapshot, options, dataDir);
      state.pending = false; delete state.pending_content_hash; state.last_error = null;
      state.last_synced = { at: new Date().toISOString(), commit, content_hash: snapshot.summary.content_hash, verified: true };
      await saveState(dataDir, state, accountKey);
      return { synced: true, repository: REPOSITORY, last_synced: state.last_synced, verified: true };
    } catch (error) {
      const safe = error instanceof CoachSyncError || (error?.name === 'SyncSecurityError' && error.code === 'MTGA_SYNC_SECURITY')
        ? error : new CoachSyncError('COLLECTION_SYNC_FAILED', 'Collection sync failed; the local snapshot was retained. Retry with mtga-gpt-collection sync.');
      state.last_error = { code: safe.code, message: safe.message, at: new Date().toISOString() };
      await saveState(dataDir, state, accountKey); throw safe;
    }
  });
}
