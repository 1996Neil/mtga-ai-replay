/** Serial five-pair A/B runner; no models, real remotes, or explicit GC. */
import { mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, release } from 'node:os';
import { createHash } from 'node:crypto';
const args = Object.fromEntries(process.argv.slice(2).map(v => { const i = v.indexOf('='); return [v.slice(2, i), v.slice(i + 1)]; }));
if (!args.fixture || !args.baseline || !args.candidate || !args.output) throw Error('Explicit frozen fixture, baseline, candidate and NEW output required');
const baseline = await realpath(resolve(args.baseline)), candidate = await realpath(resolve(args.candidate)), output = join(await realpath(dirname(resolve(args.output))), basename(resolve(args.output)));
if ([baseline, candidate].some(root => output === root || output.startsWith(root + sep))) throw Error('Private measurement output must be outside source checkouts');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (command, cwd = baseline) => execFileSync('git', command, { cwd, env, encoding: 'utf8' }).trim();
const commit = git(['rev-parse', 'HEAD']);
if (commit !== 'bf70d7934e9aa5d3b9c06f93b41b335f0697525b') throw Error('P2 baseline must be exact PR7 commit');
if (git(['status', '--porcelain', '--untracked-files=no'])) throw Error('Baseline tracked worktree must be clean');
async function manifest(root) {
  const entries = {};
  async function walk(path) { for (const item of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, item.name); if (item.isSymbolicLink()) throw Error('Runtime source must not contain symlinks');
    if (item.isDirectory()) await walk(child); else entries[child] = createHash('sha256').update(await readFile(join(root, child))).digest('hex');
  } }
  await walk('src'); await walk('schemas');
  for (const path of ['package.json', 'package-lock.json']) entries[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  return entries;
}
const sources = { A: await manifest(baseline), B: await manifest(candidate) };
await mkdir(output, { mode: 0o700 });
const fixture = JSON.parse(await readFile(resolve(args.fixture)));
if (fixture.repository !== 'fixture-owner/private-coaching') throw Error('Only local synthetic fixture accepted');
const fixtureRoot = await realpath(dirname(resolve(args.fixture)));
for (const path of [fixture.bare, fixture.dataDir]) if (!(await realpath(path)).startsWith(fixtureRoot + sep)) throw Error('Fixture paths must remain inside their private root');
const inputSha = createHash('sha256').update(await readFile(fixture.replayFile)).digest('hex');
const remoteRevision = git(['--git-dir', fixture.bare, 'rev-parse', 'HEAD']);
const samples = [], harness = join(dirname(fileURLToPath(import.meta.url)), 'profile-cloud-memory.mjs');
for (let pair = 1; pair <= 5; pair++) for (const arm of pair % 2 ? ['A', 'B'] : ['B', 'A']) {
  const name = `pair-${pair}-${arm}`;
  console.log(JSON.stringify({ starting: name }));
  let log = '';
  const code = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [harness, `--fixture=${resolve(args.fixture)}`, `--source=${arm === 'A' ? baseline : candidate}`, `--output=${join(output, name)}`, '--settle=60'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    child.on('error', no); child.on('exit', yes);
  });
  await writeFile(join(output, name + '.txt'), log);
  if (code !== 0) throw Error(`Measurement ${name} failed; retain evidence, do not substitute a selected rerun`);
  const metrics = JSON.parse(await readFile(join(output, name, 'metrics.json')));
  samples.push({ pair, arm, ...metrics });
  await writeFile(join(output, 'all-samples.json'), JSON.stringify({ baseline: commit, runtime_source_manifests: sources, input_sha256: inputSha, remote_revision: remoteRevision,
    environment: { node: process.version, platform: process.platform, arch: process.arch, os: release(), cpu: cpus()[0].model, logical_cpus: cpus().length, memory_bytes: totalmem() }, samples }, null, 2) + '\n');
  console.log(JSON.stringify({ finished: name, wall_ms: metrics.wall_ms, peak_mib: metrics.node_peak_rss / 1048576 }));
}
if (JSON.stringify(sources) !== JSON.stringify({ A: await manifest(baseline), B: await manifest(candidate) })) throw Error('Runtime sources changed during experiment');
if (createHash('sha256').update(await readFile(fixture.replayFile)).digest('hex') !== inputSha || git(['--git-dir', fixture.bare, 'rev-parse', 'HEAD']) !== remoteRevision) throw Error('Frozen input changed during experiment');
