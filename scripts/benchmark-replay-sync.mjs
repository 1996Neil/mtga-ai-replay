/** Offline benchmark only: temporary synthetic archives, fixed fake identity,
 * local bare Git transport and prefilled card metadata. No network is used. */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const equal = value.indexOf('=');
  if (!value.startsWith('--') || equal < 0) throw new Error('Expected --name=value benchmark arguments.');
  return [value.slice(2, equal), value.slice(equal + 1)];
}));
const source = resolve(args.source ?? dirname(dirname(fileURLToPath(import.meta.url))));
const size = Number(args.size ?? 10), newMatches = Math.min(10, size), cacheCards = size * 10;
if (![10, 100, 500].includes(size)) throw new Error('Benchmark size must be 10, 100 or 500.');
const originalOpen = fs.open, originalReadFile = fs.readFile;
let active = false;
const metrics = { git_commands: {}, git_stdout_bytes: 0, git_stdin_bytes: 0, git_object_reads: {},
  git_object_bytes: {}, fingerprint_opens: {}, fingerprint_bytes: {}, read_file_bytes: {}, validation_calls: 0,
  semantic_checked: 0, semantic_reused: 0, phase_ms: {}, external_fetch_calls: 0 };
const objectReads = new Map(), commandRecords = [];
let fixtureDir;
const category = path => {
  const value = String(path);
  if (value.startsWith(source + '/src/') || value.includes('/node_modules/mtga-log-parser/') || value === join(source, 'package.json')) return 'rules';
  if (value.includes('/cards/') && value.endsWith('.json')) return 'card_metadata';
  if (/\.(?:sqlite3|mtga)(?:-wal)?$/.test(value)) return 'database';
  return 'other';
};
const increment = (record, key, count = 1) => { record[key] = (record[key] ?? 0) + count; };
fs.open = async function(path, ...rest) {
  const handle = await originalOpen.call(this, path, ...rest);
  if (active) {
    const kind = category(path); increment(metrics.fingerprint_opens, kind);
    const create = handle.createReadStream;
    handle.createReadStream = function(...options) {
      const stream = create.apply(this, options), iterator = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function*() {
        for await (const chunk of { [Symbol.asyncIterator]: iterator }) {
          increment(metrics.fingerprint_bytes, kind, Buffer.byteLength(chunk)); yield chunk;
        }
      };
      return stream;
    };
  }
  return handle;
};
fs.readFile = async function(path, ...rest) {
  const value = await originalReadFile.call(this, path, ...rest);
  if (active) increment(metrics.read_file_bytes, category(path), Buffer.byteLength(value));
  return value;
};
syncBuiltinESMExports();
globalThis.fetch = async () => { metrics.external_fetch_calls++; throw new Error('Benchmark forbids all external fetches.'); };
const from = file => import(pathToFileURL(join(source, file)).href);
const [{ archiveReplays }, { buildCoachBundle, serializeCoachJson }, { buildCoachCards },
  { configureCoachSync }, { syncReplayHistory }] = await Promise.all([
  from('src/history.mjs'), from('src/coach-bundle.mjs'), from('src/coach-cards.mjs'),
  from('src/coach-sync.mjs'), from('src/replay-workflow.mjs'),
]);
const identity = { GIT_AUTHOR_NAME: 'mtga-replay-coach', GIT_AUTHOR_EMAIL: 'mtga-replay-coach@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'mtga-replay-coach', GIT_COMMITTER_EMAIL: 'mtga-replay-coach@users.noreply.github.com' };
const env = { ...process.env, ...identity, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
function execute(file, command, { cwd, encoding = 'utf8', env: extra = {}, input } = {}) {
  return new Promise((yes, no) => {
    const child = execFile(file, command, { cwd, encoding, env: { ...env, ...extra }, timeout: 30000, maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) => error ? no(error) : yes(stdout));
    child.stdin.on('error', no); child.stdin.end(input);
  });
}
const repo = 'fixture-owner/private-coaching', remoteUrl = `https://github.com/${repo}.git`;
function gitCommand(command) {
  for (let i = 0; i < command.length; i++) {
    if (['-c', '-C', '--git-dir', '--work-tree'].includes(command[i])) { i++; continue; }
    return command[i];
  }
}
function countObjects(stdout) {
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  let cursor = 0;
  while (cursor < bytes.length) {
    const end = bytes.indexOf(10, cursor); if (end < 0) throw new Error('Unframed Git benchmark output');
    const [hash, type, length] = bytes.subarray(cursor, end).toString().split(' '), size = Number(length);
    if (!Number.isSafeInteger(size) || size < 0 || end + 2 + size > bytes.length) throw new Error('Invalid Git benchmark object');
    increment(metrics.git_object_reads, type); increment(metrics.git_object_bytes, type, size);
    objectReads.set(hash, (objectReads.get(hash) ?? 0) + 1);
    cursor = end + 2 + size;
  }
}
function syntheticReplay(number) {
  const cards = Array.from({ length: 8 }, (_, index) => ({ arena_id: index + 1, name: `Synthetic Card ${index + 1}`, visibility: 'player_known', quantity: 5 }));
  return { schema_version: '2.0', perspective: { hidden_information: 'omitted' },
    match: { id: `synthetic-bench-${String(number).padStart(4, '0')}`, started_at: new Date(Date.UTC(2026, 9, 1, 0, number)).toISOString(),
      event: 'Jump In', is_jump_in: true, result: 'Win' }, deck: cards, warnings: [],
    games: [{ game_number: 1, states: {}, steps: [{ anchor: 'T1-A1', turn: 1, event: { type: 'life', life: { me: 20, opponent: 0 } } }],
      turns: [{ turn_number: 1, events: [{ type: 'life', life: { me: 20, opponent: 0 } }] }], starting_hand: [],
      result: { outcome: 'Win', life: { me: 20, opponent: 0 } }, warnings: [] }] };
}

try {
  fixtureDir = await fs.mkdtemp(join(tmpdir(), 'mtga-offline-sync-benchmark-'));
  const dataDir = join(fixtureDir, 'data'), bare = join(fixtureDir, 'remote.git'), seed = join(fixtureDir, 'seed');
  await fs.mkdir(join(dataDir, 'cards'), { recursive: true }); await fs.mkdir(seed);
  await execute('git', ['init', '--bare', '-b', 'main', bare]);
  await execute('git', ['init', '-b', 'main'], { cwd: seed });
  const replays = Array.from({ length: size }, (_, index) => syntheticReplay(index));
  for (let id = 1; id <= cacheCards; id++) {
    await fs.writeFile(join(dataDir, 'cards', `${id}.json`), JSON.stringify({ arena_id: id, name: `Synthetic Card ${id}`,
      source: 'scryfall', cache_schema: 2, rules_schema: 1, mana_cost: '{1}', type_line: 'Artifact', oracle_text: 'Draw a card.', keywords: [] }));
  }
  const options = { dataDir, cardDb: '', displayNamesZh: new Map(), fetchFn: globalThis.fetch };
  const cards = await buildCoachCards(replays[0], options);
  const index = { schema: 'MTGA_COACH_INDEX_V1', matches: [] };
  const names = ['summary', 'coach', 'cards', 'manifest'];
  for (const replay of replays.slice(0, size - newMatches)) {
    const bundle = await buildCoachBundle(replay, { cards, multipart: true, generatedAt: '2026-10-01T00:00:00.000Z' });
    const path = `matches/${bundle.historyKey}`;
    const writes = new Map();
    for (const name of names) {
      const content = serializeCoachJson(bundle[name]);
      writes.set(`${path}/${name}.json`, content); writes.set(`latest/${name}.json`, content);
    }
    for (const [path, value] of bundle.parts ?? []) writes.set(path, typeof value === 'string' ? value : serializeCoachJson(value));
    index.matches.unshift({ match_id: replay.match.id, started_at: replay.match.started_at, mode: bundle.summary.mode,
      result: bundle.summary.result, history_key: bundle.historyKey, path, content_hash: bundle.contentHash });
    index.latest_match_id = replay.match.id;
    index.latest = Object.fromEntries(names.map(name => [name, `latest/${name}.json`]));
    writes.set('index.json', serializeCoachJson(index)); writes.set('README.md', '# Synthetic replay benchmark\n'); writes.set('.gitignore', '\n');
    for (const [path, content] of writes) { await fs.mkdir(dirname(join(seed, path)), { recursive: true }); await fs.writeFile(join(seed, path), content); }
    await execute('git', ['add', '--', '.'], { cwd: seed });
    await execute('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `Add replay ${replay.match.id}`], { cwd: seed });
  }
  if (size > newMatches) await execute('git', ['push', bare, 'main'], { cwd: seed });
  let lastPhase = null, lastPhaseAt = 0;
  options.onValidation = record => {
    metrics.validation_calls++; metrics.semantic_checked += record.checked; metrics.semantic_reused += record.reused;
  };
  options.onProgress = event => {
    const at = performance.now();
    if (lastPhase) increment(metrics.phase_ms, lastPhase, at - lastPhaseAt);
    lastPhase = event.phase; lastPhaseAt = at;
  };
  options.runCommand = async (file, command, settings = {}) => {
    if (file === 'gh') {
      assert.deepEqual(command.slice(0, 3), ['repo', 'view', repo]);
      let hasHead = true;
      try { await execute('git', ['--git-dir', bare, 'rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
      return JSON.stringify({ nameWithOwner: repo, visibility: 'PRIVATE', url: `https://github.com/${repo}`, defaultBranchRef: hasHead ? { name: 'main' } : null });
    }
    assert.equal(file, 'git'); const name = gitCommand(command);
    const network = ['fetch', 'push'].includes(name);
    if (network) {
      const urls = await execute('git', ['remote', 'get-url', '--all', ...(name === 'push' ? ['--push'] : []), 'origin'], settings);
      assert.equal(String(urls).trim(), remoteUrl, 'forbid every unexpected transport target');
    }
    const routed = network ? ['-c', `url.${bare}.insteadOf=${remoteUrl}`, ...command] : command;
    const start = performance.now();
    const output = await execute(file, routed, settings);
    if (active) {
      increment(metrics.git_commands, name); metrics.git_stdout_bytes += Buffer.byteLength(output);
      metrics.git_stdin_bytes += settings.input ? Buffer.byteLength(settings.input) : 0;
      if (name === 'cat-file' && command.includes('--batch')) countObjects(output);
      commandRecords.push({ command: name, args: command, stdin_bytes: settings.input ? Buffer.byteLength(settings.input) : 0,
        stdout_bytes: Buffer.byteLength(output), elapsed_ms: performance.now() - start });
    }
    return output;
  };
  await configureCoachSync(repo, options); await archiveReplays(replays, options);
  const eventLoop = monitorEventLoopDelay({ resolution: 5 }); eventLoop.enable();
  await new Promise(yes => setTimeout(yes, 10));
  active = true; const start = performance.now();
  const result = await syncReplayHistory(options);
  const elapsed = performance.now() - start;
  if (lastPhase) increment(metrics.phase_ms, lastPhase, performance.now() - lastPhaseAt);
  active = false; await new Promise(yes => setTimeout(yes, 10)); eventLoop.disable();
  assert.equal(result.status, 'succeeded'); assert.equal(result.published, newMatches); assert.equal(result.github_matches, size);
  assert.equal(metrics.external_fetch_calls, 0);
  const remoteIndex = JSON.parse(await execute('git', ['--git-dir', bare, 'show', 'HEAD:index.json']));
  assert.equal(remoteIndex.matches.length, size); assert.equal(new Set(remoteIndex.matches.map(item => item.match_id)).size, size);
  const output = { source, size, new_matches: newMatches, previous_matches: size - newMatches, prefilled_metadata_files: cacheCards,
    fixture: '8 public known cards per replay; one short action; one commit per pre-existing replay; no real card DB or external network',
    utc: new Date().toISOString(), elapsed_ms: elapsed, event_loop_max_ms: eventLoop.max / 1e6, event_loop_p99_ms: eventLoop.percentile(99) / 1e6,
    ...metrics, unique_git_objects_read: objectReads.size, maximum_reads_of_one_object: Math.max(0, ...objectReads.values()),
    result: { status: result.status, published: result.published, local_matches: result.local_matches, github_matches: result.github_matches,
      failed: result.failed, timings_ms: result.timings_ms }, command_records: commandRecords };
  if (args.output) { await fs.mkdir(dirname(resolve(args.output)), { recursive: true }); await fs.writeFile(resolve(args.output), JSON.stringify(output, null, 2) + '\n'); }
  console.log(JSON.stringify({ ...output, command_records: undefined }));
} finally {
  active = false;
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
}
