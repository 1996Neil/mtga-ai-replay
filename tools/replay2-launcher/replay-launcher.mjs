import { access, chmod, mkdir, readFile, rm, stat, writeFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const pause = ms => new Promise(done => setTimeout(done, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function requestJSON(url, method = 'GET') {
  return new Promise((done, reject) => {
    let req, deadline, settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req?.setTimeout(0);
      if (error) reject(error); else done(value);
    };
    const fail = error => { settle(error); req.destroy(error); };
    req = http.request(url, { method, headers: method === 'POST' ? {
      Origin: new URL(url).origin, 'Content-Type': 'application/json'
    } : {} }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 131072) fail(new Error('本地服务响应过大。'));
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`本地服务返回 HTTP ${response.statusCode}。`);
          settle(null, JSON.parse(text));
        } catch (e) { settle(e); }
      });
      response.on('aborted', () => settle(Object.assign(new Error('本地服务响应提前中断。'), { code: 'ECONNRESET' })));
      response.on('error', settle);
    });
    // Socket idle timeouts alone do not bound a response that keeps trickling data.
    deadline = setTimeout(() => {
      const error = new Error('本地服务请求超过总时限 1500ms。');
      error.code = 'LOCAL_REQUEST_DEADLINE';
      fail(error);
    }, 1500);
    req.setTimeout(1500, () => fail(new Error('本地服务响应超时。')));
    req.on('error', settle);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

export function createReplayLauncher({ projectRoot, nodePath = process.execPath, port = 57016,
  stateDir = join(homedir(), 'Library/Application Support/Replay 2.0'), timeoutMs = 15000,
  openBrowser = url => run('/usr/bin/open', [url]), extraArgs = [] } = {}) {
  const root = resolve(projectRoot);
  const cli = join(root, 'bin/mtga-replay-serve.mjs');
  const url = `http://127.0.0.1:${port}`;
  const recordPath = join(stateDir, 'service.json');
  const logPath = join(stateDir, 'startup.log');
  const lockPath = join(stateDir, 'launcher.lock');

  async function identity(health) {
    if (health?.service !== 'mtga-gpt-replay' || health.port !== port ||
      !health.capabilities?.includes('replay-only-v1') || !Number.isSafeInteger(health.pid) || health.pid <= 1) {
      throw new Error(`端口 ${port} 被其他服务占用；未打开页面或终止该服务。`);
    }
    let command, started;
    try {
      command = (await run('/bin/ps', ['-p', String(health.pid), '-o', 'command='])).stdout.trim();
      started = (await run('/bin/ps', ['-p', String(health.pid), '-o', 'lstart='])).stdout.trim();
    } catch { throw new Error('无法确认 Replay 2.0 进程身份。'); }
    if (!command.includes(cli)) {
      throw new Error(`端口 ${port} 的进程来自另一个项目；未打开页面或终止该进程。`);
    }
    return { pid: health.pid, cli, started };
  }

  async function probe() {
    let health;
    try { health = await requestJSON(`${url}/api/health`); }
    catch (e) { if (e.code === 'ECONNREFUSED') return null; throw e; }
    return identity(health);
  }

  async function verifyReplay(expected) {
    const current = await probe();
    if (!current || current.pid !== expected.pid || current.started !== expected.started) throw new Error('回放进程身份已改变。');
    const health = await requestJSON(`${url}/api/health`);
    if (health.capabilities?.includes('live-coach')) throw new Error('检测到实时教练服务，未复用。');
  }

  async function withLock(action) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (Date.now() > deadline) throw new Error('另一个 Replay 2.0 启动/停止操作尚未结束，请稍后重试。');
      try { await mkdir(lockPath, { mode: 0o700 }); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let lockInfo, ownerText, owner;
        try {
          lockInfo = await stat(lockPath);
          try { ownerText = await readFile(join(lockPath, 'owner.json'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          try { owner = JSON.parse(ownerText); } catch {}
        } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        const stale = () => (owner && Number.isSafeInteger(owner.pid) && !alive(owner.pid)) ||
          (!owner && Date.now() - lockInfo.mtimeMs > 10000);
        if (stale()) {
          let reaper;
          const reaperPath = join(lockPath, 'reaper');
          try { reaper = await open(reaperPath, 'wx', 0o600); }
          catch (e) { if (['EEXIST', 'ENOENT'].includes(e.code)) { await pause(100); continue; } throw e; }
          try {
            const now = await stat(lockPath);
            let latest;
            try { latest = await readFile(join(lockPath, 'owner.json'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            // The path may now name a fresh lock acquired by another launcher.
            if (now.dev === lockInfo.dev && now.ino === lockInfo.ino && latest === ownerText && stale()) {
              await rm(lockPath, { recursive: true, force: true });
            } else {
              const held = await reaper.stat();
              const entry = await stat(reaperPath).catch(() => null);
              if (entry?.dev === held.dev && entry.ino === held.ino) await rm(reaperPath);
            }
          } catch (e) { if (e.code !== 'ENOENT') throw e; }
          finally { await reaper.close(); }
          continue;
        }
        if (Date.now() > deadline) throw new Error('另一个 Replay 2.0 启动/停止操作尚未结束，请稍后重试。');
        await pause(100);
      }
    }
    try {
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      return await action();
    } finally {
      let owner;
      try { owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')); } catch {}
      if (owner?.token === token) await rm(lockPath, { recursive: true, force: true });
    }
  }

  async function start({ openPage = true } = {}) {
    return withLock(async () => {
      let service = await probe();
      const reused = Boolean(service);
      if (!service) {
        try {
          await access(nodePath, constants.X_OK);
          await access(cli);
          await access(join(root, 'viewer/dist/index.html'));
        } catch { throw new Error(`现有 Node、Replay 2.0 程序或 Viewer 构建缺失。请检查项目：${root}；入口不会自动安装。`); }
        const version = (await run(nodePath, ['--version'])).stdout.trim();
        if (Number(version.match(/^v(\d+)\./)?.[1] ?? 0) < 24) throw new Error(`现有 Node ${version} 低于 24；请手动配置，不会自动安装。`);
        const log = await open(logPath, 'a', 0o600);
        await log.chmod(0o600);
        let child;
        try {
          child = spawn(nodePath, [cli, '--port', String(port), ...extraArgs], { cwd: root, detached: true,
            stdio: ['ignore', log.fd, log.fd], env: { ...process.env, MTGA_LIVE_COACH: '0' } });
        } finally { await log.close(); }
        let failure;
        child.on('error', e => { failure = e; });
        child.unref();
        try {
          const deadline = Date.now() + timeoutMs;
          while (!service) {
            if (failure || child.exitCode !== null || child.signalCode !== null) {
              throw new Error(`Replay 2.0 启动失败。查看本机日志：${logPath}`);
            }
            service = await probe();
            if (service && service.pid !== child.pid) throw new Error('启动期间端口被其他进程占用。');
            if (!service && Date.now() > deadline) throw new Error(`Replay 2.0 启动超时。查看本机日志：${logPath}`);
            if (!service) await pause(100);
          }
          await verifyReplay(service);

          await writeFile(recordPath, JSON.stringify(service), { mode: 0o600 });
        } catch (e) {
          // Only this invocation's child is stopped, gracefully; no unrelated process or SIGKILL.
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          throw e;
        }
      } else { await verifyReplay(service); }
      if (openPage) await openBrowser(url);
      return { ...service, reused, url, replayOnly: true };
    });
  }

  async function stop() {
    return withLock(async () => {
      const service = await probe();
      if (!service) { await rm(recordPath, { force: true }); return { stopped: true, alreadyStopped: true }; }
      await verifyReplay(service);
      let owned;
      try { owned = JSON.parse(await readFile(recordPath, 'utf8')); } catch {}
      if (!owned || owned.pid !== service.pid || owned.cli !== cli || owned.started !== service.started) {
        return { stopped: false, message: '独立回放服务。服务由其他入口启动，保留该进程；如需退出服务，请在原终端按 Ctrl+C。' };
      }
      // Recheck PID/start time immediately before a graceful signal.
      const current = await probe();
      if (!current || current.pid !== service.pid || current.started !== service.started) throw new Error('停止前进程身份改变，未发送退出信号。');
      process.kill(service.pid, 'SIGTERM');
      const deadline = Date.now() + timeoutMs;
      while (true) {
        let current;
        try { current = await probe(); }
        catch (e) { if (e.code !== 'ECONNRESET') throw e; current = service; }
        if (!current) break;
        if (Date.now() > deadline) throw new Error('服务尚未完成正常退出；未强制终止。请查看原终端或本机启动日志。');
        await pause(100);
      }
      await rm(recordPath, { force: true });
      return { stopped: true, replayOnly: true };
    });
  }
  return { start, stop, status: async () => {
    const service = await probe();
    if (!service) return { running: false };
    await verifyReplay(service);
    return { running: true, ...service, replayOnly: true };
  } };
}
