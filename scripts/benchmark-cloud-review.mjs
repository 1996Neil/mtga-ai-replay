// Local-only fresh-process benchmark. The fixture manifest supplies a private
// read-only replay copy and a temporary bare repository. No GitHub request or
// original database is touched. Run separately from other regression tests.
import { readFile, mkdir, copyFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createCloudReviewReader } from '../src/review/review-sync.mjs';
import { startReplayServer } from '../src/server.mjs';

const [fixturePath, outputDirectory, mode = 'measure'] = process.argv.slice(2);
if (!fixturePath || !outputDirectory || !['measure', 'ui'].includes(mode)) throw Error('Supply a private fixture manifest, NEW output directory and measure|ui mode.');
const fixture = JSON.parse(await readFile(resolve(fixturePath)));
if (fixture.repository !== 'fixture-owner/private-coaching' || fixture.branch !== 'main' || !(await lstat(fixture.bare)).isDirectory()) throw Error('Only the local synthetic-origin routing fixture is supported.');
const dataDir = resolve(outputDirectory); await mkdir(dataDir, { mode: 0o700 }); await mkdir(join(dataDir, 'coach-sync'), { mode: 0o700 });
await copyFile(join(fixture.dataDir, 'coach-sync/state.json'), join(dataDir, 'coach-sync/state.json'));
const replay = JSON.parse(await readFile(fixture.replayFile)), id = replay.match.id;
const execute = (file, args, settings = {}) => new Promise((yes, no) => {
  const child = execFile(file, args, { ...settings, timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...settings.env } }, (error, stdout) => error ? no(Error('Local benchmark command failed')) : yes(stdout));
  child.stdin.on('error', no); child.stdin.end(settings.input);
});
const runCommand = async (file, args, settings = {}) => {
  if (file === 'gh') {
    if (JSON.stringify(args) !== JSON.stringify(['repo', 'view', fixture.repository, '--json', 'nameWithOwner,visibility,url,defaultBranchRef'])) throw Error('Benchmark forbids network API operations.');
    return JSON.stringify({ nameWithOwner: fixture.repository, visibility: 'PRIVATE', url: `https://github.com/${fixture.repository}`, defaultBranchRef: { name: fixture.branch } });
  }
  if (file !== 'git' || args.includes('push')) throw Error('Benchmark is read-only.');
  const network = args.includes('fetch') || args.includes('ls-remote');
  if (network) {
    const url = String(await execute('git', ['remote', 'get-url', '--all', 'origin'], { cwd: settings.cwd, encoding: 'utf8' })).trim();
    if (url !== `https://github.com/${fixture.repository}.git`) throw Error('Unapproved benchmark destination.');
  }
  return execute(file, network ? ['-c', `url.${fixture.bare}.insteadOf=https://github.com/${fixture.repository}.git`, ...args] : args, settings);
};
const reader = createCloudReviewReader({ dataDir, runCommand, loadReplay: async matchId => matchId === id ? replay : null });
const runtime = await startReplayServer({ dataDir, port: 57020, writeInfo: false, displayNamesZh: new Map(), includeLocalHistory: false,
  observeLocalLogs: false, enableReplaySync: false, enableCollection: false, reviewReader: reader,
  fetchFn: async () => new Response(null, { status: 503 }), replayProvider: {
    list: async () => [{ ...replay.match, step_count: replay.games[0].steps.length }], get: async matchId => matchId === id ? replay : null, latest: async () => replay } });
await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ pid: process.pid, url: runtime.url + '?match=' + id }), { mode: 0o600 });
console.log(JSON.stringify({ stage: 'server-ready', mode, port: 57020, actions: replay.games[0].steps.length }));
if (mode === 'ui') {
  // A local operator creates this file after the page has loaded. The browser
  // still starts the actual same-origin review/sync request via its own button.
  while (true) { try { await lstat(join(dataDir, 'measure.start')); break; } catch { await new Promise(done => setTimeout(done, 200)); } }
}
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
// The probe has its own event loop: an in-process timer would stop scheduling
// requests during precisely the server stalls this benchmark must observe.
const probeCode = `import {readFileSync} from 'node:fs';import{performance}from'node:perf_hooks';
const {url}=JSON.parse(readFileSync(0,'utf8'));let stop=false;process.on('SIGTERM',()=>{stop=true;});const samples=[];
while(!stop){const start=performance.now();try{const r=await fetch(url+'api/health',{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error();samples.push(performance.now()-start);}catch{samples.push(null);}await new Promise(r=>setTimeout(r,100));}
console.log(JSON.stringify(samples));`;
let probeChild;
const probe = new Promise((yes, no) => {
  probeChild = execFile(process.execPath, ['--input-type=module', '-e', probeCode], { encoding: 'utf8' }, (error, stdout) => {
    if (error) return no(Error('External health probe failed'));
    try { yes(JSON.parse(stdout)); } catch { no(Error('External health probe failed')); }
  });
  probeChild.stdin.end(JSON.stringify({ url: runtime.url }));
});
await new Promise(done => setTimeout(done, 200));
let peak = process.memoryUsage().rss; const before = peak, cpu = process.cpuUsage(), start = performance.now();
const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
if (mode === 'measure') reader.start(id, 1);
else while ((await reader.read(id, 1)).status !== 'syncing') await new Promise(done => setTimeout(done, 50));
await reader.wait(); const state = await reader.read(id, 1); probeChild.kill('SIGTERM'); const probes = await probe;
clearInterval(sample); peak = Math.max(peak, process.memoryUsage().rss); loop.disable();
const used = process.cpuUsage(cpu), good = probes.filter(value => value !== null).sort((a, b) => a - b);
const result = { actions: replay.games[0].steps.length, status: state.status, notes: state.review?.notes.length ?? 0,
  wall_ms: +(performance.now() - start).toFixed(1), node_cpu_ms: +((used.user + used.system) / 1000).toFixed(1),
  node_rss_before_mb: +(before / 1048576).toFixed(1), node_rss_peak_mb: +(peak / 1048576).toFixed(1),
  node_rss_after_mb: +(process.memoryUsage().rss / 1048576).toFixed(1),
  event_loop_max_ms: +(loop.max / 1e6).toFixed(1), event_loop_p99_ms: +(loop.percentile(99) / 1e6).toFixed(1),
  health_probes: probes.length, health_failures: probes.length - good.length, health_p95_ms: +(good[Math.floor(good.length * .95)] ?? 0).toFixed(1),
  health_max_ms: +(good.at(-1) ?? 0).toFixed(1), transport: 'local bare Git, fresh process and cache', paid_model_calls: 0, production_data_writes: 0 };
await writeFile(join(dataDir, 'performance.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result));
if (state.status !== 'ready') { await runtime.close(); throw Error('Benchmark did not complete a valid cloud sync.'); }
if (mode === 'ui') { for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await runtime.close(); process.exit(0); }); }
else await runtime.close();
