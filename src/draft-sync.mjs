import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultDataDir } from './history.mjs';
import { createDraftBackup, parseDraftBackup, draftDigest, serializeDraft, attachDraftBindings } from './draft-backup.mjs';
import { buildPublishedDraftLinks, draftBindingInputKey } from './draft-publication.mjs';
import { fileRevision } from './lightweight.mjs';
import { withCoachSyncLock, coachSyncRunner, verifyPrivateSyncRepository, prepareSyncCheckout,
  coachSyncLocations, readCoachSyncState, atomicSyncWrite, safeSyncOutputParents, verifySyncRemote,
  assertOutgoingSyncOwnership, assertStagedSyncOwnership } from './coach-sync.mjs';
const fail = message => { throw new Error(message); };
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Explicit invocation only. Local SQLite remains the durable pending queue.
 * No deletion/eviction or remote merge by capture time is permitted. */
export async function syncDraftCapture(options = {}) {
  const dataDir = options.dataDir ?? defaultDataDir();
  const work = { observation_rows: 0, lineage_blob_reads: 0, staged_files: 0, readback_files: 0,
    proofs_reused: 0, proofs_checked: 0, canonical_builds: 0, chunks_built: 0, chunks_reused: 0,
    segments_built: 0, segments_reused: 0 };
  if (options.automatic) {
    try {
      const path = join(dataDir, 'draft-sync/idle.json'), info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink() && info.size < 16384) {
        const receipt = JSON.parse(await readFile(path, 'utf8')), input = await draftBindingInputKey(dataDir);
        if (receipt.schema === 'MTGA_DRAFT_IDLE_V1' && receipt.verified === true && COMMIT.test(receipt.revision ?? '') &&
          /^[a-f0-9]{64}$/.test(receipt.content_hash ?? '') && receipt.input_key === input &&
          receipt.publication_files === await fileRevision(dataDir, ['draft-sync/published.json', 'draft-sync/published-bindings.json'])) {
          options.onWork?.(work);
          return { ...receipt, synced: true, cached: true, remote_checked: false, input_changed: false, work };
        }
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  return withCoachSyncLock(dataDir, async () => {
    const initialInputKey = await draftBindingInputKey(dataDir);
    let snapshot = await createDraftBackup({ dataDir,
      onRead: value => { work.observation_rows += value.observation_rows; },
      onBuild: value => { work.chunks_built += value.built; work.chunks_reused += value.reused; } });
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
    const { git, branch, validate } = await prepareSyncCheckout(configured, meta, run, repoDir,
      { ...options, fastSync: options.fastSync ?? true, deferFullHistoryValidation: true });
    if (branch !== stable.default_branch) fail('Draft destination branch changed.');
    await assertOutgoingSyncOwnership(git, branch, 'draft', Boolean(meta.defaultBranchRef?.name));
    const sourceRevision = String(await git(['rev-parse', `origin/${branch}`])).trim();
    const documents = await buildPublishedDraftLinks(snapshot, { dataDir, git, revision: sourceRevision, work });
    snapshot = attachDraftBindings(snapshot, documents);
    // A second device or a reset local DB must not replace a different lineage.
    const priorPaths = String(await git(['ls-tree', '--name-only', `origin/${branch}`, '--', 'drafts/index.json'])).trim();
    if (priorPaths) {
      const prior = parseDraftBackup('drafts/index.json', String(await git(['show', `origin/${branch}:drafts/index.json`])));
      for (const account of prior.accounts) {
        const next = snapshot.index.accounts.find(a => a.account_key === account.account_key);
        if (!next || next.observations < account.observations) fail('Remote account history is not a prefix of this capture.');
        if (next.sha256 === account.sha256 && next.bytes === account.bytes) continue;
        const priorText = String(await git(['show', `origin/${branch}:${account.path}`]));
        work.lineage_blob_reads++;
        if (Buffer.byteLength(priorText) !== account.bytes || draftDigest(priorText) !== account.sha256) fail('Remote account index integrity failed.');
        const priorIndex = parseDraftBackup(account.path, priorText);
        const localIndex = parseDraftBackup(next.path, snapshot.files.get(next.path));
        if (priorIndex.gaps > localIndex.gaps) fail('Remote gap history cannot be discarded.');
        for (const [i, chunk] of priorIndex.chunks.entries()) {
          const current = localIndex.chunks[i];
          if (!current) fail('Remote draft lineage conflicts with local observations.');
          if (chunk.sha256 === current.sha256 && chunk.bytes === current.bytes && chunk.count === current.count) continue;
          if (chunk.count === 100) fail('Remote draft lineage conflicts with local observations.');
          const text = String(await git(['show', `origin/${branch}:${chunk.path}`]));
          work.lineage_blob_reads++;
          if (Buffer.byteLength(text) !== chunk.bytes || draftDigest(text) !== chunk.sha256) fail('Remote draft chunk integrity failed.');
          const local = parseDraftBackup(current.path, snapshot.files.get(current.path)).observations;
          for (const [n, item] of parseDraftBackup(chunk.path, text).observations.entries()) {
            if (serializeDraft(item) !== serializeDraft(local[n])) fail('Remote draft lineage conflicts with local observations.');
          }
        }
      }
    }
    const format = String(await git(['rev-parse', '--show-object-format'])).trim();
    if (!['sha1', 'sha256'].includes(format)) fail('Unsupported Git object format.');
    const objectId = text => createHash(format).update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
    const indexed = new Map(), paths = [...snapshot.files.keys()];
    for (let i = 0; i < paths.length; i += 128) {
      for (const row of String(await git(['ls-files', '--stage', '-z', '--', ...paths.slice(i, i + 128)])).split('\0').filter(Boolean)) {
        const [meta, path] = row.split('\t'), [mode, oid, stage] = meta.split(' ');
        if (!['100644', '100755'].includes(mode) || stage !== '0') fail('Invalid draft output entry.');
        indexed.set(path, oid);
      }
    }
    const changed = new Map([...snapshot.files].filter(([path, text]) => indexed.get(path) !== objectId(text)));
    for (const [path, text] of changed) {
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
    const changedPaths = [...changed.keys()];
    for (let i = 0; i < changedPaths.length; i += 128) await git(['add', '-f', '--', ...changedPaths.slice(i, i + 128)]);
    work.staged_files = changedPaths.length;
    await assertStagedSyncOwnership(git, 'draft'); await validate();
    if (String(await git(['diff', '--cached', '--name-only', '-z'])).length) await git(['commit', '-m', 'Publish draft observations and verified match associations']);
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
    const publishedObjects = new Map();
    for (let i = 0; i < paths.length; i += 128) for (const row of String(await git(['ls-tree', '-rz', revision, '--', ...paths.slice(i, i + 128)])).split('\0').filter(Boolean)) {
      const [meta, path] = row.split('\t'), [mode, type, oid] = meta.split(' ');
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) fail('Invalid published draft object.');
      publishedObjects.set(path, oid);
    }
    for (const [path, text] of snapshot.files) if (publishedObjects.get(path) !== objectId(text))
      fail('Draft readback object differs; local queue retained.');
    for (const path of new Set(['drafts/index.json', ...changedPaths])) {
      const text = snapshot.files.get(path);
      const actual = await git(['show', `${revision}:${path}`], 'buffer');
      work.readback_files++;
      if (Buffer.byteLength(actual) !== Buffer.byteLength(text) || draftDigest(actual) !== draftDigest(text)) fail('Draft readback bytes differ; local queue retained.');
    }
    const receipt = { repository, repository_id: stable.id, branch, revision, content_hash: snapshot.content_hash,
      observations: snapshot.observations, input_key: initialInputKey,
      linked_runs: [...documents.values()].reduce((sum, doc) => sum + doc.runs.filter(run => run.status === 'linked').length, 0),
      pending_runs: [...documents.values()].reduce((sum, doc) => sum + doc.runs.filter(run => run.status !== 'linked' || run.pending_match_ids.length).length, 0),
      pending_matches: [...documents.values()].reduce((sum, doc) => sum + doc.runs.reduce((n, run) => n + run.pending_match_ids.length, 0), 0),
      verified_at: new Date().toISOString(), verified: true };
    await safeSyncOutputParents(dataDir, 'draft-sync/receipt.json');
    await atomicSyncWrite(join(dataDir, 'draft-sync/receipt.json'), serializeDraft(receipt));
    const observation_ids = [];
    for (const account of snapshot.index.accounts) {
      const index = parseDraftBackup(account.path, snapshot.files.get(account.path));
      for (const chunk of index.chunks) for (const observation of parseDraftBackup(chunk.path, snapshot.files.get(chunk.path)).observations) observation_ids.push(observation.observation_id);
    }
    await atomicSyncWrite(join(dataDir, 'draft-sync/published-bindings.json'), serializeDraft({
      schema: 'MTGA_PUBLISHED_DRAFT_BINDINGS_V1', revision, content_hash: snapshot.content_hash,
      index: snapshot.index, documents: Object.fromEntries([...documents]),
    }));
    await atomicSyncWrite(join(dataDir, 'draft-sync/published.json'), serializeDraft({ ...receipt, observation_ids }));
    await atomicSyncWrite(join(dataDir, 'draft-sync/idle.json'), serializeDraft({
      ...receipt, schema: 'MTGA_DRAFT_IDLE_V1',
      publication_files: await fileRevision(dataDir, ['draft-sync/published.json', 'draft-sync/published-bindings.json']),
    }));
    options.onWork?.(work);
    return { synced: true, ...receipt, remote_checked: true, work,
      input_changed: initialInputKey !== await draftBindingInputKey(dataDir) };
  }, options);
}
