import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultDataDir } from './history.mjs';
import { createDraftBackup, validateDraftBackup, parseDraftBackup, draftDigest, serializeDraft } from './draft-backup.mjs';
import { validateBundleFiles } from './sync-security.mjs';
import { withCoachSyncLock, coachSyncRunner, verifyPrivateSyncRepository, prepareSyncCheckout,
  coachSyncLocations, readCoachSyncState, atomicSyncWrite, safeSyncOutputParents, verifySyncRemote,
  assertOutgoingSyncOwnership, assertStagedSyncOwnership } from './coach-sync.mjs';
const fail = message => { throw new Error(message); };
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Explicit invocation only. Local SQLite remains the durable pending queue.
 * No deletion/eviction or remote merge by capture time is permitted. */
export async function syncDraftCapture(options = {}) {
  const dataDir = options.dataDir ?? defaultDataDir();
  return withCoachSyncLock(dataDir, async () => {
    const snapshot = await createDraftBackup({ dataDir });
    validateDraftBackup(snapshot); validateBundleFiles(snapshot.files);
    const configured = await readCoachSyncState(dataDir);
    if (!configured.enabled || !configured.repository) fail('Draft backup requires the configured private data repository.');
    const run = coachSyncRunner(options), repository = configured.repository;
    const identity = async () => {
      const value = JSON.parse(await run('gh', ['api', `repos/${repository}`, '--jq', '{id,node_id,private,full_name,default_branch}']));
      if (!Number.isSafeInteger(value.id) || typeof value.node_id !== 'string' || !value.node_id || value.private !== true || value.full_name !== repository) fail('Draft repository identity changed.');
      return value;
    };
    const stable = await identity();
    const meta = await verifyPrivateSyncRepository(repository, run);
    const repoDir = coachSyncLocations(dataDir).repo;
    const { git, branch, validate } = await prepareSyncCheckout(configured, meta, run, repoDir, { ...options, fastSync: options.fastSync ?? true });
    if (branch !== stable.default_branch) fail('Draft destination branch changed.');
    await assertOutgoingSyncOwnership(git, branch, 'draft', Boolean(meta.defaultBranchRef?.name));
    // A second device or a reset local DB must not replace a different lineage.
    const priorPaths = String(await git(['ls-tree', '--name-only', `origin/${branch}`, '--', 'drafts/index.json'])).trim();
    if (priorPaths) {
      const prior = parseDraftBackup('drafts/index.json', String(await git(['show', `origin/${branch}:drafts/index.json`])));
      for (const account of prior.accounts) {
        const next = snapshot.index.accounts.find(a => a.account_key === account.account_key);
        if (!next || next.observations < account.observations) fail('Remote account history is not a prefix of this capture.');
        const priorText = String(await git(['show', `origin/${branch}:${account.path}`]));
        if (Buffer.byteLength(priorText) !== account.bytes || draftDigest(priorText) !== account.sha256) fail('Remote account index integrity failed.');
        const priorIndex = parseDraftBackup(account.path, priorText);
        const localIndex = parseDraftBackup(next.path, snapshot.files.get(next.path));
        if (priorIndex.gaps > localIndex.gaps) fail('Remote gap history cannot be discarded.');
        const local = localIndex.chunks.flatMap(c => parseDraftBackup(c.path, snapshot.files.get(c.path)).observations);
        let cursor = 0;
        for (const chunk of priorIndex.chunks) {
          const text = String(await git(['show', `origin/${branch}:${chunk.path}`]));
          if (Buffer.byteLength(text) !== chunk.bytes || draftDigest(text) !== chunk.sha256) fail('Remote draft chunk integrity failed.');
          for (const item of parseDraftBackup(chunk.path, text).observations) {
            if (serializeDraft(item) !== serializeDraft(local[cursor++])) fail('Remote draft lineage conflicts with local observations.');
          }
        }
      }
    }
    for (const [path, text] of snapshot.files) {
      await safeSyncOutputParents(repoDir, path);
      const target = join(repoDir, path);
      let old;
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) fail('Draft output must be a regular file.');
        old = await readFile(target, 'utf8');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (path.includes('/objects/') && old !== undefined && old !== text) fail('Immutable draft chunk changed.');
      if (old !== text) await atomicSyncWrite(target, text);
    }
    await git(['add', '-f', '--', ...snapshot.files.keys()]);
    await assertStagedSyncOwnership(git, 'draft'); await validate();
    if (String(await git(['diff', '--cached', '--name-only', '-z'])).length) await git(['commit', '-m', 'Back up sanitized draft observations']);
    const checked = await identity();
    if (serializeDraft(checked) !== serializeDraft(stable)) fail('Draft destination identity changed before publication.');
    await verifyPrivateSyncRepository(repository, run); await verifySyncRemote(git, repository);
    await assertOutgoingSyncOwnership(git, branch, 'draft', Boolean(meta.defaultBranchRef?.name));
    await assertStagedSyncOwnership(git, 'draft');
    if (String(await git(['diff', '--cached', '--name-only', '-z'])).length) fail('Unexpected staged changes before draft push.');
    await validate();
    const outgoing = Number(String(await git(['rev-list', '--count', `origin/${branch}..HEAD`])).trim());
    // Normal fast-forward push: a concurrent remote update rejects, never force.
    if (outgoing) await git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
    await git(['fetch', '--prune', 'origin']);
    const revision = String(await git(['rev-parse', `origin/${branch}`])).trim();
    if (!COMMIT.test(revision)) fail('Draft readback revision is invalid.');
    await git(['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]);
    for (const [path, text] of snapshot.files) {
      const actual = await git(['show', `${revision}:${path}`], 'buffer');
      if (Buffer.byteLength(actual) !== Buffer.byteLength(text) || draftDigest(actual) !== draftDigest(text)) fail('Draft readback bytes differ; local queue retained.');
    }
    const receipt = { repository, repository_id: stable.id, branch, revision, content_hash: snapshot.content_hash,
      observations: snapshot.observations, verified_at: new Date().toISOString(), verified: true };
    await safeSyncOutputParents(dataDir, 'draft-sync/receipt.json');
    await atomicSyncWrite(join(dataDir, 'draft-sync/receipt.json'), serializeDraft(receipt));
    const observation_ids = [];
    for (const account of snapshot.index.accounts) {
      const index = parseDraftBackup(account.path, snapshot.files.get(account.path));
      for (const chunk of index.chunks) for (const observation of parseDraftBackup(chunk.path, snapshot.files.get(chunk.path)).observations) observation_ids.push(observation.observation_id);
    }
    await atomicSyncWrite(join(dataDir, 'draft-sync/published.json'), serializeDraft({ ...receipt, observation_ids }));
    return { synced: true, ...receipt };
  });
}
