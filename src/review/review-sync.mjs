import { mkdir, lstat, open, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultDataDir } from '../history.mjs';
import { coachSyncRunner, readCoachSyncState, verifyPrivateSyncRepository, verifySyncRemote } from '../coach-sync.mjs';
import { validateStagedRepository, validateSyncHistoryApproval } from '../sync-security.mjs';
import { findReviewGame } from './review-model.mjs';
import { readPublishedReviewSource, validateCloudReviewBinding, reviewPath } from './cloud-review.mjs';
import { createComputePool } from '../compute-pool.mjs';
import { parseCloudReview, reviewReject, MAX_REVIEW_BYTES, CLOUD_REVIEW_POLICY } from './cloud-review-contract.mjs';

async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) reviewReject('sync-directory');
}
async function cache(dataDir, write, callback) {
  const path = join(dataDir, 'reviews.sqlite3');
  if (write) await directory(dataDir);
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) reviewReject('cache-file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; if (!write) return null; }
  const database = new DatabaseSync(path, { readOnly: !write });
  try {
    if (write) await chmod(path, 0o600);
    if (write) database.exec(`CREATE TABLE IF NOT EXISTS cloud_review_cache (
      repository TEXT NOT NULL, branch TEXT NOT NULL, match_id TEXT NOT NULL, game_number INTEGER NOT NULL,
      checked_at TEXT NOT NULL, local_fingerprint TEXT NOT NULL, report_json TEXT NOT NULL,
      remote_revision TEXT NOT NULL DEFAULT '', PRIMARY KEY(repository, branch, match_id, game_number));
      CREATE TABLE IF NOT EXISTS cloud_review_targets (
      repository TEXT PRIMARY KEY, branch TEXT NOT NULL, checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_review_observations (
      repository TEXT NOT NULL, branch TEXT NOT NULL, match_id TEXT NOT NULL, game_number INTEGER NOT NULL,
      revision TEXT NOT NULL, status TEXT NOT NULL, checked_at TEXT NOT NULL,
      PRIMARY KEY(repository,branch,match_id,game_number))`);
    if (write && !database.prepare('PRAGMA table_info(cloud_review_cache)').all().some(row => row.name === 'remote_revision'))
      database.exec("ALTER TABLE cloud_review_cache ADD COLUMN remote_revision TEXT NOT NULL DEFAULT ''");
    else if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='cloud_review_cache'").get()) return null;
    return callback(database);
  } finally { database.close(); }
}

/** Independent fetch-only checkout. Never checkout, merge, commit, push, copy to
 * the upload worktree, write a source file, or return credential data. */
export async function fetchCloudReview(matchId, gameNumber, options = {}) {
  const path = reviewPath(matchId, gameNumber), dataDir = options.dataDir ?? defaultDataDir();
  const state = await readCoachSyncState(dataDir);
  if (!state.enabled) reviewReject('sync-not-configured');
  const run = coachSyncRunner(options);
  const root = join(dataDir, 'review-sync'), repo = join(root, 'repository');
  await directory(dataDir); await directory(root); await directory(repo);
  let lock;
  try { lock = await open(join(root, 'fetch.lock'), 'wx', 0o600); }
  catch { reviewReject('sync-busy-or-retained-lock'); }
  try {
    await lock.writeFile(String(process.pid));
    // Resolve and persist the target inside the same fetch lease, before any
    // untrusted report parse can fail. A slow old fetch cannot rewind a newer
    // branch receipt after releasing its lease.
    const meta = await verifyPrivateSyncRepository(state.repository, run), branch = meta.defaultBranchRef?.name;
    if (!branch || !/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/.test(branch) || branch.includes('..')) reviewReject('empty-or-invalid-remote');
    await options.onVerifiedTarget?.({ repository: meta.nameWithOwner, branch });
    const git = (args, settings = {}) => run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, ...settings, env: {
        GIT_DIR: join(repo, '.git'), GIT_WORK_TREE: repo, GIT_INDEX_FILE: join(repo, '.git/index') } });
    try { const info = await lstat(join(repo, '.git')); if (!info.isDirectory() || info.isSymbolicLink()) reviewReject('sync-git-directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error;
      await git(['init', '-b', 'review-reader']); await git(['remote', 'add', 'origin', `https://github.com/${meta.nameWithOwner}.git`]); }
    await verifySyncRemote(git, meta.nameWithOwner);
    if (String(await git(['status', '--porcelain', '--untracked-files=all', '--ignored=matching'])).trim()) reviewReject('sync-dirty');
    await git(['fetch', '--prune', '--no-tags', 'origin']);
    await validateStagedRepository(repo, { repository: meta.nameWithOwner, branch, computePool: options.computePool,
      historyApproval: validateSyncHistoryApproval(state.history_approval, { repository: meta.nameWithOwner, branch }) });
    const revision = String(await git(['rev-parse', `refs/remotes/origin/${branch}`])).trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)) reviewReject('sync-revision');
    await options.onVerifiedRevision?.({ repository: meta.nameWithOwner, branch, matchId, gameNumber, revision });
    const entries = String(await git(['ls-tree', '-rz', revision])).split('\0').filter(Boolean);
    const paths = new Map(entries.map(row => { const [meta, path] = row.split('\t'); return [path, meta]; }));
    const read = async (path, max = 2 * 1024 * 1024) => {
      const meta = paths.get(path); if (!meta?.startsWith('100644 blob ') && !meta?.startsWith('100755 blob ')) reviewReject('source-file-mode');
      const oid = meta.split(' ')[2];
      const bytes = Number(String(await git(['cat-file', '-s', oid])));
      if (!Number.isSafeInteger(bytes) || bytes > max) reviewReject('source-size-limit');
      return await git(['cat-file', 'blob', oid], { encoding: 'buffer' });
    };
    const files = new Map([['index.json', await read('index.json')]]);
    let index; try { index = JSON.parse(files.get('index.json')); } catch { reviewReject('source-index'); }
    const matches = index.matches?.filter(item => item.match_id === matchId);
    if (matches?.length !== 1 || !/^matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(matches[0].path ?? '')) reviewReject('source-index');
    const prefix = matches[0].path, manifestPath = `${prefix}/manifest.json`;
    files.set(manifestPath, await read(manifestPath));
    let manifest; try { manifest = JSON.parse(files.get(manifestPath)); } catch { reviewReject('source-manifest'); }
    const names = Object.keys(manifest.files ?? {});
    if (names.length > 515) reviewReject('source-manifest');
    for (const name of names) {
      const path = ['summary.json', 'coach.json', 'cards.json'].includes(name) ? `${prefix}/${name}` : name;
      if (!path.startsWith(`${prefix}/`) || !/^(?:matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/(?:summary|coach|cards)\.json|matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/parts\/part-[0-9]{4,6}\.json)$/.test(path)) reviewReject('source-part-path');
      files.set(path, await read(path));
    }
    const report = paths.has(path) ? parseCloudReview(await read(path, MAX_REVIEW_BYTES), { path }) : null;
    const sourceInput = { files, matchId, revision };
    return options.deferSourceVerification ? { repository: meta.nameWithOwner, branch, sourceInput, report }
      : { repository: meta.nameWithOwner, branch, source: readPublishedReviewSource(sourceInput), report };
  } finally {
    const original = await lock.stat(), current = await lstat(join(root, 'fetch.lock')).catch(() => null);
    if (current?.ino === original.ino && current?.dev === original.dev && !current.isSymbolicLink()) await rm(join(root, 'fetch.lock'));
    await lock.close();
  }
}

/** Cloud-only reader and cache. Local state must reproduce the exact published
 * bundle before a cloud report may acquire markers in the local timeline. */
export function createCloudReviewReader({ loadReplay, dataDir = defaultDataDir(), fetchReview = fetchCloudReview, ...options }) {
  const tasks = new Map(); let closing = false;
  let ownedPool;
  const compute = () => options.computePool ?? (ownedPool ??= createComputePool({ size: 2 }));
  const keyOf = (id, game) => `${id}:${game}`;
  async function read(id, gameNumber) {
    reviewPath(id, gameNumber);
    const replay = await loadReplay(id), game = findReviewGame(replay, gameNumber);
    if (!game) return { code: 404, error: 'Unknown replay game.' };
    const task = tasks.get(keyOf(id, gameNumber));
    const state = await readCoachSyncState(dataDir);
    const cached = state.repository ? await cache(dataDir, false, db => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cloud_review_targets'").get()) return null;
      const row = db.prepare(`SELECT c.* FROM cloud_review_cache c JOIN cloud_review_targets t
        ON c.repository=t.repository AND c.branch=t.branch WHERE c.repository=? AND c.match_id=? AND c.game_number=?`).get(state.repository, id, gameNumber);
      const observed = db.prepare("SELECT 1 FROM sqlite_master WHERE name='cloud_review_observations'").get()
        ? db.prepare(`SELECT o.* FROM cloud_review_observations o JOIN cloud_review_targets t
          ON o.repository=t.repository AND o.branch=t.branch WHERE o.repository=? AND o.match_id=? AND o.game_number=?`).get(state.repository, id, gameNumber) : null;
      return { row, observed };
    }) : null;
    const { row, observed } = cached ?? {};
    const base = { can_sync: state.enabled && !closing, checked_at: observed?.checked_at ?? row?.checked_at ?? null };
    if (task?.status === 'syncing') return { ...base, status: 'syncing' };
    if (task?.status === 'stale') return { ...base, status: 'stale' };
    if (observed?.status === 'stale' || (observed && row && (observed.revision !== row.remote_revision || observed.status === 'observed'))) return { ...base, status: 'stale' };
    if (!row) return { ...base, status: task?.status === 'error' ? 'error' : task?.status === 'stale' ? 'stale' : 'missing', error: task?.error };
    const report = parseCloudReview(row.report_json, { path: reviewPath(id, gameNumber) });
    if (report.source_content_hash !== state.synced[id]?.content_hash || report.policy_version !== CLOUD_REVIEW_POLICY) return { ...base, status: 'stale' };
    const result = await compute().run('cloudReviewRead', { replay, report, expectedFingerprint: row.local_fingerprint });
    if (result.status !== 'ready') return { ...base, status: 'stale' };
    const currentSettings = await readCoachSyncState(dataDir);
    if (currentSettings.repository !== state.repository || currentSettings.synced[id]?.content_hash !== report.source_content_hash) return { ...base, status: 'stale' };
    // A different reader can invalidate or replace this cache while the worker
    // is normalizing it. Recheck the durable receipt AFTER that async boundary.
    const currentReceipt = await cache(dataDir, false, db => {
      const target = db.prepare('SELECT branch FROM cloud_review_targets WHERE repository=?').get(state.repository);
      const current = db.prepare('SELECT * FROM cloud_review_cache WHERE repository=? AND branch=? AND match_id=? AND game_number=?').get(state.repository, row.branch, id, gameNumber);
      if (target?.branch !== row.branch || !current || current.remote_revision !== row.remote_revision || current.report_json !== row.report_json || current.local_fingerprint !== row.local_fingerprint) return false;
      const observation = db.prepare("SELECT 1 FROM sqlite_master WHERE name='cloud_review_observations'").get()
        ? db.prepare('SELECT revision,status FROM cloud_review_observations WHERE repository=? AND branch=? AND match_id=? AND game_number=?').get(state.repository, row.branch, id, gameNumber) : null;
      return !observation || (observation.revision === row.remote_revision && observation.status === 'ready');
    });
    if (!currentReceipt) return { ...base, status: 'stale' };
    if (tasks.get(keyOf(id, gameNumber))?.status === 'syncing') return { ...base, status: 'syncing' };
    return { ...base, ...result,
      offline: task?.status === 'error', error: task?.error };
  }
  function start(id, gameNumber) {
    reviewPath(id, gameNumber);
    if (closing) return { code: 503, error: 'Review reader is closing.' };
    const key = keyOf(id, gameNumber);
    if ([...tasks.values()].some(task => task.status === 'syncing')) return { code: tasks.get(key)?.status === 'syncing' ? 202 : 409, status: 'syncing' };
    const task = { status: 'syncing' }; tasks.delete(key); tasks.set(key, task);
    while (tasks.size > 32) tasks.delete(tasks.keys().next().value);
    task.done = (async () => {
      try {
        let verifiedRevision;
        const onVerifiedTarget = async ({ repository, branch }) => {
          const settings = await readCoachSyncState(dataDir);
          if (repository !== settings.repository || !/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/.test(branch ?? '') || branch.includes('..')) reviewReject('sync-target');
          await cache(dataDir, true, db => db.prepare(`INSERT INTO cloud_review_targets VALUES (?,?,?)
            ON CONFLICT(repository) DO UPDATE SET branch=excluded.branch,checked_at=excluded.checked_at`)
            .run(repository, branch, new Date().toISOString()));
        };
        const onVerifiedRevision = async value => {
          if (value.matchId !== id || value.gameNumber !== gameNumber || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.revision ?? '')) reviewReject('sync-revision');
          await cache(dataDir, true, db => {
            const target = db.prepare('SELECT branch FROM cloud_review_targets WHERE repository=?').get(value.repository);
            if (target?.branch !== value.branch) reviewReject('sync-target');
            db.prepare(`INSERT INTO cloud_review_observations VALUES (?,?,?,?,?,'observed',?)
              ON CONFLICT(repository,branch,match_id,game_number) DO UPDATE SET revision=excluded.revision,
              status=CASE WHEN cloud_review_observations.revision=excluded.revision THEN cloud_review_observations.status ELSE 'observed' END,
              checked_at=excluded.checked_at`).run(value.repository, value.branch, id, gameNumber, value.revision, new Date().toISOString());
          });
          verifiedRevision = value.revision;
        };
        const { source, sourceInput, report, repository, branch } = await fetchReview(id, gameNumber,
          { ...options, computePool: compute(), deferSourceVerification: true, dataDir, onVerifiedTarget, onVerifiedRevision });
        if (closing) return;
        const settings = await readCoachSyncState(dataDir);
        if (repository !== settings.repository || !/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/.test(branch ?? '')) reviewReject('sync-target');
        // Compatibility for trusted in-process fetch providers used by offline
        // integrations. The production fetch always records its revision inside
        // the fetch lease before parsing any untrusted source/report bytes.
        if (!verifiedRevision && fetchReview !== fetchCloudReview) await onVerifiedRevision({ repository, branch, matchId: id, gameNumber, revision: sourceInput?.revision ?? source?.revision });
        if (!verifiedRevision || verifiedRevision !== (sourceInput?.revision ?? source?.revision)) reviewReject('sync-revision');
        const publish = async (status, fingerprint) => cache(dataDir, true, db => {
          db.exec('BEGIN IMMEDIATE');
          try {
            const target = db.prepare('SELECT branch FROM cloud_review_targets WHERE repository=?').get(repository);
            const observation = db.prepare('SELECT revision FROM cloud_review_observations WHERE repository=? AND branch=? AND match_id=? AND game_number=?').get(repository, branch, id, gameNumber);
            if (target?.branch !== branch || observation?.revision !== verifiedRevision) { db.exec('ROLLBACK'); return false; }
            if (status === 'ready') db.prepare(`INSERT INTO cloud_review_cache VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(repository,branch,match_id,game_number) DO UPDATE SET checked_at=excluded.checked_at,
              local_fingerprint=excluded.local_fingerprint,report_json=excluded.report_json,remote_revision=excluded.remote_revision`)
              .run(repository, branch, id, gameNumber, new Date().toISOString(), fingerprint, JSON.stringify(report), verifiedRevision);
            else db.prepare('DELETE FROM cloud_review_cache WHERE repository=? AND branch=? AND match_id=? AND game_number=?').run(repository, branch, id, gameNumber);
            db.prepare('UPDATE cloud_review_observations SET status=?,checked_at=? WHERE repository=? AND branch=? AND match_id=? AND game_number=?')
              .run(status, new Date().toISOString(), repository, branch, id, gameNumber);
            db.exec('COMMIT'); return true;
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        });
        if (!report) {
          if (sourceInput) await compute().run('cloudReviewSync', { sourceInput, report: null });
          task.status = await publish('missing') ? 'missing' : 'stale'; return;
        }
        // Injected fetchers are trusted dependencies, but still need an opaque
        // source verdict. Production fetch returns raw bytes for worker checks.
        if (!sourceInput && validateCloudReviewBinding(report, source).status !== 'ready') { await publish('stale'); task.status = 'stale'; return; }
        const replay = await loadReplay(id), game = findReviewGame(replay, gameNumber);
        if (!game) reviewReject('local-game');
        const verified = await compute().run('cloudReviewSync', { sourceInput,
          sourceMetadata: sourceInput ? undefined : { cards: source.cards, history_key: source.history_key, content_hash: source.content_hash }, report, replay });
        if (verified.status !== 'ready') { await publish('stale'); task.status = 'stale'; return; }
        const fingerprint = verified.fingerprint;
        const current = await loadReplay(id), currentGame = findReviewGame(current, gameNumber);
        if (!currentGame || await compute().run('cloudReviewFingerprint', { replay: current }) !== fingerprint) { await publish('stale'); task.status = 'stale'; return; }
        if (closing) return;
        task.status = await publish('ready', fingerprint) ? 'ready' : 'stale';
      } catch { task.status = 'error'; task.error = '云端复盘同步未完成；保留上次校验结果，比赛记录未变。'; }
    })();
    return { code: 202, status: 'syncing' };
  }
  return { read, start, wait: () => Promise.all([...tasks.values()].map(task => task.done)),
    close: async () => { closing = true; await Promise.all([...tasks.values()].map(task => task.done)); await ownedPool?.close(); } };
}
