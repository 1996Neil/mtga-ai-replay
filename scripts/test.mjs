import { readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = new Set(process.argv.slice(2));
const privateCorpus = args.has('--private-corpus');
if (privateCorpus && (!process.env.MTGA_PRIVATE_CORPUS_DIR || !process.env.MTGA_PRIVATE_HELDOUT_FIXTURE)) {
  throw new Error('Private corpus tests require explicit MTGA_PRIVATE_CORPUS_DIR and MTGA_PRIVATE_HELDOUT_FIXTURE. No data is downloaded.');
}
const viewer = args.has('--viewer');
const dir = viewer ? 'viewer/tests' : 'tests';
let files = (await readdir(new URL(`../${dir}/`, import.meta.url))).filter(name => viewer ? name.endsWith('.test.ts') : name.endsWith('.test.mjs'));
if (args.has('--coach')) files = files.filter(name => name.startsWith('live-coach-'));
if (viewer && !args.has('--full-viewer')) {
  files = files.filter(name => !['adapter.test.ts', 'cardPresentation.test.ts', 'localHistory.test.ts'].includes(name));
  console.log('Viewer portable suite excludes adapter/store tests requiring restricted Viewer source; use viewer:test:full after authorized local materialization.');
}
if (viewer && args.has('--full-viewer')) {
  for (const name of ['replayStore', 'hoverStore', 'cardCacheStore']) await access(new URL(`../viewer/src/store/${name}.ts`, import.meta.url));
}
const command = ['--test', ...files.sort().map(name => `${dir}/${name}`)];
if (!viewer && !privateCorpus) console.log('Eight locked private-corpus checks are explicitly skipped; deidentified-window and synthetic checks remain enabled.');
const child = spawnSync(process.execPath, command, { cwd: root, stdio: 'inherit', env: process.env });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
