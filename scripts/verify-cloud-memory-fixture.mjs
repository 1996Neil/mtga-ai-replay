/** Read-only replay-copy regression against a NEW disposable local repository.
 * All writes are confined to the explicit fixture/output directories. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
const args = Object.fromEntries(process.argv.slice(2).map(v => { const i = v.indexOf('='); return [v.slice(2, i), v.slice(i + 1)]; }));
if (!args.fixture || !args.source || !args.output) throw Error('Explicit fixture, source and NEW output required');
const fixture = JSON.parse(await readFile(resolve(args.fixture))), root = join(await realpath(dirname(resolve(args.output))), basename(resolve(args.output))), source = await realpath(resolve(args.source));
if (root === source || root.startsWith(source + sep)) throw Error('Private regression output must be outside the source checkout');
assert.equal(fixture.repository, 'fixture-owner/private-coaching'); assert.equal(fixture.branch, 'main');
const fixtureRoot = await realpath(dirname(resolve(args.fixture)));
for (const path of [fixture.seed, fixture.bare, fixture.dataDir]) assert.ok((await realpath(path)).startsWith(fixtureRoot + sep), 'fixture writes must stay inside its private root');
assert.equal(fixture.reviewPath, `reviews/${replayIdFromPath(fixture.reviewPath)}/game-1.json`);
function replayIdFromPath(path) { const match = /^reviews\/([A-Za-z0-9_-]+)\/game-1\.json$/.exec(path); assert.ok(match); return match[1]; }
await mkdir(root, { mode: 0o700 }); const dataDir = join(root, 'data'); await mkdir(join(dataDir, 'coach-sync'), { recursive: true });
await copyFile(join(fixture.dataDir, 'coach-sync/state.json'), join(dataDir, 'coach-sync/state.json'));
const replay = JSON.parse(await readFile(fixture.replayFile)), id = replay.match.id, results = [];
assert.equal(id, replayIdFromPath(fixture.reviewPath));
const control = { offline: false, crash: null, gate: null }; const workers = [];
const Original = workerThreads.Worker;
class ObservedWorker extends Original {
  constructor(...values) { super(...values); workers.push(this); }
  postMessage(message, ...rest) { if (control.crash === message.operation) { control.crash = null; void this.terminate(); return; } return super.postMessage(message, ...rest); }
}
workerThreads.Worker = ObservedWorker; syncBuiltinESMExports();
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const env = { ...cleanEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'mtga-replay-coach', GIT_AUTHOR_EMAIL: 'mtga-replay-coach@users.noreply.github.com', GIT_COMMITTER_NAME: 'mtga-replay-coach', GIT_COMMITTER_EMAIL: 'mtga-replay-coach@users.noreply.github.com' };
const execute = (file, command, settings = {}) => new Promise((yes, no) => {
  const child = execFile(file, command, { ...settings, env: { ...env, ...settings.env }, encoding: settings.encoding ?? 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 }, (e, out) => e ? no(Error('Offline fixture command failed')) : yes(out));
  child.stdin.on('error', no); child.stdin.end(settings.input);
});
const runCommand = async (file, command, settings = {}) => {
  if (file === 'gh') {
    assert.deepEqual(command, ['repo', 'view', fixture.repository, '--json', 'nameWithOwner,visibility,url,defaultBranchRef']);
    await control.gate;
    if (control.offline) throw Error('Synthetic interrupted connection');
    return JSON.stringify({ nameWithOwner: fixture.repository, visibility: 'PRIVATE', url: `https://github.com/${fixture.repository}`, defaultBranchRef: { name: 'main' } });
  }
  assert.equal(file, 'git'); assert.ok(!command.includes('push'), 'reader must remain fetch-only');
  const network = command.includes('fetch') || command.includes('ls-remote');
  if (network) assert.equal(String(await execute('git', ['remote', 'get-url', '--all', 'origin'], { cwd: settings.cwd })).trim(), `https://github.com/${fixture.repository}.git`);
  return execute(file, network ? ['-c', `url.${fixture.bare}.insteadOf=https://github.com/${fixture.repository}.git`, ...command] : command, settings);
};
const { createCloudReviewReader } = await import(pathToFileURL(join(source, 'src/review/review-sync.mjs')));
const reader = createCloudReviewReader({ dataDir, runCommand, loadReplay: async match => match === id ? replay : null });
const record = (name, state, expected) => { assert.equal(state.status, expected, name); results.push({ name, status: state.status, offline: state.offline === true }); return state; };
const sync = async name => { assert.equal(reader.start(id, 1).code, 202); await reader.wait(); return record(name, await reader.read(id, 1), 'ready'); };
try {
  const first = await sync('cold-ready');
  assert.equal(first.review.cloud_schema, 'MTGA_AI_REVIEW_V2'); assert.equal(first.review.notes.length, 2);
  const report = JSON.parse(await readFile(join(fixture.seed, fixture.reviewPath)));
  for (const [i, note] of first.review.notes.entries()) {
    assert.equal(note.anchor, report.notes[i].anchor); assert.equal(note.boundary, report.notes[i].boundary);
    assert.deepEqual(note.cards, report.notes[i].cards); assert.ok(note.cards.length);
    assert.equal(note.importance, 'critical'); assert.equal(note.assessment, 'possible_error'); assert.equal(note.confidence, 'low'); assert.equal(note.severity, 'tip');
  }
  results.push({ name: 'before-after-English-V2', status: 'passed' });
  for (let i = 0; i < 3; i++) record(`warm-${i + 1}`, await reader.read(id, 1), 'ready');
  if (args.repeat === '3') for (let i = 2; i <= 3; i++) await sync(`repeat-sync-${i}`);
  const original = replay.games[0].result.reason;
  replay.games[0].result.reason = 'Synthetic in-memory local update';
  record('local-update-invalidates', await reader.read(id, 1), 'stale');
  if (original === undefined) delete replay.games[0].result.reason; else replay.games[0].result.reason = original;
  record('restored-copy-ready', await reader.read(id, 1), 'ready');
  if (args.faults === 'true') {
    control.offline = true; reader.start(id, 1); await reader.wait();
    const offline = record('network-interrupted-cache', await reader.read(id, 1), 'ready'); assert.equal(offline.offline, true); control.offline = false;
    control.crash = 'cloudReviewSource'; reader.start(id, 1); await reader.wait();
    const failed = record('worker-failure-cache', await reader.read(id, 1), 'ready'); assert.equal(failed.offline, true);
    const git = command => execute('git', command, { cwd: fixture.seed });
    const commit = async message => { await git(['add', '--all']); await git(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', message]); await git(['push', fixture.bare, 'main']); };
    // Mutate ONLY this disposable source fixture; the frozen input stays read-only.
    const { buildCoachBundle, serializeCoachJson } = await import(pathToFileURL(join(source, 'src/coach-bundle.mjs')));
    const state = JSON.parse(await readFile(join(dataDir, 'coach-sync/state.json')));
    const prefix = `matches/${state.synced[id].history_key}`;
    const cards = JSON.parse(await readFile(join(fixture.seed, prefix, 'cards.json')));
    const digest = value => createHash('sha256').update(value).digest('hex');
    const localBefore = digest(JSON.stringify(replay)), stateBefore = digest(await readFile(join(dataDir, 'coach-sync/state.json')));
    const remoteReplay = structuredClone(replay);
    remoteReplay.games[0].result.reason = 'Synthetic remote source update';
    const updated = await buildCoachBundle(remoteReplay, { cards, multipart: true, generatedAt: '2026-10-15T00:00:00.000Z' });
    assert.notEqual(updated.contentHash, report.source_content_hash);
    const index = JSON.parse(await readFile(join(fixture.seed, 'index.json'))); index.matches[0].content_hash = updated.contentHash;
    await writeFile(join(fixture.seed, 'index.json'), serializeCoachJson(index));
    for (const name of ['summary', 'coach', 'cards', 'manifest']) await writeFile(join(fixture.seed, prefix, `${name}.json`), serializeCoachJson(updated[name]));
    for (const [path, value] of updated.parts) await writeFile(join(fixture.seed, path), serializeCoachJson(value));
    await commit('Synthetic updated source preserves old review');
    reader.start(id, 1); await reader.wait(); record('remote-update-invalidates', await reader.read(id, 1), 'stale');
    assert.equal(digest(JSON.stringify(replay)), localBefore); assert.equal(digest(await readFile(join(dataDir, 'coach-sync/state.json'))), stateBefore);
    results.push({ name: 'remote-only-update-local-replay-and-upload-state-unchanged', status: 'passed' });
    await rm(join(fixture.seed, fixture.reviewPath)); await commit('Synthetic missing review');
    reader.start(id, 1); await reader.wait(); record('no-review', await reader.read(id, 1), 'missing');
    // A historical V1 report still passes the full updated-source binding.
    report.schema = 'MTGA_AI_REVIEW_V1'; report.source_content_hash = updated.contentHash;
    report.provenance.source_revision = String(await git(['rev-parse', 'HEAD'])).trim();
    for (const note of report.notes) { delete note.importance; delete note.assessment; note.severity = 'tip'; }
    await writeFile(join(fixture.seed, fixture.reviewPath), serializeCoachJson(report)); await commit('Synthetic V1 compatibility');
    state.synced[id].content_hash = updated.contentHash; await writeFile(join(dataDir, 'coach-sync/state.json'), JSON.stringify(state));
    replay.games[0].result.reason = remoteReplay.games[0].result.reason;
    const v1 = await sync('V1-compatible'); assert.equal(v1.review.cloud_schema, 'MTGA_AI_REVIEW_V1'); assert.equal(v1.review.notes.length, 2);
    let release; control.gate = new Promise(done => { release = done; });
    assert.equal(reader.start(id, 1).code, 202); assert.equal(reader.start(id, 1).code, 202); assert.equal(reader.start(id, 2).code, 409);
    const closing = reader.close(); release(); await closing; assert.equal(reader.start(id, 1).code, 503);
    results.push({ name: 'concurrency-and-close', status: 'passed' });
  }
} finally { await reader.close(); workerThreads.Worker = Original; syncBuiltinESMExports(); }
assert.ok(workers.every(worker => worker.threadId === -1));
results.push({ name: 'all-worker-heaps-exited', status: 'passed', count: workers.length });
const summary = { actions: replay.games.reduce((n, g) => n + g.steps.length, 0), results };
await writeFile(join(root, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
