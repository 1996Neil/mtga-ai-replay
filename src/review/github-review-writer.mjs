import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { coachSyncRunner, verifySyncRemote } from '../coach-sync.mjs';
import { validateStagedRepository, validateSyncHistoryApproval } from '../sync-security.mjs';
import { readPublishedReviewSource } from './cloud-review.mjs';
import { parseCloudReview, reviewPath, reviewReject, MAX_REVIEW_BYTES } from './cloud-review-contract.mjs';
import { prepareCloudReviewWrite } from './cloud-review-writer.mjs';

const OID = /^[a-f0-9]{40}$/;
const IDENTITY = { name: 'mtga-cloud-review', email: 'mtga-cloud-review@users.noreply.github.com' };
const casMutation = `mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const blobOid = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');

// Existing gh desktop authentication is used only in this trusted server/tool
// boundary. No token, URL, shell fragment or arbitrary API operation is accepted
// from a report or from the browser. No automatic retry after an ambiguous write.
async function githubRequest({ method, endpoint, body }) {
  return new Promise((resolve, reject) => {
    const args = ['api', '--hostname', 'github.com', '--method', method, endpoint];
    if (body !== undefined) args.push('--input', '-');
    const child = execFile('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(Error('GitHub request unconfirmed'));
      try { const result = JSON.parse(stdout); if (result.errors?.length) throw Error(); resolve(result); }
      catch { reject(Error('GitHub response unconfirmed')); }
    });
    child.stdin.on('error', () => reject(Error('GitHub request unconfirmed')));
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Explicit single-game capability. Construct only after human admission of the
 * exact repository numeric/node ID, branch, match and game. This is not an HTTP
 * route and does not infer authorization from a report's contents. */
export function createGitHubReviewWriter({ repository, repositoryId, nodeId, branch, matchId, gameNumber,
  historyApproval, request = githubRequest, runCommand } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository ?? '') ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1 || typeof nodeId !== 'string' || !/^[A-Za-z0-9_=-]{4,200}$/.test(nodeId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/.test(branch ?? '') || branch.includes('..') || branch.endsWith('/') || branch.includes('//') || branch.endsWith('.lock')) reviewReject('github-admission');
  const path = reviewPath(matchId, gameNumber), base = `repos/${repository}`, run = coachSyncRunner({ runCommand });
  const approval = validateSyncHistoryApproval(historyApproval, { repository, branch });
  let writing = false;
  async function api(method, endpoint, body) {
    try { return await request({ method, endpoint, ...(body === undefined ? {} : { body }) }); }
    catch { reviewReject('github-request-unconfirmed'); }
  }
  async function privateTarget() {
    const meta = await api('GET', base);
    if (meta.full_name !== repository || meta.id !== repositoryId || meta.node_id !== nodeId || meta.private !== true ||
        meta.visibility !== 'private' || meta.archived || meta.disabled || meta.default_branch !== branch) reviewReject('github-target');
    return meta;
  }
  function admitted(input) {
    if (input?.repository !== repository || input.branch !== branch || input.path !== path) reviewReject('github-scope');
  }
  async function snapshot(callback) {
    await privateTarget();
    const root = await mkdtemp(join(tmpdir(), 'mtga-review-writer-'));
    const git = (args, settings = {}) => run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, ...settings, env: {
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: join(root, '.git'), GIT_WORK_TREE: root, GIT_INDEX_FILE: join(root, '.git/index') } });
    try {
      await git(['init', '-b', 'review-writer-verifier']);
      await git(['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
      await verifySyncRemote(git, repository);
      await git(['fetch', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
      await validateStagedRepository(root, { repository, branch, historyApproval: approval });
      const headOid = String(await git(['rev-parse', `refs/remotes/origin/${branch}`])).trim();
      if (!OID.test(headOid)) reviewReject('github-head');
      const tree = async revision => new Map(String(await git(['ls-tree', '-rz', revision])).split('\0').filter(Boolean).map(row => {
        const [meta, name] = row.split('\t'); return [name, meta];
      }));
      const entries = await tree(headOid);
      const read = async (name, max = 2 * 1024 * 1024, from = entries) => {
        const meta = from.get(name); if (!meta?.startsWith('100644 blob ')) reviewReject('github-file-mode');
        const oid = meta.split(' ')[2], size = Number(String(await git(['cat-file', '-s', oid])));
        if (!Number.isSafeInteger(size) || size < 0 || size > max) reviewReject('github-file-size');
        return git(['cat-file', 'blob', oid], { encoding: 'buffer' });
      };
      await privateTarget();
      return await callback({ root, git, headOid, tree, entries, read });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  async function readTarget(input) {
    admitted(input);
    return snapshot(async ({ headOid, entries, read }) => ({ repository, visibility: 'PRIVATE', headOid,
      blobOid: entries.has(path) ? entries.get(path).split(' ')[2] : null,
      contents: entries.has(path) ? new TextDecoder('utf-8', { fatal: true }).decode(await read(path, MAX_REVIEW_BYTES)) : undefined }));
  }
  async function compareAndSwapReview(plan) {
    admitted(plan);
    if (writing) reviewReject('github-busy');
    writing = true;
    try { return await snapshot(async ({ root, git, headOid, entries, read, tree }) => {
      if (headOid !== plan.expectedHeadOid || (entries.get(path)?.split(' ')[2] ?? null) !== plan.expectedBlobOid) reviewReject('write-conflict');
      if (typeof plan.contents !== 'string' || Buffer.byteLength(plan.contents) > MAX_REVIEW_BYTES) reviewReject('github-plan');
      const report = parseCloudReview(plan.contents, { path });
      const files = new Map([['index.json', await read('index.json')]]);
      let index; try { index = JSON.parse(files.get('index.json')); } catch { reviewReject('source-index'); }
      const matches = index.matches?.filter(item => item.match_id === matchId);
      if (matches?.length !== 1 || !/^matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(matches[0].path ?? '')) reviewReject('source-index');
      const prefix = matches[0].path, manifestPath = `${prefix}/manifest.json`;
      files.set(manifestPath, await read(manifestPath));
      let manifest; try { manifest = JSON.parse(files.get(manifestPath)); } catch { reviewReject('source-manifest'); }
      const names = Object.keys(manifest.files ?? {}); if (names.length > 515) reviewReject('source-manifest');
      for (const name of names) {
        const file = ['summary.json', 'coach.json', 'cards.json'].includes(name) ? `${prefix}/${name}` : name;
        if (!file.startsWith(`${prefix}/`) || !/^(?:matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/(?:summary|coach|cards)\.json|matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/parts\/part-[0-9]{4,6}\.json)$/.test(file)) reviewReject('source-part-path');
        files.set(file, await read(file));
      }
      const source = readPublishedReviewSource({ files, matchId, revision: headOid });
      const expected = prepareCloudReviewWrite({ repository, branch, expectedHeadOid: headOid, expectedBlobOid: plan.expectedBlobOid, report, source });
      if (Object.keys(plan).length !== Object.keys(expected).length || Object.keys(expected).some(key =>
        key === 'identity' ? plan.identity?.name !== IDENTITY.name || plan.identity?.email !== IDENTITY.email : plan[key] !== expected[key])) reviewReject('github-plan');
      const oldCommit = await api('GET', `${base}/git/commits/${headOid}`);
      if (oldCommit.sha !== headOid || !OID.test(oldCommit.tree?.sha ?? '')) reviewReject('github-parent');
      const blob = await api('POST', `${base}/git/blobs`, { content: plan.contents, encoding: 'utf-8' });
      if (blob.sha !== blobOid(plan.contents)) reviewReject('github-blob');
      const newTree = await api('POST', `${base}/git/trees`, { base_tree: oldCommit.tree.sha,
        tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] });
      if (!OID.test(newTree.sha ?? '')) reviewReject('github-tree');
      const identity = { ...IDENTITY, date: new Date().toISOString() };
      const commit = await api('POST', `${base}/git/commits`, { message: plan.message, tree: newTree.sha,
        parents: [headOid], author: identity, committer: identity });
      if (!OID.test(commit.sha ?? '') || commit.sha === headOid) reviewReject('github-commit');
      const verifyCommit = async () => {
        const value = await api('GET', `${base}/git/commits/${commit.sha}`);
        if (value.sha !== commit.sha || value.tree?.sha !== newTree.sha || value.parents?.length !== 1 || value.parents[0].sha !== headOid ||
            value.message !== plan.message || ['author', 'committer'].some(field => value[field]?.name !== IDENTITY.name || value[field]?.email !== IDENTITY.email)) reviewReject('github-commit-receipt');
      };
      await verifyCommit();
      // The candidate is reachable only in the temporary verifier. Scan its raw
      // commit, tree and blobs along with ALL fetched branches before publication.
      await git(['fetch', '--no-tags', 'origin', `${commit.sha}:refs/review-candidate/verified`]);
      const rawCommit = String(await git(['cat-file', 'commit', commit.sha]));
      const headers = rawCommit.slice(0, rawCommit.indexOf('\n\n')).split('\n');
      if (rawCommit.indexOf('\n\n') < 0 || ['author', 'committer'].some(field => {
        const rows = headers.filter(row => row.startsWith(`${field} `));
        return rows.length !== 1 || !rows[0].startsWith(`${field} ${IDENTITY.name} <${IDENTITY.email}> `);
      }) || headers.filter(row => row.startsWith('parent ')).join('\n') !== `parent ${headOid}` ||
        headers.filter(row => row.startsWith('tree ')).join('\n') !== `tree ${newTree.sha}`) reviewReject('github-raw-commit');
      const next = await tree(commit.sha), changed = [...new Set([...entries.keys(), ...next.keys()])].filter(name => entries.get(name) !== next.get(name));
      if (changed.length !== 1 || changed[0] !== path || next.get(path) !== `100644 blob ${blob.sha}` ||
          digest(await read(path, MAX_REVIEW_BYTES, next)) !== plan.review_hash) reviewReject('github-tree-scope');
      await validateStagedRepository(root, { repository, branch, historyApproval: approval });
      await privateTarget();
      await api('POST', 'graphql', { query: casMutation, variables: { input: { repositoryId: nodeId,
        refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: headOid, afterOid: commit.sha, force: false }] } } });
      await verifyCommit();
      const receipt = await readTarget({ repository, branch, path });
      if (receipt.headOid !== commit.sha || receipt.blobOid !== blob.sha || digest(receipt.contents ?? '') !== plan.review_hash) reviewReject('write-unconfirmed');
      return { commitOid: commit.sha };
    }); } finally { writing = false; }
  }
  return Object.freeze({ readTarget, compareAndSwapReview });
}
