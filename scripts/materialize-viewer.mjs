import { lstat, readFile, open, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../docs/restricted-viewer.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function materializeViewer({ sourceDir, destinationRoot = root, entries = manifest.files }) {
  if (!sourceDir) throw new Error('An explicit authorized local --source-dir is required.');
  const source = await realpath(resolve(sourceDir)), target = await realpath(resolve(destinationRoot));
  async function safeAncestors(destination) {
    let ancestor = dirname(destination);
    while (ancestor !== target) {
      if (!ancestor.startsWith(target + sep)) throw new Error('Destination escapes chosen root.');
      try {
        const info = await lstat(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(ancestor) !== ancestor) throw new Error('Unsafe destination ancestor.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      ancestor = dirname(ancestor);
    }
    if (await realpath(target) !== target || !(await lstat(target)).isDirectory()) throw new Error('Unsafe destination root.');
  }
  async function verifyExisting(destination, expected) {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(destination) !== destination || hash(await readFile(destination)) !== expected) throw new Error('Refuse to accept or overwrite a different local file.');
  }
  const pending = [];
  for (const item of entries) {
    if (!/^viewer\/src\/(?:components|hooks|store|types)\/[A-Za-z]+\.(?:ts|tsx)$/.test(item.path) && item.path !== 'viewer/src/index.css') throw new Error('Invalid allowlist path.');
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid expected hash.');
    const path = resolve(source, item.path);
    if (!path.startsWith(source + sep)) throw new Error('Source path escapes the chosen directory.');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Only regular files without symlink ancestors may be restored.');
    const bytes = await readFile(path);
    if (hash(bytes) !== item.sha256) throw new Error(`Source hash mismatch: ${item.path}`);
    const destination = resolve(target, item.path);
    await safeAncestors(destination);
    try { await verifyExisting(destination, item.sha256); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    pending.push({ destination, bytes, expected: item.sha256 });
  }
  // Validate the entire source set before writing. Recheck destinations at each
  // write and afterward; a concurrent EEXIST is never accepted without verification.
  for (const { destination, bytes, expected } of pending) {
    await safeAncestors(destination);
    await mkdir(dirname(destination), { recursive: true });
    await safeAncestors(destination);
    let handle;
    try { handle = await open(destination, 'wx', 0o600); await handle.writeFile(bytes); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await handle?.close(); }
    await safeAncestors(destination);
    await verifyExisting(destination, expected);
  }
  // A second final pass catches changes during restoration of later files.
  for (const { destination, expected } of pending) { await safeAncestors(destination); await verifyExisting(destination, expected); }
  return pending.length;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'source-dir': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log('Usage: npm run viewer:materialize -- --source-dir /path/to/your/authorized/mtga-gpt-replay\nCopies only hash-pinned, ignored Viewer files from an explicit existing local source. No network or credentials.');
  else { const count = await materializeViewer({ sourceDir: values['source-dir'] }); console.log(`Verified/restored ${count} hash-pinned Viewer files from the explicit local source. Private PR inclusion remains limited to the user authorization and does not establish public redistribution rights.`); }
}
