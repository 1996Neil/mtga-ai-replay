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
import { buildCoachBundle, serializeCoachJson } from '../src/coach-bundle.mjs';
import { archiveReplays, listReplays, getReplay } from '../src/history.mjs';
import { saveDraftRunIndex } from '../src/draft-runs.mjs';
import { readPublishedDraftLinks } from '../src/draft-publication.mjs';
import { listCapturedDraftRuns } from '../src/draft-capture.mjs';
import { attachDraftBindings } from '../src/draft-backup.mjs';
import { draftBindingInputKey, buildPublishedDraftLinks } from '../src/draft-publication.mjs';
import { createDraftBackup } from '../src/draft-backup.mjs';
import { syncDigest } from '../src/sync-cache.mjs';
import { draftOwnershipPath, readDraftOwnershipCorrections, planDraftOwnershipCorrections } from '../src/draft-ownership.mjs';
const execute = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const repository = 'synthetic-owner/private-drafts', remote = `https://github.com/${repository}.git`;
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const item = (n, account_key = A) => ({ observation_id: n.toString(16).padStart(64, '0'), adapter: '17lands-log-v2',
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
  db.exec(`CREATE TABLE observations(seq INTEGER PRIMARY KEY,observation_id TEXT UNIQUE,body TEXT); CREATE TABLE gaps(gap_id TEXT PRIMARY KEY,reason TEXT); CREATE TABLE accounts(account_key TEXT PRIMARY KEY,label TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO meta VALUES ('observation_revision','0');
    CREATE TRIGGER changed_insert AFTER INSERT ON observations BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='observation_revision'; END;
    CREATE TRIGGER changed_update AFTER UPDATE ON observations BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='observation_revision'; END;`);
  db.close();
  const append = observations => {
    const db = new DatabaseSync(join(dataDir, 'draft-capture.sqlite3'));
    try { for (const o of observations) { const { observation_id, ...body } = o; db.prepare('INSERT INTO observations(observation_id,body) VALUES (?,?)').run(observation_id, JSON.stringify(body)); } }
    finally { db.close(); }
  };
  const control = { offline: false, pushLost: false, public: false, mismatchIdentity: false, afterPush: null, commands: [] };
  const runCommand = async (file, args, { cwd, encoding = 'utf8', env: commandEnv = {}, input } = {}) => {
    control.commands.push([file, ...args]);
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

async function linkedFixture(h, { multipart = false, owner = A } = {}) {
  const pool = [], observations = []; let sequence = 0;
  for (const pack of [1, 2, 3]) {
    const cards = Array.from({ length: 14 }, (_, i) => pack * 100 + i);
    for (let i = 0; i < cards.length; i++) {
      for (const kind of ['pack', 'pick']) observations.push({ ...item(++sequence), kind, account_key: A,
        pack_number: pack, pick_number: i + 1, card_ids: kind === 'pack' ? cards.slice(i) : [cards[i]] });
      pool.push(cards[i]);
    }
  }
  h.append(observations);
  const replay = { match: { id: 'draft-match', account_key: owner, event_id: 'QuickDraft_SYNTHETIC', event: 'QuickDraft_SYNTHETIC',
    result: 'Win', started_at: new Date().toISOString() }, games: [{ game_number: 1, states: {}, steps: [], turns: [] }],
    deck: [...pool.slice(0, 23).map(arena_id => ({ arena_id, name: `Synthetic ${arena_id}`, quantity: 1 })),
      { arena_id: 9999, name: 'Forest', quantity: 17 }] };
  await archiveReplays([replay], { dataDir: h.dataDir });
  await saveDraftRunIndex([{ run_id: 'c'.repeat(32), event_id: 'QuickDraft_SYNTHETIC', event: 'QuickDraft_SYNTHETIC',
    started_at: replay.match.started_at, current_module: 'Complete', course_wins: 1, course_losses: 0,
    replay_wins: 1, replay_losses: 0, score_verified: true, status: 'completed', colors: [], colors_complete: false,
    card_pool: pool.map(arena_id => ({ arena_id, name: `Synthetic ${arena_id}` })),
    matches: [{ id: replay.match.id, started_at: replay.match.started_at, result: 'Win', game_count: 1 }],
  }], { dataDir: h.dataDir });
  const bundle = await buildCoachBundle(replay, { cards: [], multipart }), path = `matches/${bundle.historyKey}`;
  const publishMatch = async () => {
    const seed = join(h.root, 'seed');
    await execute('git', ['pull', h.bare, 'main', '--ff-only'], { cwd: seed, env });
    await mkdir(join(seed, path), { recursive: true });
    for (const name of ['summary', 'coach', 'cards', 'manifest']) await writeFile(join(seed, path, name + '.json'), serializeCoachJson(bundle[name]));
    for (const [partPath, value] of bundle.parts ?? []) {
      await mkdir(join(seed, partPath, '..'), { recursive: true }); await writeFile(join(seed, partPath), serializeCoachJson(value));
    }
    await writeFile(join(seed, 'index.json'), serializeCoachJson({ schema: 'MTGA_COACH_INDEX_V1', matches: [{
      match_id: replay.match.id, path, content_hash: bundle.contentHash, history_key: bundle.historyKey,
    }] }));
    await execute('git', ['add', '.'], { cwd: seed, env });
    await execute('git', ['-c', 'user.name=mtga-replay-coach', '-c', 'user.email=mtga-replay-coach@users.noreply.github.com',
      'commit', '-m', 'Publish synthetic draft match'], { cwd: seed, env });
    await execute('git', ['push', h.bare, 'HEAD:main'], { cwd: seed, env });
    const local = (await listReplays({ dataDir: h.dataDir }))[0];
    await writeFile(join(h.dataDir, 'replay-remote-receipts.json'), JSON.stringify({ [replay.match.id]: {
      local_revision: local.replay_revision, content_hash: bundle.contentHash } }));
  };
  return { publishMatch, replay, path, bundle };
}

test('explicit verified ownership correction preserves immutable capture lineage and restores under the match account', async t => {
  const h = await harness(t), fixture = await linkedFixture(h, { owner: B });
  await fixture.publishMatch();
  await syncDraftCapture(h.options);
  const source = await listCapturedDraftRuns({ dataDir: h.dataDir });
  const history = await listReplays({ dataDir: h.dataDir, limit: null });
  const original = await readPublishedDraftLinks(source, { dataDir: h.dataDir, history });
  assert.equal(original[0].binding_account_status, 'conflict');
  const before = await createDraftBackup({ dataDir: h.dataDir });
  const saved = JSON.parse(await readFile(join(h.dataDir, 'draft-sync/published-bindings.json'), 'utf8'));
  const previous = await readDraftOwnershipCorrections(h.dataDir);
  const correction = planDraftOwnershipCorrections(original, saved.documents, [original[0].run_id], previous);
  await writeFile(join(h.dataDir, draftOwnershipPath), serializeDraft(correction));
  // A queued repair alone cannot reclassify anything before verified publication.
  assert.equal((await readPublishedDraftLinks(source, { dataDir: h.dataDir, history }))[0].account_key, A);
  const published = await syncDraftCapture(h.options);
  assert.equal(published.verified, true);
  assert.deepEqual((await createDraftBackup({ dataDir: h.dataDir })).files, before.files);
  const restored = await readPublishedDraftLinks(source, { dataDir: h.dataDir, history });
  assert.equal(restored[0].account_key, B);
  assert.equal(restored[0].capture_account_key, A);
  assert.equal(restored[0].binding_account_status, 'matched');
  assert.equal(restored[0].ownership_corrected, true);
  const remote = await h.remoteIndex();
  const text = (await execute('git', ['--git-dir', h.bare, 'show', `HEAD:${remote.accounts[0].bindings.path}`], { env })).stdout;
  const doc = parseDraftBackup(remote.accounts[0].bindings.path, text);
  assert.equal(doc.runs[0].ownership.account_key, B);
  // Restore depends on published evidence, not a machine-local ledger.
  await rm(join(h.dataDir, draftOwnershipPath));
  assert.equal((await readPublishedDraftLinks(source, { dataDir: h.dataDir, history }))[0].account_key, B);
  const retry = await syncDraftCapture(h.options);
  assert.equal(retry.revision, published.revision, 'restoring without a local ledger must not undo a published correction');
  const malformed = structuredClone(doc);
  malformed.runs[0].ownership.account_key = 'c'.repeat(64);
  assert.throws(() => parseDraftBackup(remote.accounts[0].bindings.path, serializeDraft(malformed)));
  // Missing current match evidence cannot retain the corrected owner.
  const pending = await readPublishedDraftLinks(source, { dataDir: h.dataDir, history: [] });
  assert.equal(pending[0].binding, 'unresolved');
  assert.equal(pending[0].account_key, A);
});

test('upload includes pending associations, completes after match upload without new picks, reads back and restores without course DB', async t => {
  const h = await harness(t), fixture = await linkedFixture(h);
  const first = await syncDraftCapture(h.options);
  assert.equal(first.pending_runs, 1); assert.equal(first.linked_runs, 0);
  const firstDoc = JSON.parse((await execute('git', ['--git-dir', h.bare, 'show', `HEAD:drafts/accounts/${A}/bindings.json`], { env })).stdout);
  assert.equal(firstDoc.runs[0].status, 'pending'); assert.equal(firstDoc.runs[0].reason, 'awaiting_match_upload');
  await fixture.publishMatch();
  const linked = await syncDraftCapture(h.options);
  assert.equal(linked.observations, first.observations); assert.equal(linked.linked_runs, 1); assert.equal(linked.pending_runs, 0);
  const root = await h.remoteIndex();
  assert.equal(root.schema, 'MTGA_DRAFT_ACCOUNTS_V2');
  const text = (await execute('git', ['--git-dir', h.bare, 'show', `HEAD:${root.accounts[0].bindings.path}`], { env })).stdout;
  assert.equal(draftDigest(text), root.accounts[0].bindings.sha256);
  const doc = parseDraftBackup(root.accounts[0].bindings.path, text);
  assert.equal(doc.runs[0].matches[0].content_hash, fixture.bundle.contentHash);
  assert.equal(doc.runs[0].matches[0].nonbasic_deck.length, 23);
  const again = await syncDraftCapture(h.options);
  assert.equal(again.revision, linked.revision, 'unchanged remote link commit is a no-op');
  assert.equal(again.work.proofs_checked, 0); assert.equal(again.work.proofs_reused, 1);
  assert.equal(again.work.local_decks_read, 0, 'unchanged match must not extract a deck from its replay JSON');
  assert.equal(again.work.canonical_builds, 0); assert.equal(again.work.readback_files, 1);
  await rm(join(h.dataDir, 'draft-runs.sqlite3'));
  const source = await listCapturedDraftRuns({ dataDir: h.dataDir });
  const restored = await readPublishedDraftLinks(source, { dataDir: h.dataDir, history: await listReplays({ dataDir: h.dataDir, limit: null }) });
  assert.equal(restored[0].binding, 'matched_pool'); assert.equal(restored[0].matches[0].id, fixture.replay.match.id);
  const saved = JSON.parse(await readFile(join(h.dataDir, 'draft-sync/published-bindings.json'), 'utf8'));
  saved.documents[A].runs[0].matches[0].result = 'Loss';
  await writeFile(join(h.dataDir, 'draft-sync/published-bindings.json'), serializeDraft(saved));
  await assert.rejects(readPublishedDraftLinks(source, { dataDir: h.dataDir, history: await listReplays({ dataDir: h.dataDir, limit: null }) }));
});

test('mismatched local/remote content stays pending despite a receipt claiming equality; corrupt evidence refuses publication', async t => {
  const h = await harness(t), fixture = await linkedFixture(h);
  await fixture.publishMatch();
  const revision = (await listReplays({ dataDir: h.dataDir }))[0].replay_revision;
  const changed = await getReplay(fixture.replay.match.id, { dataDir: h.dataDir });
  changed.match.player = 'Synthetic locally changed player';
  await archiveReplays([changed], { dataDir: h.dataDir, replaceRevision: revision });
  const newRevision = (await listReplays({ dataDir: h.dataDir }))[0].replay_revision;
  await writeFile(join(h.dataDir, 'replay-remote-receipts.json'), JSON.stringify({ [fixture.replay.match.id]: {
    local_revision: newRevision, content_hash: fixture.bundle.contentHash } }));
  const pending = await syncDraftCapture(h.options);
  assert.equal(pending.linked_runs, 0); assert.equal(pending.pending_runs, 1);
  // Modify coach bytes without its hashed manifest in the remote fixture.
  const seed = join(h.root, 'seed');
  await execute('git', ['pull', h.bare, 'main', '--ff-only'], { cwd: seed, env });
  const coachPath = join(seed, fixture.path, 'coach.json');
  await writeFile(coachPath, (await readFile(coachPath, 'utf8')).replace('"result": "Win"', '"result": "Loss"'));
  await execute('git', ['add', '.'], { cwd: seed, env });
  await execute('git', ['-c', 'user.name=mtga-replay-coach', '-c', 'user.email=mtga-replay-coach@users.noreply.github.com',
    'commit', '-m', 'Synthetic corrupt remote object'], { cwd: seed, env });
  await execute('git', ['push', h.bare, 'HEAD:main'], { cwd: seed, env });
  await assert.rejects(syncDraftCapture(h.options), /evidence/);
  assert.equal(JSON.parse(await readFile(join(h.dataDir, 'draft-sync/published.json'), 'utf8')).revision, pending.revision);
});

test('binding source hashes cannot be forged or silently omit a capture', () => {
  const snapshot = buildDraftBackup({ observations: [item(1), item(2)], gaps: 0 });
  const doc = { schema: 'MTGA_DRAFT_BINDINGS_V1', account_key: A, runs: [] };
  assert.throws(() => attachDraftBindings(snapshot, new Map([[A, doc]])), /association/);
});

test('small multipart uploads verify and each stale generation-cache component independently falls back', async t => {
  const h = await harness(t), fixture = await linkedFixture(h, { multipart: true });
  await fixture.publishMatch();
  const cwd = join(h.root, 'seed'), git = async (args, encoding = 'utf8') =>
    (await execute('git', args, { cwd, encoding, env, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const revision = String(await git(['rev-parse', 'HEAD'])).trim(), snapshot = await createDraftBackup({ dataDir: h.dataDir });
  const first = await buildPublishedDraftLinks(snapshot, { dataDir: h.dataDir, git, revision });
  assert.equal(first.get(A).runs[0].status, 'linked', 'forced multipart must not be compared using auto partitioning');
  const previous = (await listReplays({ dataDir: h.dataDir }))[0].replay_revision;
  const replay = await getReplay(fixture.replay.match.id, { dataDir: h.dataDir });
  replay.match.player = 'Synthetic changed local';
  await archiveReplays([replay], { dataDir: h.dataDir, replaceRevision: previous });
  const current = await getReplay(fixture.replay.match.id, { dataDir: h.dataDir });
  const generated = { fast_snapshot: syncDigest(current), content_hash: fixture.bundle.contentHash, history_key: fixture.bundle.historyKey };
  for (const [field, replacement] of [['fast_snapshot', '0'.repeat(64)], ['content_hash', '0'.repeat(64)], ['history_key', 'wrong-history']]) {
    await writeFile(join(h.dataDir, 'replay-coach-generation-cache.json'), JSON.stringify({
      schema: 'MTGA_SYNC_CACHE_V1', matches: { [fixture.replay.match.id]: { ...generated, [field]: replacement } },
    }));
    const result = await buildPublishedDraftLinks(snapshot, { dataDir: h.dataDir, git, revision });
    assert.equal(result.get(A).runs[0].status, 'pending', `${field} mismatch must not accept a cached source→output mapping`);
  }
});

test('a binding input arriving during push is not acknowledged as part of the earlier snapshot', async t => {
  const h = await harness(t); h.append([item(1)]);
  const before = await draftBindingInputKey(h.dataDir);
  h.control.afterPush = async () => {
    const db = new DatabaseSync(join(h.dataDir, 'replay-ingest.sqlite3'));
    db.exec('CREATE TABLE records(sequence INTEGER PRIMARY KEY, match_id TEXT, json TEXT);'); db.close();
  };
  const first = await syncDraftCapture(h.options);
  assert.equal(first.input_key, before); assert.equal(first.input_changed, true);
  assert.notEqual(first.input_key, await draftBindingInputKey(h.dataDir));
  h.control.afterPush = null;
  const second = await syncDraftCapture(h.options);
  assert.equal(second.input_changed, false); assert.equal(second.revision, first.revision);
});

test('real temporary Git remote: per-account upload, verified readback, repeat no-op and append', async t => {
  const h = await harness(t); h.append([item(1), item(2, B), item(3, null)]);
  const result = await syncDraftCapture(h.options);
  assert.equal(result.verified, true); assert.equal(result.observations, 2);
  assert.equal((await h.remoteIndex()).accounts.length, 2);
  const again = await syncDraftCapture(h.options);
  assert.equal(again.revision, result.revision);
  assert.equal(again.work.observation_rows, 0);
  const commands = h.control.commands.length;
  h.control.offline = true;
  const idle = await syncDraftCapture({ ...h.options, automatic: true });
  assert.equal(idle.cached, true); assert.equal(idle.remote_checked, false);
  assert.equal(h.control.commands.length, commands, 'idle automatic sync must start no command or network');
  assert.equal(idle.work.observation_rows, 0);
  h.control.offline = false;
  await rm(join(h.dataDir, 'draft-sync/published-bindings.json'));
  const repaired = await syncDraftCapture({ ...h.options, automatic: true });
  assert.notEqual(repaired.cached, true, 'missing final artifact must not be hidden by a successful earlier receipt');
  assert.ok((await readFile(join(h.dataDir, 'draft-sync/published-bindings.json'), 'utf8')).includes('MTGA_PUBLISHED_DRAFT_BINDINGS_V1'));
  h.append([item(4)]);
  const next = await syncDraftCapture(h.options);
  assert.equal(next.observations, 3); assert.notEqual(next.revision, result.revision);
  assert.equal(next.work.observation_rows, 1);
  assert.ok(next.work.lineage_blob_reads <= 2);
  assert.ok(next.work.staged_files <= 4);
  assert.ok(next.work.readback_files <= 4);
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
