import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildCoachBundle, serializeCoachJson, resolveCoachBundle } from '../src/coach-bundle.mjs';
import { configureCoachSync, enqueueCoachBundle, syncCoachBundles, getCoachSyncStatus, getCoachHistoryKey, getPublishedCoachIndex, approveCoachSyncHistory } from '../src/coach-sync.mjs';
import { syncCoachCatalog, printCatalogSync } from '../src/coach-catalog-sync.mjs';
import { archiveReplays, listReplays } from '../src/history.mjs';
import { validateBundleFiles, validateStagedRepository } from '../src/sync-security.mjs';
import { syncReplayHistory } from '../src/replay-workflow.mjs';
import { startReplayServer } from '../src/server.mjs';
import { syntheticLog } from './helpers/synthetic-log.mjs';

const execute = promisify(execFile);
const REPOSITORY = 'fixture-owner/private-coaching';
const REMOTE_URL = `https://github.com/${REPOSITORY}.git`;
const FILES = ['summary.json', 'coach.json', 'cards.json', 'manifest.json'];
const digest = content => createHash('sha256').update(content).digest('hex');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

async function bundle({ id = 'synthetic-match-one', started = '2026-10-01T12:00:00.000Z', richer = false, generated = '2026-10-02T00:00:00.000Z', coachOptions = {} } = {}) {
  const forest = { arena_id: 1, name: 'Forest', instance_id: 101, logical_id: 'C1', visibility: 'public', card_types: ['Land'], counters: [] };
  const player = (name, battlefield = []) => ({ name, life: 20, hand: [], handSize: 0, librarySize: 39, battlefield, graveyard: [], exile: [] });
  const state = number => ({ gameStateId: number, turn: number, phase: 'Phase_Main1', step: 'Step_Main', activePlayer: 'me', priorityPlayer: 'me', players: { me: player('Synthetic Me', [forest]), opponent: player('Synthetic Opponent') }, stack: [], warnings: [] });
  const states = { S1: state(1) };
  const steps = [{ anchor: 'T1-A1', turn: 1, action: 1, state_id: 'S1', event: { type: 'land', actor: 'me', card: forest } }];
  if (richer) {
    states.S2 = state(2);
    steps.push({ anchor: 'T2-A1', turn: 2, action: 1, before_state_id: 'S1', state_id: 'S2', event: { type: 'life', actor: 'me', life: { me: 19, opponent: 20 } } });
  }
  return buildCoachBundle({ schema_version: '1.0', match: { id, started_at: started, event: 'Jump In', is_jump_in: true, result: 'Win', player: 'Synthetic Me', opponent: 'Synthetic Opponent', on_play: true },
    deck: [{ arena_id: 1, name: 'Forest', quantity: 40 }], perspective: { hidden_information: 'omitted' }, warnings: [],
    games: [{ game_number: 1, starting_hand: [], states, steps, turns: [], result: { outcome: 'Win', reason: 'concede', life: { me: 19, opponent: 20 } }, warnings: [] }] },
  { cards: [{ arena_id: 1, name: 'Forest', display_name_zh: '树林', mana_cost: '', type_line: 'Basic Land — Forest', oracle_text: '{T}: Add {G}.', keywords: [], power: null, toughness: null, metadata_complete: true, source: 'scryfall' }], generatedAt: generated, ...coachOptions });
}

function rehashMultipart(value) {
  const contents = new Map(FILES.filter(name => name !== 'manifest.json').map(name => [name, serializeCoachJson(value[name.slice(0, -5)])]));
  for (const [path, part] of value.parts ?? []) contents.set(path, typeof part === 'string' ? part : serializeCoachJson(part));
  value.manifest.files = Object.fromEntries([...contents].map(([path, text]) => [path, { sha256: digest(text), bytes: Buffer.byteLength(text) }]));
  value.manifest.coach_sha256 = value.manifest.files['coach.json'].sha256;
  value.manifest.cards_sha256 = value.manifest.files['cards.json'].sha256;
  value.contentHash = digest(serializeCoachJson(value.manifest.files)); value.manifest.content_hash = value.contentHash;
  return value;
}
async function multipartBundle(options = {}) {
  const value = await bundle(options), prefix = `matches/${value.historyKey}/parts`;
  // Transport fixtures deliberately cover object and pre-serialized values.
  // The codec's lossless reconstruction is tested in coach-bundle.test.mjs.
  value.parts = new Map([
    [`${prefix}/part-0001.json`, { schema: 'MTGA_COACH_OBJECT_PART_V1', nodes: { N1: { players: { me: { hand: [{ arena_id: 1, name: 'Forest', visibility: 'player_known' }] }, opponent: { hand: [], handSize: 3 } } } } }],
    [`${prefix}/part-0002.json`, serializeCoachJson({ schema: 'MTGA_COACH_OBJECT_PART_V1', nodes: { N2: { event: { type: 'land', actor: 'me', card: { arena_id: 1, name: 'Forest', visibility: 'public' } } } } })],
  ]);
  return rehashMultipart(value);
}
const partText = value => typeof value === 'string' ? value : serializeCoachJson(value);
const queuedDirectory = (h, value) => join(h.dataDir, 'coach-sync', 'bundles', value.historyKey, value.contentHash);

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mtga-coach-sync-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'local-data'), bare = join(directory, 'remote.git');
  await execute('git', ['init', '--bare', '-b', 'main', bare], { env });
  const control = { visibility: 'PRIVATE', offline: false, unavailableGh: false, rejectPush: false, calls: [], visibilityChecks: 0, publicAtCheck: Infinity, gitEnv: {} };
  const runCommand = async (file, args, { cwd, encoding = 'utf8', env: commandEnv = {} } = {}) => {
    control.calls.push({ file, args: [...args] });
    if (file === 'gh') {
      assert.deepEqual(args.slice(0, 3), ['repo', 'view', REPOSITORY]);
      control.visibilityChecks++;
      if (control.unavailableGh) throw new Error('network error ghp_SyntheticSecretMustNotEscape /Users/synthetic/private.log');
      let defaultBranchRef = null;
      try { await execute('git', ['--git-dir', bare, 'rev-parse', '--verify', 'HEAD'], { env }); defaultBranchRef = { name: 'main' }; } catch { /* Empty remote. */ }
      return JSON.stringify({ nameWithOwner: REPOSITORY, visibility: control.visibilityChecks >= control.publicAtCheck ? 'PUBLIC' : control.visibility, url: `https://github.com/${REPOSITORY}`, defaultBranchRef });
    }
    assert.equal(file, 'git');
    const networkCommand = args.find(value => value === 'fetch' || value === 'push');
    if (networkCommand && (control.offline || (control.rejectPush && networkCommand === 'push'))) throw new Error('fatal ghp_SyntheticSecretMustNotEscape https://token@example.invalid /Users/synthetic/private.log');
    if (networkCommand) {
      const remote = await execute('git', ['remote', 'get-url', '--all', ...(networkCommand === 'push' ? ['--push'] : []), 'origin'], { cwd, env });
      if (remote.stdout.trim().split('\n').some(value => value !== REMOTE_URL)) throw new Error('Test harness forbids every noncanonical network destination.');
    }
    // The stored origin stays canonical. Only network commands get a per-command
    // rewrite to a fresh local bare repository; no synthetic data reaches GitHub.
    const routed = networkCommand ? ['-c', `url.${bare}.insteadOf=${REMOTE_URL}`, ...args] : args;
    return execute(file, routed, { cwd, encoding, env: { ...process.env, ...env, ...control.gitEnv, ...commandEnv }, maxBuffer: 32 * 1024 * 1024 });
  };
  const options = { dataDir, runCommand };
  const published = async path => (await execute('git', ['--git-dir', bare, 'show', `HEAD:${path}`], { env })).stdout;
  const commits = async () => {
    try { return Number((await execute('git', ['--git-dir', bare, 'rev-list', '--count', 'HEAD'], { env })).stdout.trim()); } catch { return 0; }
  };
  const checkout = join(dataDir, 'coach-sync', 'repository');
  return { options, control, published, commits, checkout, bare, dataDir };
}

function catalogReplay(id, minute) {
  return { schema_version: '2.0', perspective: { hidden_information: 'omitted' },
    match: { id, started_at: `2026-10-01T12:${String(minute).padStart(2, '0')}:00.000Z`, event: 'Jump In', is_jump_in: true, result: 'Win' },
    deck: [], warnings: [], games: [{ game_number: 1, states: {},
      steps: [{ anchor: 'T1-A1', turn: 1, event: { type: 'life', life: { me: 20, opponent: 0 } } }],
      turns: [{ turn_number: 1, events: [{ type: 'life', life: { me: 20, opponent: 0 } }] }],
      starting_hand: [], result: { outcome: 'Win', life: { me: 20, opponent: 0 } }, warnings: [] }] };
}

test('running Viewer discovers two later log matches without restart and continues past a failed match', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  const logDir = join(h.dataDir, 'logs'), viewerDir = join(h.dataDir, 'viewer');
  await mkdir(logDir, { recursive: true }); await mkdir(viewerDir);
  await writeFile(join(viewerDir, 'index.html'), '<title>Synthetic sync integration</title>');
  const logPath = join(logDir, 'Player.log');
  await writeFile(logPath, syntheticLog([['synthetic-A', 0]]));
  const options = { ...h.options, logDir };
  assert.equal((await syncReplayHistory(options)).published, 1);
  const running = await startReplayServer({ dataDir: h.dataDir, viewerDir, displayNamesZh: new Map(),
    syncWorkflow: request => syncReplayHistory({ ...options, ...request }) });
  t.after(() => running.close());
  const post = () => fetch(running.url + 'api/sync', { method: 'POST', headers: { Origin: new URL(running.url).origin, 'X-MTGA-Replay-Action': 'sync' } }).then(r => r.json());
  async function finish() {
    for (let i = 0; i < 1200; i++) {
      const job = await fetch(running.url + 'api/sync').then(r => r.json());
      if (job.status !== 'running') return job;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Canonical synthetic sync exceeded 30 seconds');
  }
  const commits = await h.commits(); await post(); const unchanged = await finish();
  assert.equal(unchanged.status, 'succeeded'); assert.equal(unchanged.result.missing, 0);
  assert.equal(unchanged.result.published, 0); assert.equal(await h.commits(), commits);
  // A newly rotated file did not exist when the server started.
  await writeFile(join(logDir, 'Player-prev.log'), syntheticLog([['synthetic-B', 1], ['synthetic-C', 2]]));
  const [first, duplicate] = await Promise.all([post(), post()]); assert.equal(first.id, duplicate.id);
  const added = await finish(); assert.equal(added.status, 'succeeded');
  assert.equal(added.result.local_matches, 3); assert.equal(added.result.already_published, 1);
  assert.equal(added.result.missing, 2); assert.equal(added.result.published, 2); assert.equal(added.result.new_matches, 2);
  assert.equal(added.result.github_matches, 3);
  assert.deepEqual((await fetch(running.url + 'api/matches').then(r => r.json())).map(m => m.id), ['synthetic-C', 'synthetic-B', 'synthetic-A']);
  assert.equal(JSON.parse(await h.published('index.json')).matches.length, 3);
  const bad = catalogReplay('synthetic-bad', 4); bad.games[0].steps = [];
  await archiveReplays([bad], h.options);
  await writeFile(logPath, syntheticLog([['synthetic-A', 0], ['synthetic-D', 3]]));
  await post(); const partial = await finish();
  assert.equal(partial.status, 'partial'); assert.equal(partial.result.published, 1);
  assert.equal(partial.result.failed, 1); assert.equal(partial.result.failures[0].match_id, 'synthetic-bad');
  assert.equal(partial.result.github_matches, 4); assert.equal(JSON.parse(await h.published('index.json')).matches.length, 4);
});

test('catalog backfills seven local/two remote matches, sorts by time and is idempotent', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  const replays = 'ABCDEFG'.split('').map((id, minute) => catalogReplay(`synthetic-${id}`, minute));
  // Seed remote in reverse upload order, without matching local sync receipts.
  for (const replay of [replays[4], replays[0]]) {
    await enqueueCoachBundle(await buildCoachBundle(replay, { multipart: true }), h.options); await syncCoachBundles(h.options);
  }
  const statePath = join(h.dataDir, 'coach-sync', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')); state.synced = {};
  await writeFile(statePath, JSON.stringify(state));
  await archiveReplays([...replays].reverse(), h.options);
  const result = await syncCoachCatalog(h.options);
  assert.equal(result.local, 7); assert.equal(result.already_published, 2); assert.equal(result.missing, 5);
  assert.equal(result.published, 5); assert.deepEqual(result.failed, []); assert.equal(result.github_total, 7);
  assert.equal(result.latest.match_id, 'synthetic-G');
  const index = JSON.parse(await h.published('index.json'));
  assert.equal(index.schema, 'MTGA_COACH_INDEX_V1'); assert.equal(new Set(index.matches.map(m => m.match_id)).size, 7);
  assert.deepEqual(index.matches.map(m => m.match_id), 'GFEDCBA'.split('').map(id => `synthetic-${id}`));
  assert.deepEqual((await listReplays({ ...h.options, limit: null })).map(m => m.id), index.matches.map(m => m.match_id));
  for (const item of index.matches) assert.equal(JSON.parse(await h.published(`${item.path}/summary.json`)).match_id, item.match_id);
  const commits = await h.commits(), second = await syncCoachCatalog({ ...h.options, refreshMatchIds: ['synthetic-G'] });
  assert.equal(second.missing, 0); assert.equal(second.published, 0); assert.equal(second.updated, 0);
  assert.equal(second.committed, 0); assert.equal(await h.commits(), commits);
  assert.equal((await getCoachSyncStatus(h.options)).pending, 0);
  const output = []; printCatalogSync(second, line => output.push(line));
  assert.match(output.join('\n'), /Local matches: 7[\s\S]*Already published: 7[\s\S]*Missing: 0/);
  assert.match(output.join('\n'), /Everything is up to date/);
});

test('catalog backfill of older C and D preserves newest G and byte-identical latest', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  const newest = catalogReplay('synthetic-G', 6);
  await archiveReplays([newest], h.options); await syncCoachCatalog(h.options);
  const bytes = await Promise.all(FILES.map(name => h.published(`latest/${name}`)));
  await archiveReplays([catalogReplay('synthetic-C', 2), catalogReplay('synthetic-D', 3)], h.options);
  const result = await syncCoachCatalog(h.options);
  assert.equal(result.missing, 2); assert.equal(result.published, 2); assert.equal(result.latest.match_id, newest.match.id);
  const index = JSON.parse(await h.published('index.json'));
  assert.deepEqual(index.matches.map(m => m.match_id), ['synthetic-G', 'synthetic-D', 'synthetic-C']);
  for (const [i, name] of FILES.entries()) assert.equal(await h.published(`latest/${name}`), bytes[i]);
});

test('one missing replay generation failure reports identity/reason and publishes the other four completely', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  const replays = 'ABCDE'.split('').map((id, minute) => catalogReplay(`synthetic-${id}`, minute));
  replays[2].games[0].steps = [];
  await archiveReplays(replays, h.options);
  const result = await syncCoachCatalog(h.options);
  assert.equal(result.missing, 5); assert.equal(result.published, 4); assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].match_id, 'synthetic-C'); assert.equal(result.failed[0].started_at, replays[2].match.started_at);
  assert.match(result.failed[0].reason, /no detailed game steps/); assert.equal(result.github_total, 4);
  const index = JSON.parse(await h.published('index.json'));
  assert.deepEqual(index.matches.map(m => m.match_id), ['synthetic-E', 'synthetic-D', 'synthetic-B', 'synthetic-A']);
  for (const item of index.matches) for (const name of FILES) assert.ok(JSON.parse(await h.published(`${item.path}/${name}`)));
  const tree = (await execute('git', ['--git-dir', h.bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { env })).stdout;
  assert.doesNotMatch(tree, /synthetic-C/);
  for (const name of FILES) assert.equal(await h.published(`latest/${name}`), await h.published(`${index.matches[0].path}/${name}`));
});

test('published catalog reads fetched remote index rather than an unpushed local commit', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  await archiveReplays([catalogReplay('synthetic-A', 0)], h.options); await syncCoachCatalog(h.options);
  await archiveReplays([catalogReplay('synthetic-B', 1)], h.options);
  h.control.rejectPush = true;
  const offline = await syncCoachCatalog(h.options);
  assert.ok(offline.sync_error); assert.equal(offline.published, 0); assert.equal(offline.failed.length, 1);
  const snapshot = await getPublishedCoachIndex(h.options);
  assert.deepEqual(snapshot.index.matches.map(m => m.match_id), ['synthetic-A']);
  h.control.rejectPush = false;
  const retried = await syncCoachCatalog(h.options);
  assert.equal(retried.missing, 1); assert.equal(retried.published, 1); assert.equal(retried.github_total, 2);
});

test('catalog repository guard failure aborts before generating or queueing any match', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  await archiveReplays([catalogReplay('synthetic-A', 0)], h.options); h.control.visibility = 'PUBLIC';
  await assert.rejects(syncCoachCatalog(h.options), error => error.code === 'SYNC_NOT_PRIVATE');
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 0); assert.equal(await h.commits(), 0);
});

test('pending replay regenerates with a remotely established stable key and does not block missing peers', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  const replay = catalogReplay('synthetic-A', 0);
  await enqueueCoachBundle(await buildCoachBundle(replay, { historyKey: 'local-pending-key', multipart: true }), h.options);
  const writer = { ...h.options, dataDir: join(h.dataDir, 'external-writer') };
  await configureCoachSync(REPOSITORY, writer);
  await enqueueCoachBundle(await buildCoachBundle(replay, { historyKey: 'remote-established-key', multipart: true }), writer);
  await syncCoachBundles(writer);
  await archiveReplays([replay, catalogReplay('synthetic-B', 1)], h.options);
  const result = await syncCoachCatalog(h.options);
  assert.equal(result.missing, 1); assert.equal(result.published, 1); assert.equal(result.updated, 0);
  assert.deepEqual(result.failed, []); assert.equal(result.github_total, 2);
  const index = JSON.parse(await h.published('index.json'));
  assert.equal(index.matches.find(match => match.match_id === replay.match.id).history_key, 'remote-established-key');
  assert.equal(await getCoachHistoryKey(replay.match.id, h.options), 'remote-established-key');
  assert.equal((await getCoachSyncStatus(h.options)).pending, 0);
  const tree = (await execute('git', ['--git-dir', h.bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { env })).stdout;
  assert.doesNotMatch(tree, /local-pending-key/);
});

test('stale local published receipt cannot suppress missing remote history or change its stable key', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  const statePath = join(h.dataDir, 'coach-sync', 'state.json'), state = JSON.parse(await readFile(statePath, 'utf8'));
  state.synced['synthetic-A'] = { history_key: 'original-stable-key', content_hash: 'a'.repeat(64), started_at: '2026-10-01T12:00:00.000Z' };
  await writeFile(statePath, JSON.stringify(state));
  await archiveReplays([catalogReplay('synthetic-A', 1)], h.options);
  const result = await syncCoachCatalog(h.options);
  assert.equal(result.already_published, 0); assert.equal(result.missing, 1); assert.equal(result.published, 1);
  assert.equal(result.latest.history_key, 'original-stable-key'); assert.deepEqual(result.failed, []);
  assert.equal(JSON.parse(await h.published('index.json')).matches.length, 1);
});

test('private sync publishes full byte-identical latest/history, ordered index and real content hashes', async t => {
  const h = await harness(t), first = await bundle();
  await configureCoachSync(REPOSITORY, h.options);
  assert.deepEqual(await enqueueCoachBundle(first, h.options), { queued: true, pending: 1 });
  const result = await syncCoachBundles(h.options);
  assert.equal(result.synced, true); assert.equal(result.committed, 1); assert.equal(await h.commits(), 1);
  assert.equal((await execute('git', ['remote', 'get-url', 'origin'], { cwd: h.checkout, env })).stdout.trim(), REMOTE_URL);
  for (const name of FILES) {
    const expected = serializeCoachJson(first[name.slice(0, -5)]), latest = await h.published(`latest/${name}`);
    assert.equal(latest, expected); assert.equal(await h.published(`matches/${first.historyKey}/${name}`), latest);
    if (name !== 'manifest.json') {
      assert.equal(first.manifest.files[name].sha256, digest(latest));
      assert.equal(first.manifest.files[name].bytes, Buffer.byteLength(latest));
    }
  }
  assert.equal(first.contentHash, digest(serializeCoachJson(first.manifest.files)));
  const index = JSON.parse(await h.published('index.json'));
  assert.equal(index.latest_match_id, first.summary.match_id); assert.equal(index.matches[0].content_hash, first.contentHash);
  assert.equal(index.matches[0].path, `matches/${first.historyKey}`);
  const paths = (await execute('git', ['--git-dir', h.bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { env })).stdout.trim().split('\n');
  assert.equal(paths.length, 11); assert.ok(paths.includes('README.md')); assert.ok(paths.includes('.gitignore'));
  assert.equal((await getCoachSyncStatus(h.options)).pending, 0);
});

test('identical content with regenerated manifest time creates no new commit or pending work', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  const first = await bundle(); await enqueueCoachBundle(first, h.options); await syncCoachBundles(h.options);
  const repeated = await bundle({ generated: '2031-01-01T00:00:00.000Z' });
  assert.equal(repeated.contentHash, first.contentHash);
  assert.deepEqual(await enqueueCoachBundle(repeated, h.options), { queued: false, duplicate: true });
  assert.equal((await syncCoachBundles(h.options)).committed, 0); assert.equal(await h.commits(), 1);
  assert.equal(await h.published('latest/manifest.json'), serializeCoachJson(first.manifest));
});

test('richer coverage of the same match replaces its stable folder and preserves unique history', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  const first = await bundle(), richer = await bundle({ richer: true });
  await enqueueCoachBundle(first, h.options); await syncCoachBundles(h.options);
  await enqueueCoachBundle(richer, h.options); assert.equal((await syncCoachBundles(h.options)).committed, 1);
  const index = JSON.parse(await h.published('index.json'));
  assert.equal(index.matches.length, 1); assert.equal(index.matches[0].history_key, first.historyKey);
  assert.equal(index.matches[0].content_hash, richer.contentHash);
  assert.equal(JSON.parse(await h.published('latest/coach.json')).games[0].steps.length, 2);
  assert.equal(await h.published(`matches/${first.historyKey}/coach.json`), await h.published('latest/coach.json'));
  assert.equal(await h.commits(), 2);
});

test('retrying an older match adds history without rolling latest back; old improvements stay in that folder', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  const newer = await bundle({ id: 'synthetic-match-newer', started: '2026-10-02T12:00:00.000Z' });
  await enqueueCoachBundle(newer, h.options); await syncCoachBundles(h.options);
  const newestBytes = await h.published('latest/coach.json');
  const older = await bundle(); await enqueueCoachBundle(older, h.options); await syncCoachBundles(h.options);
  const oldImprovement = await bundle({ richer: true }); await enqueueCoachBundle(oldImprovement, h.options); await syncCoachBundles(h.options);
  const index = JSON.parse(await h.published('index.json'));
  assert.deepEqual(index.matches.map(match => match.match_id), [newer.summary.match_id, older.summary.match_id]);
  assert.equal(index.latest_match_id, newer.summary.match_id); assert.equal(await h.published('latest/coach.json'), newestBytes);
  assert.equal(await h.published(`matches/${older.historyKey}/coach.json`), serializeCoachJson(oldImprovement.coach));
});

test('offline fetch retains queued bytes and retries successfully', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const first = await bundle();
  await enqueueCoachBundle(first, h.options); h.control.offline = true;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'GIT_FAILED');
  const failed = await getCoachSyncStatus({ ...h.options, verify: false }); assert.equal(failed.pending, 1); assert.equal(await h.commits(), 0);
  const queuedPath = join(h.dataDir, 'coach-sync', 'bundles', first.historyKey, first.contentHash, 'coach.json');
  assert.equal(await readFile(queuedPath, 'utf8'), serializeCoachJson(first.coach));
  h.control.offline = false; assert.equal((await syncCoachBundles(h.options)).synced, true);
  assert.equal(await h.published('latest/coach.json'), serializeCoachJson(first.coach));
  assert.equal((await getCoachSyncStatus(h.options)).last_error, null);
});

test('a rejected push leaves its local commit pending and retries without another commit', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const first = await bundle();
  await enqueueCoachBundle(first, h.options); h.control.rejectPush = true;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'GIT_FAILED');
  assert.equal(await h.commits(), 0); assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1);
  h.control.rejectPush = false; const result = await syncCoachBundles(h.options);
  assert.equal(result.committed, 0); assert.equal(await h.commits(), 1);
  assert.equal(await h.published('latest/coach.json'), serializeCoachJson(first.coach));
});

test('public repository blocks configuration and later visibility changes block upload', async t => {
  const h = await harness(t); h.control.visibility = 'PUBLIC';
  await assert.rejects(configureCoachSync(REPOSITORY, h.options), error => error.code === 'SYNC_NOT_PRIVATE');
  assert.equal((await getCoachSyncStatus(h.options)).enabled, false);
  h.control.visibility = 'PRIVATE'; await configureCoachSync(REPOSITORY, h.options); await enqueueCoachBundle(await bundle(), h.options);
  h.control.visibility = 'PUBLIC'; const callCount = h.control.calls.length;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'SYNC_NOT_PRIVATE');
  assert.equal(h.control.calls.slice(callCount).filter(call => call.file === 'git').length, 0);
  assert.equal(await h.commits(), 0); assert.equal((await getCoachSyncStatus(h.options)).visibility, 'NOT_PRIVATE');
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1);
});

test('visibility is verified again before push and changing to PUBLIC preserves pending work', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); await enqueueCoachBundle(await bundle(), h.options);
  h.control.publicAtCheck = h.control.visibilityChecks + 2;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'SYNC_NOT_PRIVATE');
  assert.equal(await h.commits(), 0); assert.equal(h.control.calls.some(call => call.args.includes('push')), false);
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1);
  h.control.publicAtCheck = Infinity; const result = await syncCoachBundles(h.options);
  assert.equal(result.committed, 0); assert.equal(await h.commits(), 1);
});

test('dirty checkout retains local files and published bytes without attempting push', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const first = await bundle();
  await enqueueCoachBundle(first, h.options); await syncCoachBundles(h.options);
  const unsafePath = join(h.checkout, 'README.md'), localEdit = 'Personal local note must be preserved';
  await writeFile(unsafePath, localEdit);
  await enqueueCoachBundle(await bundle({ richer: true }), h.options); const callCount = h.control.calls.length;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'SYNC_DIRTY');
  assert.equal(await readFile(unsafePath, 'utf8'), localEdit);
  assert.equal(await readFile(join(h.checkout, 'latest/coach.json'), 'utf8'), serializeCoachJson(first.coach));
  assert.equal(await h.published('latest/coach.json'), serializeCoachJson(first.coach));
  assert.equal(h.control.calls.slice(callCount).some(call => call.args.includes('push')), false);
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1);
});

test('unsafe staged JSON is preserved and rejected before rewrite or push; command errors are sanitized', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const first = await bundle();
  await enqueueCoachBundle(first, h.options); await syncCoachBundles(h.options);
  const unsafePath = join(h.checkout, 'latest/coach.json'), unsafe = '{"account_id":"synthetic-private-account"}\n';
  await writeFile(unsafePath, unsafe); await execute('git', ['add', 'latest/coach.json'], { cwd: h.checkout, env });
  await enqueueCoachBundle(await bundle({ richer: true }), h.options); const callCount = h.control.calls.length;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'MTGA_SYNC_SECURITY');
  assert.equal(await readFile(unsafePath, 'utf8'), unsafe);
  assert.equal((await execute('git', ['show', ':latest/coach.json'], { cwd: h.checkout, env })).stdout, unsafe);
  assert.equal(await h.published('latest/coach.json'), serializeCoachJson(first.coach));
  assert.equal(h.control.calls.slice(callCount).some(call => call.args.includes('push')), false);
  h.control.unavailableGh = true;
  await assert.rejects(syncCoachBundles(h.options), error => {
    assert.equal(error.code, 'GITHUB_UNAVAILABLE');
    assert.doesNotMatch(error.message, /SyntheticSecret|\/Users\/|token@example/); return true;
  });
  const status = await getCoachSyncStatus({ ...h.options, verify: false });
  assert.equal(status.pending, 1); assert.doesNotMatch(JSON.stringify(status.last_error), /SyntheticSecret|\/Users\/|token@example/);
});

test('automatic sync uses the fixed service identity despite global and repository personal config; human Git is unchanged', async t => {
  const h = await harness(t), globalConfig = join(h.dataDir, 'synthetic-global-gitconfig');
  await mkdir(h.dataDir, { recursive: true });
  const configuration = '[user]\n\tname = Neil Wang\n\temail = personal@example.com\n';
  await writeFile(globalConfig, configuration);
  h.control.gitEnv = { GIT_CONFIG_GLOBAL: globalConfig };
  await mkdir(h.checkout, { recursive: true });
  await execute('git', ['init', '-b', 'main'], { cwd: h.checkout, env });
  await execute('git', ['remote', 'add', 'origin', REMOTE_URL], { cwd: h.checkout, env });
  for (const [key, value] of [['user.name', 'Synthetic Repo Person'], ['user.email', 'repo-person@example.invalid']]) {
    await execute('git', ['config', '--local', key, value], { cwd: h.checkout, env });
  }
  await configureCoachSync(REPOSITORY, h.options); await enqueueCoachBundle(await bundle(), h.options);
  assert.equal((await syncCoachBundles(h.options)).synced, true);
  const identity = (await execute('git', ['--git-dir', h.bare, 'log', '--format=%an|%ae|%cn|%ce', 'HEAD'], { env })).stdout.trim();
  assert.equal(identity, 'mtga-replay-coach|mtga-replay-coach@users.noreply.github.com|mtga-replay-coach|mtga-replay-coach@users.noreply.github.com');
  assert.doesNotMatch(identity, /Neil Wang|personal@example|Synthetic Repo Person|repo-person/);
  assert.equal((await validateStagedRepository(h.checkout)).ok, true);
  assert.equal(await readFile(globalConfig, 'utf8'), configuration);
  for (const [key, value] of [['user.name', 'Synthetic Repo Person'], ['user.email', 'repo-person@example.invalid']]) {
    assert.equal((await execute('git', ['config', '--local', '--get', key], { cwd: h.checkout, env })).stdout.trim(), value);
  }
  const manual = join(h.dataDir, 'ordinary-human-repository'), manualEnv = { ...env, GIT_CONFIG_GLOBAL: globalConfig };
  await mkdir(manual); await execute('git', ['init', '-b', 'main'], { cwd: manual, env: manualEnv });
  await writeFile(join(manual, 'note.txt'), 'Synthetic ordinary human commit.');
  await execute('git', ['add', 'note.txt'], { cwd: manual, env: manualEnv });
  await execute('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Synthetic human commit'], { cwd: manual, env: manualEnv });
  const manualIdentity = (await execute('git', ['log', '-1', '--format=%an|%ae|%cn|%ce'], { cwd: manual, env: manualEnv })).stdout.trim();
  assert.equal(manualIdentity, 'Neil Wang|personal@example.com|Neil Wang|personal@example.com');
});

test('private inherited Git author and committer identities cannot enter outgoing commits', async t => {
  const identityKeys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
  const previous = Object.fromEntries(identityKeys.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.GIT_AUTHOR_NAME = 'Neil Wang'; process.env.GIT_AUTHOR_EMAIL = 'personal@example.com';
  process.env.GIT_COMMITTER_NAME = 'Neil Wang'; process.env.GIT_COMMITTER_EMAIL = 'personal@example.com';
  const h = await harness(t);
  h.control.gitEnv = { EMAIL: 'personal@example.com', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Neil Wang', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'personal@example.com' };
  await configureCoachSync(REPOSITORY, h.options); await enqueueCoachBundle(await bundle(), h.options); await syncCoachBundles(h.options);
  const identities = (await execute('git', ['--git-dir', h.bare, 'log', '--format=%an|%ae|%cn|%ce', 'HEAD'], { env })).stdout.trim().split('\n');
  assert.deepEqual(identities, ['mtga-replay-coach|mtga-replay-coach@users.noreply.github.com|mtga-replay-coach|mtga-replay-coach@users.noreply.github.com']);
  assert.doesNotMatch(identities.join('\n'), /Neil Wang|personal@example/);
  assert.equal((await validateStagedRepository(h.checkout)).ok, true);
});

test('SQLite-only pending archives retry a rejected push with fixed identities and no duplicate replay or commit', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  const replays = [catalogReplay('synthetic-retry-A', 1), catalogReplay('synthetic-retry-B', 2)];
  await archiveReplays(replays, h.options); h.control.rejectPush = true;
  const failed = await syncCoachCatalog(h.options);
  assert.ok(failed.sync_error); assert.equal(failed.published, 0);
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 2);
  const localCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: h.checkout, env })).stdout.trim();
  h.control.rejectPush = false;
  const result = await syncCoachCatalog(h.options);
  assert.equal(result.published, 2); assert.equal(result.github_total, 2); assert.deepEqual(result.failed, []);
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 0);
  assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: h.checkout, env })).stdout.trim(), localCommit);
  assert.deepEqual((await listReplays({ ...h.options, limit: null })).map(match => match.id), ['synthetic-retry-B', 'synthetic-retry-A']);
  const index = JSON.parse(await h.published('index.json'));
  assert.equal(index.latest_match_id, 'synthetic-retry-B'); assert.equal(new Set(index.matches.map(match => match.match_id)).size, 2);
  const newest = index.matches[0];
  for (const file of FILES) assert.equal(await h.published(`latest/${file}`), await h.published(`${newest.path}/${file}`));
  const commits = await h.commits(), repeated = await syncCoachCatalog(h.options);
  assert.equal(repeated.missing, 0); assert.equal(repeated.published, 0); assert.equal(repeated.committed, 0); assert.equal(await h.commits(), commits);
  const identities = (await execute('git', ['--git-dir', h.bare, 'log', '--format=%an|%ae|%cn|%ce', 'HEAD'], { env })).stdout.trim().split('\n');
  assert.ok(identities.every(identity => identity === 'mtga-replay-coach|mtga-replay-coach@users.noreply.github.com|mtga-replay-coach|mtga-replay-coach@users.noreply.github.com'));
  assert.equal((await validateStagedRepository(h.checkout)).ok, true);
});

test('incoming personal research commits are still rejected before any new replay is queued or committed', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  await archiveReplays([catalogReplay('synthetic-before-research', 1)], h.options); await syncCoachCatalog(h.options);
  const writer = join(h.dataDir, 'research-writer');
  await execute('git', ['clone', h.bare, writer], { env });
  const document = 'docs/research/live-coach/synthetic-research.md';
  await mkdir(join(writer, 'docs', 'research', 'live-coach'), { recursive: true });
  await writeFile(join(writer, document), 'Synthetic non-replay research document.');
  await execute('git', ['add', '-f', '--', document], { cwd: writer, env });
  const personalEnv = { ...env, GIT_AUTHOR_NAME: 'Synthetic Research Author', GIT_AUTHOR_EMAIL: 'research-person@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Research Author', GIT_COMMITTER_EMAIL: 'research-person@example.invalid' };
  await execute('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Synthetic research'], { cwd: writer, env: personalEnv });
  await execute('git', ['push', 'origin', 'main'], { cwd: writer, env });
  await archiveReplays([catalogReplay('synthetic-after-research', 2)], h.options);
  const localHead = (await execute('git', ['rev-parse', 'HEAD'], { cwd: h.checkout, env })).stdout.trim();
  await assert.rejects(syncCoachCatalog(h.options), error => error.code === 'MTGA_SYNC_SECURITY' && error.rule === 'commit-personal-identity');
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 0);
  assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: h.checkout, env })).stdout.trim(), localHead);
  assert.equal((await listReplays({ ...h.options, limit: null })).length, 2);
  assert.equal(JSON.parse(await h.published('index.json')).matches.length, 1);
});

test('explicit local approval preserves existing remote research history while backfilling SQLite and remaining idempotent', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options);
  await archiveReplays([catalogReplay('synthetic-before-approved-history', 1)], h.options); await syncCoachCatalog(h.options);
  const writer = join(h.dataDir, 'approved-research-writer');
  await execute('git', ['clone', h.bare, writer], { env });
  const document = 'docs/research/live-coach/Existing_Research.md', text = 'Existing fixed synthetic research.';
  await mkdir(join(writer, 'docs/research/live-coach'), { recursive: true });
  await writeFile(join(writer, document), text);
  await execute('git', ['add', '-f', '--', document], { cwd: writer, env });
  await execute('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Existing synthetic research'], {
    cwd: writer, env: { ...env, GIT_AUTHOR_NAME: 'Synthetic Research', GIT_AUTHOR_EMAIL: 'research@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic Research', GIT_COMMITTER_EMAIL: 'research@example.invalid' } });
  await execute('git', ['push', 'origin', 'main'], { cwd: writer, env });
  const sha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: writer, env })).stdout.trim();
  const blob = (await execute('git', ['rev-parse', `HEAD:${document}`], { cwd: writer, env })).stdout.trim();
  const approval = { schema: 'MTGA_SYNC_HISTORY_APPROVAL_V1', approved: true, repository: REPOSITORY, branch: 'main',
    approved_at: '2026-10-05T00:00:00.000Z', commits: [sha], files: [{ path: document, blob, mode: '100644', sha256: digest(text), bytes: Buffer.byteLength(text) }] };
  await archiveReplays([catalogReplay('synthetic-after-approved-history', 2)], h.options);
  await assert.rejects(syncCoachCatalog(h.options), e => e.rule === 'commit-personal-identity');
  await assert.rejects(approveCoachSyncHistory({ ...approval, repository: 'another/private' }, h.options), e => e.rule === 'invalid-history-approval');
  await approveCoachSyncHistory(approval, h.options);
  assert.deepEqual(JSON.parse(await readFile(join(h.dataDir, 'coach-sync/state.json'), 'utf8')).history_approval, approval);
  const result = await syncCoachCatalog(h.options);
  assert.equal(result.published, 1); assert.equal(JSON.parse(await h.published('index.json')).matches.length, 2);
  assert.equal(await h.published(document), text);
  await execute('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: h.checkout, env });
  const count = await h.commits(); assert.equal((await syncCoachCatalog(h.options)).published, 0); assert.equal(await h.commits(), count);
  const outgoing = (await execute('git', ['log', '--format=%ae|%ce', `${sha}..HEAD`], { cwd: h.checkout, env })).stdout.trim();
  assert.equal(outgoing, 'mtga-replay-coach@users.noreply.github.com|mtga-replay-coach@users.noreply.github.com');
  const scannerOptions = { historyApproval: approval, repository: REPOSITORY, branch: 'main' };
  assert.equal((await validateStagedRepository(h.checkout, scannerOptions)).ok, true);
  await execute('git', ['rm', '--', document], { cwd: h.checkout, env });
  await assert.rejects(validateStagedRepository(h.checkout, scannerOptions), e => e.rule === 'unapproved-file-path');
});

test('ignored private files and a latest ancestor symlink both block sync and preserve outside bytes', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const first = await bundle();
  await enqueueCoachBundle(first, h.options); await syncCoachBundles(h.options);
  const ignoredPath = join(h.checkout, 'private-note.txt'), privateNote = 'Ignored private local note';
  await writeFile(ignoredPath, privateNote); await enqueueCoachBundle(await bundle({ richer: true }), h.options);
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'SYNC_DIRTY');
  assert.equal(await readFile(ignoredPath, 'utf8'), privateNote); assert.equal(await h.commits(), 1);
  await rm(ignoredPath);
  const latest = join(h.checkout, 'latest'), outside = join(h.dataDir, 'outside-latest');
  await rename(latest, outside); await writeFile(join(outside, 'outside-sentinel.txt'), 'Outside data must be preserved');
  await symlink(outside, latest, 'dir');
  const outsideBytes = new Map(await Promise.all([...FILES, 'outside-sentinel.txt'].map(async name => [name, await readFile(join(outside, name), 'utf8')])));
  const callCount = h.control.calls.length;
  await assert.rejects(syncCoachBundles(h.options), error => ['SYNC_DIRTY', 'SYNC_WORKTREE', 'MTGA_SYNC_SECURITY'].includes(error.code));
  assert.equal((await lstat(latest)).isSymbolicLink(), true);
  for (const [name, content] of outsideBytes) assert.equal(await readFile(join(outside, name), 'utf8'), content);
  assert.equal(h.control.calls.slice(callCount).some(call => call.args.includes('push')), false);
  assert.equal(await h.commits(), 1); assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1);
});

test('a second origin push URL is rejected before fetch or push even when the first URL is private canonical', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const first = await bundle();
  await enqueueCoachBundle(first, h.options); await syncCoachBundles(h.options);
  await execute('git', ['remote', 'set-url', '--add', '--push', 'origin', REMOTE_URL], { cwd: h.checkout, env });
  await execute('git', ['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/fixture-owner/public-leak.git'], { cwd: h.checkout, env });
  assert.equal((await execute('git', ['remote', 'get-url', '--push', 'origin'], { cwd: h.checkout, env })).stdout.trim(), REMOTE_URL);
  await enqueueCoachBundle(await bundle({ richer: true }), h.options); const callCount = h.control.calls.length;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'SYNC_REMOTE');
  assert.equal(h.control.calls.slice(callCount).some(call => call.args.includes('fetch') || call.args.includes('push')), false);
  assert.equal(await h.commits(), 1); assert.equal(await h.published('latest/coach.json'), serializeCoachJson(first.coach));
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1);
});

test('multipart enqueue persists all parts, retries fetch/push failures, stages exact history paths and copies only four latest files', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const value = await multipartBundle();
  await enqueueCoachBundle(value, h.options);
  for (const [path, part] of value.parts) assert.equal(await readFile(join(queuedDirectory(h, value), path), 'utf8'), partText(part));
  h.control.offline = true;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'GIT_FAILED');
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1); assert.equal(await h.commits(), 0);
  h.control.offline = false; h.control.rejectPush = true;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'GIT_FAILED');
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1); assert.equal(await h.commits(), 0);
  for (const [path, part] of value.parts) assert.equal(await readFile(join(h.checkout, path), 'utf8'), partText(part));
  const commitsBeforeRetry = Number((await execute('git', ['rev-list', '--count', 'HEAD'], { cwd: h.checkout, env })).stdout.trim());
  h.control.rejectPush = false; const result = await syncCoachBundles(h.options);
  assert.equal(result.committed, 0); assert.equal(await h.commits(), commitsBeforeRetry);
  const tree = (await execute('git', ['--git-dir', h.bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { env })).stdout.trim().split('\n');
  assert.deepEqual(tree.filter(path => path.startsWith('latest/')), FILES.map(name => `latest/${name}`).sort());
  for (const name of FILES) {
    const latest = await h.published(`latest/${name}`);
    assert.equal(latest, serializeCoachJson(value[name.slice(0, -5)]));
    assert.equal(await h.published(`matches/${value.historyKey}/${name}`), latest);
  }
  for (const [path, part] of value.parts) {
    const bytes = await h.published(path); assert.equal(bytes, partText(part));
    assert.equal(value.manifest.files[path].sha256, digest(bytes)); assert.equal(value.manifest.files[path].bytes, Buffer.byteLength(bytes));
    assert.ok(tree.includes(path));
  }
  assert.equal(value.contentHash, digest(serializeCoachJson(value.manifest.files)));
  assert.equal((await getCoachSyncStatus(h.options)).pending, 0);
  assert.deepEqual(await enqueueCoachBundle(value, h.options), { queued: false, duplicate: true });
});

test('multipart enqueue blocks forbidden paths, credential payloads, missing coverage and hash or byte mismatches before queueing', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const original = await multipartBundle();
  const firstPath = [...original.parts.keys()][0], firstValue = original.parts.get(firstPath);
  const cases = [];
  for (const forbidden of ['latest/parts/part-0001.json', `matches/${original.historyKey}/parts/../Player.log`, 'matches/another-match/parts/part-0001.json']) {
    const value = structuredClone(original); value.parts.delete(firstPath); value.parts.set(forbidden, firstValue); rehashMultipart(value); cases.push(value);
  }
  const credential = structuredClone(original); credential.parts.set(firstPath, { authorization: 'Bearer synthetic-secret' }); rehashMultipart(credential); cases.push(credential);
  const missingCoverage = structuredClone(original); delete missingCoverage.manifest.files[firstPath];
  missingCoverage.contentHash = digest(serializeCoachJson(missingCoverage.manifest.files)); missingCoverage.manifest.content_hash = missingCoverage.contentHash; cases.push(missingCoverage);
  const absentPart = structuredClone(original); absentPart.parts.delete(firstPath); cases.push(absentPart);
  const wrongHash = structuredClone(original); wrongHash.manifest.files[firstPath].sha256 = '0'.repeat(64);
  wrongHash.contentHash = digest(serializeCoachJson(wrongHash.manifest.files)); wrongHash.manifest.content_hash = wrongHash.contentHash; cases.push(wrongHash);
  const wrongBytes = structuredClone(original); wrongBytes.manifest.files[firstPath].bytes++;
  wrongBytes.contentHash = digest(serializeCoachJson(wrongBytes.manifest.files)); wrongBytes.manifest.content_hash = wrongBytes.contentHash; cases.push(wrongBytes);
  for (const value of cases) await assert.rejects(enqueueCoachBundle(value, h.options), error => ['SYNC_BUNDLE', 'MTGA_SYNC_SECURITY'].includes(error.code));
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 0); assert.equal(await h.commits(), 0);
  assert.equal(h.control.calls.some(call => call.file === 'git'), false);
});

test('tampered or missing queued multipart bytes cannot reach staging and recover after restoring exact content', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const value = await multipartBundle(); await enqueueCoachBundle(value, h.options);
  const [path, part] = [...value.parts][0], queuePath = join(queuedDirectory(h, value), path), exact = partText(part);
  await writeFile(queuePath, '{"safe_but_changed":true}\n');
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'SYNC_BUNDLE');
  assert.equal(await readFile(queuePath, 'utf8'), '{"safe_but_changed":true}\n'); assert.equal(await h.commits(), 0);
  assert.equal((await execute('git', ['diff', '--cached', '--name-only'], { cwd: h.checkout, env })).stdout, '');
  await rm(queuePath); await assert.rejects(syncCoachBundles(h.options));
  const status = await getCoachSyncStatus({ ...h.options, verify: false }); assert.equal(status.pending, 1);
  assert.doesNotMatch(JSON.stringify(status.last_error), /mtga-coach-sync-test-|\/private\/|\/var\//);
  await writeFile(queuePath, exact); assert.equal((await syncCoachBundles(h.options)).synced, true);
  assert.equal(await h.published(path), exact);
});

test('queued multipart ancestor symlink blocks reads and leaves outside files unchanged', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const value = await multipartBundle(); await enqueueCoachBundle(value, h.options);
  const partPath = [...value.parts.keys()][0], partDirectory = join(queuedDirectory(h, value), partPath, '..');
  const outside = join(h.dataDir, 'outside-object-parts'); await rename(partDirectory, outside); await symlink(outside, partDirectory, 'dir');
  const before = new Map(await Promise.all([...value.parts].map(async ([path]) => [path.split('/').at(-1), await readFile(join(outside, path.split('/').at(-1)), 'utf8')])));
  const callCount = h.control.calls.length;
  await assert.rejects(syncCoachBundles(h.options), error => error.code === 'SYNC_WORKTREE');
  for (const [name, content] of before) assert.equal(await readFile(join(outside, name), 'utf8'), content);
  assert.equal((await lstat(partDirectory)).isSymbolicLink(), true); assert.equal(await h.commits(), 0);
  assert.equal(h.control.calls.slice(callCount).some(call => call.args.includes('push')), false);
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1);
});

test('multipart history key stays stable across corrected start time and existing synced references', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const first = await multipartBundle();
  await enqueueCoachBundle(first, h.options); assert.equal(await getCoachHistoryKey(first.summary.match_id, h.options), first.historyKey); await syncCoachBundles(h.options);
  const changed = await multipartBundle({ started: '2026-10-01T12:00:01.000Z', richer: true });
  await assert.rejects(enqueueCoachBundle(changed, h.options), error => error.code === 'SYNC_BUNDLE');
  const wrongKey = changed.historyKey; changed.historyKey = await getCoachHistoryKey(first.summary.match_id, h.options);
  changed.parts = new Map([...changed.parts].map(([path, part]) => [path.replace(`matches/${wrongKey}/`, `matches/${changed.historyKey}/`), part])); rehashMultipart(changed);
  await enqueueCoachBundle(changed, h.options); await syncCoachBundles(h.options);
  const index = JSON.parse(await h.published('index.json')); assert.equal(index.matches.length, 1); assert.equal(index.matches[0].history_key, first.historyKey);
  for (const name of FILES) assert.equal(await h.published(`matches/${first.historyKey}/${name}`), await h.published(`latest/${name}`));
  for (const [path, part] of changed.parts) assert.equal(await h.published(path), partText(part));
  const tree = (await execute('git', ['--git-dir', h.bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { env })).stdout;
  assert.doesNotMatch(tree, new RegExp(wrongKey));
});

test('queued main JSON must retain exact bytes and cannot hide a private overwritten duplicate property', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const value = await multipartBundle(); await enqueueCoachBundle(value, h.options);
  const queuePath = join(queuedDirectory(h, value), 'coach.json'), exact = serializeCoachJson(value.coach);
  const duplicate = exact.replace('"match": {', '"match": {"player":{"account_id":"synthetic-private-account"}},\n  "match": {');
  assert.notEqual(duplicate, exact); assert.deepEqual(JSON.parse(duplicate), JSON.parse(exact));
  for (const tampered of [exact + '\n', duplicate]) {
    await writeFile(queuePath, tampered); const callCount = h.control.calls.length;
    await assert.rejects(syncCoachBundles(h.options), error => ['SYNC_BUNDLE', 'MTGA_SYNC_SECURITY'].includes(error.code));
    assert.equal(await readFile(queuePath, 'utf8'), tampered); assert.equal(await h.commits(), 0);
    assert.equal((await execute('git', ['diff', '--cached', '--name-only'], { cwd: h.checkout, env })).stdout, '');
    assert.equal(h.control.calls.slice(callCount).some(call => call.args.includes('push')), false);
    assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 1);
  }
  await writeFile(queuePath, exact); assert.equal((await syncCoachBundles(h.options)).synced, true);
  assert.equal(await h.published('latest/coach.json'), exact);
  assert.doesNotMatch(await h.published('latest/coach.json'), /synthetic-private-account|account_id/);
});

test('actual multipart codec survives enqueue, Git staging, publish and lossless resolution of all before/after states', async t => {
  const h = await harness(t), expanded = await bundle({ richer: true, coachOptions: { multipart: false } });
  const encoded = await bundle({ richer: true, coachOptions: { multipart: true, partitionBytes: 8192 } });
  assert.ok(encoded.parts.size > 0); assert.equal(encoded.coach.reference_encoding.schema, 'MTGA_COACH_REFERENCE_V1');
  assert.deepEqual(resolveCoachBundle(encoded.coach, encoded.parts), expanded.coach);
  await configureCoachSync(REPOSITORY, h.options); await enqueueCoachBundle(encoded, h.options); await syncCoachBundles(h.options);
  const publishedCoach = JSON.parse(await h.published('latest/coach.json')), publishedParts = new Map();
  for (const [path, expected] of encoded.parts) {
    const content = await h.published(path); assert.equal(content, serializeCoachJson(expected)); assert.ok(Buffer.byteLength(content) <= 8192);
    assert.equal(encoded.manifest.files[path].sha256, digest(content)); publishedParts.set(path, JSON.parse(content));
  }
  const restored = resolveCoachBundle(publishedCoach, publishedParts);
  assert.deepEqual(restored, expanded.coach); assert.equal(restored.games[0].steps[1].before_state_id, 'S1');
  assert.equal(restored.games[0].states.S1.players.me.battlefield[0].name, 'Forest');
  assert.deepEqual(restored.games[0].states.S1.players.opponent.hand, []);
  for (const name of FILES) assert.equal(await h.published(`latest/${name}`), await h.published(`matches/${encoded.historyKey}/${name}`));
  assert.deepEqual(JSON.parse(await h.published('latest/cards.json')), expanded.cards);
});

test('individually safe string chunks cannot conceal a credential after multipart resolution', async t => {
  const h = await harness(t); await configureCoachSync(REPOSITORY, h.options); const value = await multipartBundle();
  const [firstPath, secondPath] = value.parts.keys();
  value.parts = new Map([
    [firstPath, { schema: 'MTGA_COACH_PART_V1', kind: 'actions', records: { first: 'gh' } }],
    [secondPath, { schema: 'MTGA_COACH_PART_V1', kind: 'actions', records: { second: 'p_SyntheticSecretMustNotEscape' } }],
  ]);
  value.coach.coachNotes = [{ anchor: 'T1-A1', game_number: 1, text: { type: 'string', $chunks: [
    { $ref: { file: firstPath, key: 'first' } }, { $ref: { file: secondPath, key: 'second' } },
  ] } }]; rehashMultipart(value);
  assert.equal(validateBundleFiles(new Map([...value.parts].map(([path, part]) => [path, partText(part)]))).ok, true);
  assert.equal(validateBundleFiles(new Map([['latest/coach.json', serializeCoachJson(value.coach)]])).ok, true);
  assert.equal(resolveCoachBundle(value.coach, value.parts).coachNotes[0].text, 'ghp_SyntheticSecretMustNotEscape');
  await assert.rejects(enqueueCoachBundle(value, h.options), error => {
    assert.equal(error.code, 'MTGA_SYNC_SECURITY'); assert.doesNotMatch(error.message, /SyntheticSecret/); return true;
  });
  assert.equal((await getCoachSyncStatus({ ...h.options, verify: false })).pending, 0); assert.equal(await h.commits(), 0);
  assert.equal(h.control.calls.some(call => call.file === 'git'), false);
});
