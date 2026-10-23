import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildDraftBackup, parseDraftBackup, validateDraftBackup, draftDigest, serializeDraft } from '../src/draft-backup.mjs';
import { validateBundleFiles, validateStagedRepository } from '../src/sync-security.mjs';
import { syncDraftCapture } from '../src/draft-sync.mjs';
const execute = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const repository = 'synthetic-owner/private-drafts', remote = `https://github.com/${repository}.git`;
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const item = (n, account_key = A) => ({ observation_id: n.toString(16).padStart(64, '0'), adapter: '17lands-bot-log-v1',
  kind: n % 2 ? 'pack' : 'pick', event_id: 'QuickDraft_SYNTHETIC', pack_number: 1, pick_number: 1,
  card_ids: [10], logged_at: '2026-10-24T01:02:03.123+08:00', account_key });

test('backup isolates accounts, excludes unknown owners and rejects cross-account paths/duplicate keys', () => {
  const snapshot = buildDraftBackup({ observations: [item(1), item(2, B), item(3, null)], gaps: 0 });
  assert.equal(snapshot.index.accounts.length, 2); assert.equal(snapshot.observations, 2);
  validateDraftBackup(snapshot); validateBundleFiles(snapshot.files);
  const [path, text] = [...snapshot.files].find(([p]) => p.includes('/objects/'));
  assert.throws(() => parseDraftBackup(path.replace(A, B), text));
  assert.throws(() => parseDraftBackup(path, text.replace('"schema":', '"account_key":"discarded","schema":')));
  const changed = text.replace('"card_ids":', '"raw_log":"synthetic","card_ids":');
  assert.throws(() => parseDraftBackup(path.replace(draftDigest(text), draftDigest(changed)), changed));
});

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'draft-git-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'local'), bare = join(root, 'remote.git'), seed = join(root, 'seed');
  await execute('git', ['init', '--bare', '-b', 'main', bare], { env });
  await execute('git', ['init', '-b', 'main', seed], { env });
  await writeFile(join(seed, 'README.md'), '# Synthetic private data\n');
  await execute('git', ['add', 'README.md'], { cwd: seed, env });
  await execute('git', ['-c', 'user.name=mtga-replay-coach', '-c', 'user.email=mtga-replay-coach@users.noreply.github.com', 'commit', '-m', 'Seed'], { cwd: seed, env });
  await execute('git', ['push', bare, 'HEAD:main'], { cwd: seed, env });
  await mkdir(join(dataDir, 'coach-sync'), { recursive: true });
  await writeFile(join(dataDir, 'coach-sync/state.json'), JSON.stringify({ schema: 'MTGA_LOCAL_SYNC_V1', enabled: true,
    repository, pending: [], synced: {}, last_synced: null }));
  const db = new DatabaseSync(join(dataDir, 'draft-capture.sqlite3'));
  db.exec('CREATE TABLE observations(seq INTEGER PRIMARY KEY,observation_id TEXT UNIQUE,body TEXT); CREATE TABLE gaps(gap_id TEXT PRIMARY KEY,reason TEXT); CREATE TABLE accounts(account_key TEXT PRIMARY KEY,label TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);');
  db.close();
  const append = observations => {
    const db = new DatabaseSync(join(dataDir, 'draft-capture.sqlite3'));
    try { for (const o of observations) { const { observation_id, ...body } = o; db.prepare('INSERT INTO observations(observation_id,body) VALUES (?,?)').run(observation_id, JSON.stringify(body)); } }
    finally { db.close(); }
  };
  const control = { offline: false, pushLost: false, public: false, mismatchIdentity: false, afterPush: null };
  const runCommand = async (file, args, { cwd, encoding = 'utf8', env: commandEnv = {}, input } = {}) => {
    if (file === 'gh') {
      if (args[0] === 'api') return JSON.stringify({ id: control.mismatchIdentity ? 2 : 1, node_id: 'SYNTHETIC_NODE', private: !control.public, full_name: repository, default_branch: 'main' });
      return JSON.stringify({ nameWithOwner: repository, visibility: control.public ? 'PUBLIC' : 'PRIVATE', url: `https://github.com/${repository}`, defaultBranchRef: { name: 'main' } });
    }
    assert.equal(file, 'git');
    const network = args.find(a => ['fetch', 'push', 'ls-remote'].includes(a));
    if (network && control.offline) throw new Error('synthetic offline');
    const routed = network ? ['-c', `url.${bare}.insteadOf=${remote}`, ...args] : args;
    const pending = execute(file, routed, { cwd, encoding, env: { ...env, ...commandEnv }, maxBuffer: 32 * 1024 * 1024 });
    pending.child.stdin.end(input);
    const result = await pending;
    if (network === 'push' && control.afterPush) await control.afterPush();
    if (network === 'push' && control.pushLost) { control.pushLost = false; throw new Error('synthetic lost response after successful push'); }
    return result;
  };
  const options = { dataDir, runCommand };
  const remoteIndex = async () => JSON.parse((await execute('git', ['--git-dir', bare, 'show', 'HEAD:drafts/index.json'], { env })).stdout);
  return { root, dataDir, bare, append, control, options, remoteIndex };
}

test('real temporary Git remote: per-account upload, verified readback, repeat no-op and append', async t => {
  const h = await harness(t); h.append([item(1), item(2, B), item(3, null)]);
  const result = await syncDraftCapture(h.options);
  assert.equal(result.verified, true); assert.equal(result.observations, 2);
  assert.equal((await h.remoteIndex()).accounts.length, 2);
  const again = await syncDraftCapture(h.options);
  assert.equal(again.revision, result.revision);
  h.append([item(4)]);
  const next = await syncDraftCapture(h.options);
  assert.equal(next.observations, 3); assert.notEqual(next.revision, result.revision);
  const receipt = JSON.parse(await readFile(join(h.dataDir, 'draft-sync/receipt.json'), 'utf8'));
  assert.equal(receipt.revision, next.revision);
  await validateStagedRepository(join(h.dataDir, 'coach-sync/repository'));
});

test('offline failure keeps local observations; successful push with lost response verifies on retry', async t => {
  const h = await harness(t); h.append([item(1)]); h.control.offline = true;
  await assert.rejects(syncDraftCapture(h.options));
  h.control.offline = false; h.control.pushLost = true;
  await assert.rejects(syncDraftCapture(h.options));
  assert.equal((await h.remoteIndex()).accounts[0].observations, 1);
  assert.equal((await syncDraftCapture(h.options)).verified, true);
});

test('public destination and conflicting lineage refuse publication', async t => {
  const h = await harness(t); h.append([item(1)]); h.control.public = true;
  await assert.rejects(syncDraftCapture(h.options));
  h.control.public = false; await syncDraftCapture(h.options);
  // Replace the local source with a different valid fact at the same observation ID.
  const fixed = new DatabaseSync(join(h.dataDir, 'draft-capture.sqlite3'));
  const { observation_id, ...body } = { ...item(1), card_ids: [11] };
  fixed.prepare('UPDATE observations SET body=?').run(JSON.stringify(body)); fixed.close();
  await assert.rejects(syncDraftCapture(h.options), /lineage/);
});
