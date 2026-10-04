import { spawn } from 'node:child_process';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultDataDir } from './history.mjs';

const viewerDir = fileURLToPath(new URL('../viewer/dist/', import.meta.url));
const serverFile = fileURLToPath(new URL('./server.mjs', import.meta.url));

async function runningServer(dataDir) {
  try {
    const info = JSON.parse(await readFile(join(dataDir, 'server.json'), 'utf8'));
    const url = new URL(info.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(info.port) ||
        url.username || url.password || resolve(info.viewerDir) !== resolve(viewerDir)) return null;
    const response = await fetch(new URL('api/health', url), { signal: AbortSignal.timeout(800) });
    const health = await response.json();
    return response.ok && health.service === 'mtga-gpt-replay' && health.pid === info.pid ? url : null;
  } catch { return null; }
}

/** Keep the loopback server alive after the one-shot CLI exits. No shell commands. */
export async function ensureViewerServer({ dataDir = defaultDataDir() } = {}) {
  try { await stat(join(viewerDir, 'index.html')); }
  catch { throw new Error('Viewer build missing. In the project run: npm run viewer:install && npm run viewer:build'); }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const existing = await runningServer(dataDir);
  if (existing) return existing;
  const child = spawn(process.execPath, [serverFile, '--data-dir', resolve(dataDir), '--viewer-dir', viewerDir, '--port', '0'], { detached: true, stdio: 'ignore' });
  let startupError;
  child.once('error', error => { startupError = error; });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (startupError) throw startupError;
    const url = await runningServer(dataDir);
    if (url) return url;
    await delay(100);
  }
  throw new Error('Local Replay server did not start within 5 seconds. Try node src/server.mjs for diagnostics.');
}

export async function openViewer(matchId, { dataDir = defaultDataDir(), open = true } = {}) {
  const url = await ensureViewerServer({ dataDir });
  url.searchParams.set('match', matchId);
  if (open) await new Promise((resolve, reject) => {
    const child = spawn('open', [url.href], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`macOS open exited with status ${code}`)));
  });
  return url.href;
}
