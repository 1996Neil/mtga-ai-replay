import { mkdir, lstat, open, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultDataDir } from '../history.mjs';
import { coachSyncRunner, readCoachSyncState, verifyPrivateSyncRepository, verifySyncRemote } from '../coach-sync.mjs';
import { validateStagedRepository, validateSyncHistoryApproval } from '../sync-security.mjs';
import { buildCoachBundle } from '../coach-bundle.mjs';
import { replayInputFingerprintAsync, findReviewGame, normalizeReplayReview } from './review-model.mjs';
import { readPublishedReviewSource, validateCloudReviewBinding, adaptCloudReview, reviewPath } from './cloud-review.mjs';
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
      PRIMARY KEY(repository, branch, match_id, game_number));
      CREATE TABLE IF NOT EXISTS cloud_review_targets (
      repository TEXT PRIMARY KEY, branch TEXT NOT NULL, checked_at TEXT NOT NULL)`);
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
    await validateStagedRepository(repo, { repository: meta.nameWithOwner, branch,
      historyApproval: validateSyncHistoryApproval(state.history_approval, { repository: meta.nameWithOwner, branch }) });
    const revision = String(await git(['rev-parse', `refs/remotes/origin/${branch}`])).trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)) reviewReject('sync-revision');
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
    const source = readPublishedReviewSource({ files, matchId, revision });
    const report = paths.has(path) ? parseCloudReview(await read(path, MAX_REVIEW_BYTES), { path }) : null;
    return { repository: meta.nameWithOwner, branch, source, report };
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
  const keyOf = (id, game) => `${id}:${game}`;
  async function read(id, gameNumber) {
    reviewPath(id, gameNumber);
    const replay = structuredClone(await loadReplay(id)), game = findReviewGame(replay, gameNumber);
    if (!game) return { code: 404, error: 'Unknown replay game.' };
    const task = tasks.get(keyOf(id, gameNumber));
    const state = await readCoachSyncState(dataDir);
    const row = state.repository ? await cache(dataDir, false, db => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cloud_review_targets'").get()) return null;
      return db.prepare(`SELECT c.* FROM cloud_review_cache c JOIN cloud_review_targets t
        ON c.repository=t.repository AND c.branch=t.branch WHERE c.repository=? AND c.match_id=? AND c.game_number=?`).get(state.repository, id, gameNumber);
    }) : null;
    const base = { can_sync: state.enabled && !closing, checked_at: row?.checked_at ?? null };
    if (task?.status === 'syncing') return { ...base, status: 'syncing' };
    if (task?.status === 'stale') return { ...base, status: 'stale' };
    if (!row) return { ...base, status: task?.status === 'error' ? 'error' : task?.status === 'stale' ? 'stale' : 'missing', error: task?.error };
    const report = parseCloudReview(row.report_json, { path: reviewPath(id, gameNumber) });
    const localFingerprint = await replayInputFingerprintAsync(replay);
    if (report.source_content_hash !== state.synced[id]?.content_hash || report.policy_version !== CLOUD_REVIEW_POLICY || localFingerprint !== row.local_fingerprint) return { ...base, status: 'stale' };
    const review = normalizeReplayReview(replay, gameNumber, report, { source: 'cloud:chatgpt-cloud-agent', now: report.generated_at, fingerprint: localFingerprint });
    review.summary.limitations = [...new Set([...report.coverage.limitations, ...review.summary.limitations])].slice(0, 4);
    return { ...base, status: 'ready', review: { ...review, source_content_hash: report.source_content_hash, coverage: report.coverage },
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
        const onVerifiedTarget = async ({ repository, branch }) => {
          const settings = await readCoachSyncState(dataDir);
          if (repository !== settings.repository || !/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/.test(branch ?? '') || branch.includes('..')) reviewReject('sync-target');
          await cache(dataDir, true, db => db.prepare(`INSERT INTO cloud_review_targets VALUES (?,?,?)
            ON CONFLICT(repository) DO UPDATE SET branch=excluded.branch,checked_at=excluded.checked_at`)
            .run(repository, branch, new Date().toISOString()));
        };
        const { source, report, repository, branch } = await fetchReview(id, gameNumber, { ...options, dataDir, onVerifiedTarget });
        if (closing) return;
        const settings = await readCoachSyncState(dataDir);
        if (repository !== settings.repository || !/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/.test(branch ?? '')) reviewReject('sync-target');
        if (!report) {
          await cache(dataDir, true, db => db.prepare('DELETE FROM cloud_review_cache WHERE repository=? AND match_id=? AND game_number=?').run(repository, id, gameNumber));
          task.status = 'missing'; return;
        }
        if (validateCloudReviewBinding(report, source).status !== 'ready') { task.status = 'stale'; return; }
        const replay = structuredClone(await loadReplay(id)), game = findReviewGame(replay, gameNumber);
        if (!game) reviewReject('local-game');
        const bundle = await buildCoachBundle(replay, { cards: source.cards, historyKey: source.history_key, multipart: true });
        if (bundle.contentHash !== source.content_hash) { task.status = 'stale'; return; }
        await adaptCloudReview(report, source); // Exercise #4 semantics before caching.
        const fingerprint = await replayInputFingerprintAsync(replay);
        const current = await loadReplay(id), currentGame = findReviewGame(current, gameNumber);
        if (!currentGame || await replayInputFingerprintAsync(current) !== fingerprint) { task.status = 'stale'; return; }
        if (closing) return;
        await cache(dataDir, true, db => db.prepare(`INSERT INTO cloud_review_cache VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(repository,branch,match_id,game_number) DO UPDATE SET checked_at=excluded.checked_at, local_fingerprint=excluded.local_fingerprint,report_json=excluded.report_json`)
          .run(repository, branch, id, gameNumber, new Date().toISOString(), fingerprint, JSON.stringify(report)));
        task.status = 'ready';
      } catch { task.status = 'error'; task.error = '云端复盘同步未完成；保留上次校验结果，比赛记录未变。'; }
    })();
    return { code: 202, status: 'syncing' };
  }
  return { read, start, wait: () => Promise.all([...tasks.values()].map(task => task.done)),
    close: async () => { closing = true; await Promise.all([...tasks.values()].map(task => task.done)); } };
}
