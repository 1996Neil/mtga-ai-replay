import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const fail = () => { throw Error('Invalid local sync network configuration.'); };
export function validateSyncProxy(value) {
  if (typeof value !== 'string') fail();
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail();
  return url.origin;
}

/** Child-process-only transport. No system proxy changes and no network probes. */
export async function syncNetworkEnvironment(dataDir, env = process.env) {
  if (env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy) return {};
  const path = join(dataDir, 'sync-network.json');
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const root = await lstat(dataDir);
  if (!root.isDirectory() || root.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() ||
    info.size > 4096 || (info.mode & 0o077)) fail();
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !Object.hasOwn(value, 'https_proxy')) fail();
  return { HTTPS_PROXY: validateSyncProxy(value.https_proxy) };
}
