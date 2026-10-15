/** Offline experiment only. Reads explicitly supplied copies; creates a NEW
 * local bare fixture. Never contacts GitHub or writes the input data. */
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const args = Object.fromEntries(process.argv.slice(2).map(v => { const i = v.indexOf('='); return [v.slice(2, i), v.slice(i + 1)]; }));
if (!args.replay || !args.cards || !args.source || !args.output) throw Error('Explicit private replay, cards, source and NEW output required');
const root = join(await realpath(dirname(resolve(args.output))), basename(resolve(args.output))), source = await realpath(resolve(args.source));
if (root === source || root.startsWith(source + sep)) throw Error('Private fixture output must be outside the source checkout');
const { buildCoachBundle, serializeCoachJson } = await import(pathToFileURL(join(source, 'src/coach-bundle.mjs')));
const { visibleCardNames } = await import(pathToFileURL(join(source, 'src/review/review-model.mjs')));
const replayFile = resolve(args.replay), replay = JSON.parse(await readFile(replayFile)), cards = JSON.parse(await readFile(resolve(args.cards)));
const bundle = await buildCoachBundle(replay, { cards, multipart: true, generatedAt: '2026-10-15T00:00:00.000Z' });
const files = new Map([['index.json', serializeCoachJson({ schema: 'MTGA_COACH_INDEX_V1', matches: [{ match_id: replay.match.id, history_key: bundle.historyKey, path: `matches/${bundle.historyKey}`, content_hash: bundle.contentHash }] })]]);
for (const name of ['summary', 'coach', 'cards', 'manifest']) files.set(`matches/${bundle.historyKey}/${name}.json`, serializeCoachJson(bundle[name]));
for (const [path, value] of bundle.parts) files.set(path, serializeCoachJson(value));
const fingerprints = Object.fromEntries([...files].map(([p, v]) => [p, createHash('sha256').update(v).digest('hex')]));
if (args.compare) {
  const expected = JSON.parse(await readFile(resolve(args.compare)));
  if (JSON.stringify(fingerprints) !== JSON.stringify(expected)) throw Error('Baseline byte fingerprints differ');
  console.log(JSON.stringify({ actions: bundle.summary.actions, exact_bundle_bytes: true }));
  process.exit(0);
}
await mkdir(root, { mode: 0o700 });
const seed = join(root, 'seed'), bare = join(root, 'remote.git'), dataDir = join(root, 'data');
await mkdir(seed); await mkdir(join(dataDir, 'coach-sync'), { recursive: true });
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const env = { ...cleanEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'mtga-replay-coach', GIT_AUTHOR_EMAIL: 'mtga-replay-coach@users.noreply.github.com', GIT_COMMITTER_NAME: 'mtga-replay-coach', GIT_COMMITTER_EMAIL: 'mtga-replay-coach@users.noreply.github.com', GIT_AUTHOR_DATE: '2026-10-15T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T00:00:00Z' };
const git = (command, cwd = seed) => execFileSync('git', command, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
git(['init', '-b', 'main']); git(['init', '--bare', '-b', 'main', bare]);
for (const [path, value] of files) { await mkdir(join(seed, path, '..'), { recursive: true }); await writeFile(join(seed, path), value); }
git(['add', '--all']); git(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Synthetic offline source']);
const revision = git(['rev-parse', 'HEAD']), game = replay.games[0];
const points = [];
for (const boundary of ['before', 'after']) {
  const step = game.steps.find(s => {
    const state = boundary === 'before' ? s.state_before ?? game.states?.[s.before_state_id] : s.state ?? game.states?.[s.state_id];
    return state && !points.some(p => p.anchor === s.anchor) && visibleCardNames(state).size;
  });
  if (!step) throw Error('Real copy lacks distinct visible before/after anchors');
  const state = boundary === 'before' ? step.state_before ?? game.states?.[step.before_state_id] : step.state ?? game.states?.[step.state_id];
  points.push({ anchor: step.anchor, boundary, cards: [[...visibleCardNames(state)][0]] });
}
const report = JSON.parse(await readFile(join(source, 'examples/cloud-review/ready-v2.json')));
Object.assign(report, { match_id: replay.match.id, source_content_hash: bundle.contentHash });
report.provenance.source_revision = revision;
report.coverage.actions_total = game.steps.length; report.coverage.states_resolved = Object.keys(game.states).length;
report.coverage.inspected = points.map(({ anchor, boundary }) => ({ anchor, boundary }));
report.notes = points.map(point => ({ ...report.notes[0], ...point, observation: '这是隔离回归的合成记录。' }));
const reviewPath = `reviews/${replay.match.id}/game-1.json`;
await mkdir(join(seed, reviewPath, '..'), { recursive: true }); await writeFile(join(seed, reviewPath), serializeCoachJson(report));
git(['add', '--all']); git(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Synthetic V2 before and after review']); git(['push', bare, 'main']);
await writeFile(join(dataDir, 'coach-sync/state.json'), JSON.stringify({ schema: 'MTGA_LOCAL_SYNC_V1', enabled: true, repository: 'fixture-owner/private-coaching', pending: [], synced: { [replay.match.id]: { content_hash: bundle.contentHash, history_key: bundle.historyKey, started_at: replay.match.started_at } } }));
await writeFile(join(root, 'bundle-fingerprints.json'), JSON.stringify(fingerprints));
await writeFile(join(root, 'fixture.json'), JSON.stringify({ repository: 'fixture-owner/private-coaching', branch: 'main', bare, dataDir, replayFile, seed, reviewPath }));
console.log(JSON.stringify({ actions: bundle.summary.actions, states: bundle.summary.states, parts: bundle.parts.size, fixture_ready: true }));
