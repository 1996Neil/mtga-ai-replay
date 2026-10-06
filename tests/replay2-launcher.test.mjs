import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createLauncher, requestJSON } from '../tools/replay2-launcher/launcher.mjs';
import { install, commandText } from '../tools/replay2-launcher/install.mjs';

const pause = ms => new Promise(done => setTimeout(done, ms));
async function freePort() {
  const s = http.createServer();
  await new Promise(done => s.listen(0, '127.0.0.1', done));
  const port = s.address().port;
  await new Promise(done => s.close(done));
  return port;
}
const fixture = `import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const argv=process.argv.slice(2), at=flag=>argv[argv.indexOf(flag)+1];
if (argv.includes('--fail')) process.exit(17);
if (!argv.includes('--offline') || !argv.includes('--no-open') || at('--mode') !== 'replay') throw Error('unsafe launch');
appendFileSync(join(process.cwd(),'starts.txt'),JSON.stringify(argv)+'\\n');
let enabled=argv.includes('--active'),muted=!enabled;
const port=Number(at('--port'));
const s=http.createServer((req,res)=>{
 res.setHeader('Content-Type','application/json');
 if(req.url==='/api/health') res.end(JSON.stringify({service:'mtga-gpt-replay',port,pid:process.pid,capabilities:['live-coach']}));
 else if(req.url==='/api/live-coach/status') res.end(JSON.stringify({enabled,muted,source_mode:'replay'}));
 else if(req.url==='/api/live-coach/stop' && req.method==='POST' && req.headers.origin==='http://127.0.0.1:'+port && req.headers['x-mtga-coach-action']==='session') {enabled=false;muted=true;res.end('{}');}
 else {res.statusCode=403;res.end('{}');}
});
s.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>s.close(()=>process.exit(0)));
`;
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'replay2-launcher-'));
  const root = join(dir, 'project with spaces');
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'viewer/dist'), { recursive: true });
  await writeFile(join(root, 'viewer/dist/index.html'), '<p>Fixture</p>');
  await writeFile(join(root, 'bin/mtga-gpt-replay.mjs'), fixture);
  const port = await freePort();
  const opened = [];
  const launcher = createLauncher({ projectRoot: root, port, stateDir: join(dir, 'state'),
    timeoutMs: 4000, openBrowser: async url => opened.push(url), ...options });
  t.after(async () => { await launcher.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return { launcher, root, dir, port, opened };
}

test('cold start, repeat, stop, and reopen preserve standby and launch once', async t => {
  const { launcher, root, opened } = await setup(t);
  const first = await launcher.start();
  assert.equal(first.reused, false);
  assert.equal(first.enabled, false); assert.equal(first.muted, true);
  const second = await launcher.start();
  assert.equal(second.pid, first.pid); assert.equal(second.reused, true);
  assert.equal((await readFile(join(root, 'starts.txt'), 'utf8')).trim().split('\n').length, 1);
  assert.equal(opened.length, 2);
  assert.equal((await launcher.stop()).stopped, true);
  assert.equal((await launcher.status()).running, false);
  const next = await launcher.start();
  assert.notEqual(next.pid, first.pid);
});

test('simultaneous clicks serialize to one service', async t => {
  const { launcher, root } = await setup(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => launcher.start({ openPage: false })));
  assert.equal(new Set(results.map(x => x.pid)).size, 1);
  assert.equal((await readFile(join(root, 'starts.txt'), 'utf8')).trim().split('\n').length, 1);
});

test('multiple independent launchers recover one stale lock without deleting a new lock', async t => {
  const { root, dir, port } = await setup(t);
  await mkdir(join(dir, 'state/launcher.lock'), { recursive: true });
  await writeFile(join(dir, 'state/launcher.lock/owner.json'), JSON.stringify({ pid: 2147483647, token: 'stale' }));
  const launchers = Array.from({ length: 8 }, () => createLauncher({ projectRoot: root, port, stateDir: join(dir, 'state'), openBrowser: async () => {} }));
  const results = await Promise.all(launchers.map(x => x.start({ openPage: false })));
  assert.equal(new Set(results.map(x => x.pid)).size, 1);
  assert.equal((await readFile(join(root, 'starts.txt'), 'utf8')).trim().split('\n').length, 1);
});

test('reuse external service, reset active coach, and stop without killing foreign owner', async t => {
  const { launcher, root, port } = await setup(t);
  const cli = join(root, 'bin/mtga-gpt-replay.mjs');
  const child = spawn(process.execPath, [cli, 'live-coach', 'serve', '--offline', '--no-open', '--mode', 'replay', '--port', String(port), '--active'], { cwd: root, stdio: 'ignore' });
  t.after(async () => { child.kill('SIGTERM'); await new Promise(done => child.exitCode !== null ? done() : child.once('exit', done)); });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { try { ready = Boolean(await requestJSON(`http://127.0.0.1:${port}/api/health`)); } catch { await pause(50); } }
  assert.equal(ready, true);
  const result = await launcher.start({ openPage: false });
  assert.equal(result.pid, child.pid); assert.equal(result.reused, true);
  const state = await launcher.status();
  assert.equal(state.enabled, false); assert.equal(state.muted, true);
  assert.equal((await launcher.stop()).stopped, false);
  assert.equal((await launcher.status()).running, true);
});

test('occupied port fails clearly without opening or terminating server', async t => {
  const { launcher, port, opened } = await setup(t);
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ service: 'other' })); });
  await new Promise(done => server.listen(port, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  await assert.rejects(launcher.start(), /被其他服务占用/);
  assert.equal(opened.length, 0); assert.equal(server.listening, true);
});

test('failed process reports local log and never retries', async t => {
  const { launcher, root, opened } = await setup(t, { extraArgs: ['--fail'] });
  await assert.rejects(launcher.start(), /启动失败.*日志/);
  assert.equal(opened.length, 0);
  await assert.rejects(access(join(root, 'starts.txt')));
});

test('missing Viewer reports requirement and does not install or start', async t => {
  const { launcher, root } = await setup(t);
  await rm(join(root, 'viewer/dist/index.html'));
  await assert.rejects(launcher.start(), /构建缺失.*不会自动安装/);
  await assert.rejects(access(join(root, 'starts.txt')));
});

test('stale launcher lock recovers but live lock times out safely', async t => {
  const { launcher, dir } = await setup(t, { timeoutMs: 600 });
  await mkdir(join(dir, 'state/launcher.lock'), { recursive: true });
  await writeFile(join(dir, 'state/launcher.lock/owner.json'), JSON.stringify({ pid: 2147483647 }));
  await launcher.start({ openPage: false });
  await mkdir(join(dir, 'state/launcher.lock'));
  await writeFile(join(dir, 'state/launcher.lock/owner.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(launcher.start(), /另一个.*尚未结束/);
  await rm(join(dir, 'state/launcher.lock'), { recursive: true });
});

test('orphaned reaper is bounded and produces a clear failure', async t => {
  const { launcher, dir } = await setup(t, { timeoutMs: 400 });
  await mkdir(join(dir, 'state/launcher.lock'), { recursive: true });
  await writeFile(join(dir, 'state/launcher.lock/owner.json'), JSON.stringify({ pid: 2147483647 }));
  await writeFile(join(dir, 'state/launcher.lock/reaper'), '');
  const before = Date.now();
  await assert.rejects(launcher.start(), /另一个.*尚未结束/);
  assert.ok(Date.now() - before < 2000);
  await rm(join(dir, 'state/launcher.lock'), { recursive: true });
});

test('installer quotes spaces/apostrophes and preserves unrelated desktop entries', async t => {
  const { dir } = await setup(t);
  const desktop = join(dir, 'Desktop');
  const cli = join(dir, "O'Brien launch.mjs");
  await writeFile(cli, '');
  await install({ desktop, launcherPath: cli });
  const start = await readFile(join(desktop, 'Replay 2.0.command'), 'utf8');
  assert.ok(start.includes("O'\\''Brien"));
  assert.ok(start.includes("'start'"));
  assert.ok((await readFile(join(desktop, '停止 Replay 2.0.command'), 'utf8')).includes("'stop'"));
  await writeFile(join(desktop, '停止 Replay 2.0.command'), 'unrelated user file');
  const before = await readFile(join(desktop, 'Replay 2.0.command'), 'utf8');
  await assert.rejects(install({ desktop, launcherPath: cli }), /保留现有同名文件/);
  assert.equal(await readFile(join(desktop, 'Replay 2.0.command'), 'utf8'), before);
  assert.equal(await readFile(join(desktop, '停止 Replay 2.0.command'), 'utf8'), 'unrelated user file');
  assert.ok(commandText('/node', cli, 'start').includes('read -r response'));
});
