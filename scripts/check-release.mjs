import { readFile, readdir, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const viewerManifest = JSON.parse(await readFile(new URL('../docs/restricted-viewer.json', import.meta.url), 'utf8'));
export function forbiddenPath(path) {
  return /(?:^|\/)(?:node_modules|dist|output|data|history|cache|audio|\.agents|\.codex|\.aws|\.git)(?:\/|$)/.test(path) ||
    /(?:^|\/)(?:credentials(?:\.[^/]+)?\.json|tokens?\.json|grant\.json|config\.json|Player\.log|UTC_Log[^/]*\.log|\.env(?:\.[^/]+)?|[^/]*ACCEPTANCE[^/]*)$/i.test(path) ||
    /\.(?:sqlite3?|db|log|mp3|wav|m4a|ogg|png|jpg|jpeg|webp|icns|zip|tgz|p12|pem|key)$/i.test(path);
}
export function assertCompleteHistory(shallowValue) {
  if (shallowValue !== 'false') throw new Error('Release scan requires complete Git history; shallow or unknown repository history is not accepted.');
  return true;
}
export function verifyViewerManifest(records, manifest = viewerManifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length !== 19) throw new Error('Viewer source manifest must contain exactly 19 files.');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !entry.path.startsWith('viewer/src/') || entry.path.split('/').includes('..') || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Viewer source manifest entry is invalid.');
    seen.add(entry.path);
    const matches = records.filter(record => record.path === entry.path);
    if (matches.length !== 1) throw new Error(`Viewer source manifest path is missing or duplicated: ${entry.path}`);
    const actual = createHash('sha256').update(matches[0].bytes).digest('hex');
    if (actual !== entry.sha256) throw new Error(`Viewer source manifest hash mismatch: ${entry.path}`);
  }
  return seen.size;
}
const CARD_NAMES_GZ = 'src/card-names/cards.jsonl.gz';

function textIssues(path, text) {
  const issues = [];
  const tokenPattern = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g;
  for (const match of text.matchAll(tokenPattern)) {
    if (!(path.startsWith('tests/') && /synthetic|sentinel/i.test(match[0]))) issues.push('credential-shaped value');
  }
  for (const match of text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g)) {
    const next = text[match.index + match[0].length];
    // A quoted header-only rejection sentinel is not key material. A newline,
    // escaped newline or body after the header is always rejected.
    if (!(path === 'tests/sync-security.test.mjs' && (next === "'" || next === '"'))) issues.push('private key');
  }
  if (/\/Users\/neil(?:\/|\b)|1996Neil\/mtga-replay-coach|Neil#[0-9]+/.test(text)) issues.push('personal machine/account binding');
  return issues;
}

function validCardNamesJsonl(text) {
  const lines = text.split('\n').filter(line => line.trim());
  if (!lines.length) return false;
  try {
    for (const line of lines) {
      const row = JSON.parse(line);
      if (!Number.isInteger(row.grp_id) || row.grp_id <= 0) return false;
      if (typeof row.en !== 'string' || !('zh' in row)) return false;
    }
  } catch { return false; }
  return true;
}

export function inspectRecord(path, bytes) {
  if (path === CARD_NAMES_GZ) {
    // The pinned names-only release is a deliberate binary asset. It is not
    // arbitrary binary: require gzip + the expected JSONL shape, then scan the
    // decompressed text for the same credential/path patterns as source files.
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return ['invalid card-names gzip'];
    let text;
    try { text = gunzipSync(bytes).toString('utf8'); } catch { return ['invalid card-names gzip']; }
    if (!validCardNamesJsonl(text)) return ['invalid card-names JSONL'];
    return [...new Set(textIssues(path, text))];
  }
  const issues = [];
  if (forbiddenPath(path)) issues.push('forbidden path');
  if (bytes.includes(0)) issues.push('binary content');
  issues.push(...textIssues(path, bytes.toString('utf8')));
  return [...new Set(issues)];
}
const git = args => spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
async function treeRecords() {
  const result = [];
  async function walk(dir = '') {
    for (const entry of await readdir(resolve(root, dir), { withFileTypes: true })) {
      const path = `${dir ? dir + '/' : ''}${entry.name}`;
      if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
      const info = await lstat(resolve(root, path));
      if (info.isSymbolicLink()) throw new Error(`Release candidate has a symlink: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push({ path, bytes: await readFile(resolve(root, path)) });
    }
  }
  await walk(); return result;
}
export async function checkRelease() {
  let records = await treeRecords();
  const viewerFiles = verifyViewerManifest(records);
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || resolve(top.stdout.toString().trim()) !== resolve(root)) throw new Error('Release scan requires this repository as the Git root.');
  const shallow = git(['rev-parse', '--is-shallow-repository']);
  if (shallow.status !== 0) throw new Error('Cannot determine whether Git history is shallow.');
  assertCompleteHistory(shallow.stdout.toString().trim());
  const refsResult = git(['for-each-ref', '--format=%(refname)']);
  if (refsResult.status !== 0) throw new Error('Cannot inspect fetched Git refs.');
  const refs = refsResult.stdout.toString().trim().split('\n').filter(Boolean);
  if (!refs.length) throw new Error('Cannot establish Git history scope without fetched refs.');
  const tracked = git(['ls-files', '-z']);
  if (tracked.status !== 0) throw new Error('Cannot inspect tracked files.');
  let commitCount = 0;
  if (tracked.status === 0) {
    // Worktree absence is not evidence: inspect staged content and commits reachable from fetched refs.
    const staged = git(['ls-files', '--stage', '-z']);
    if (staged.status !== 0) throw new Error('Cannot inspect Git index.');
    for (const entry of staged.stdout.toString().split('\0').filter(Boolean)) {
      const [meta, path] = entry.split('\t'), [mode, object] = meta.split(' ');
      if (mode !== '100644' && mode !== '100755') throw new Error(`Non-regular staged entry: ${path}`);
      const blob = git(['cat-file', 'blob', object]); if (blob.status !== 0) throw new Error('Cannot inspect staged blob.');
      records.push({ path, bytes: blob.stdout });
    }
    const commits = git(['rev-list', '--all']);
    if (commits.status !== 0) throw new Error('Cannot inspect commit history.');
    const commitIds = commits.stdout.toString().trim().split('\n').filter(Boolean);
    if (!commitIds.length) throw new Error('Cannot establish commit-history scope from fetched refs.');
    commitCount = commitIds.length;
    for (const commit of commitIds) {
      const metadata = git(['cat-file', 'commit', commit]);
      if (metadata.status !== 0) throw new Error('Cannot inspect commit metadata.');
      records.push({ path: `[commit metadata ${commit}]`, bytes: metadata.stdout });
      const entries = git(['ls-tree', '-rz', commit]); if (entries.status !== 0) throw new Error('Cannot inspect commit tree.');
      for (const entry of entries.stdout.toString().split('\0').filter(Boolean)) {
        const [meta, path] = entry.split('\t'), [mode, type, object] = meta.split(' ');
        if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`Non-regular historical entry: ${path}`);
        const blob = git(['cat-file', 'blob', object]); if (blob.status !== 0) throw new Error('Cannot inspect historical blob.');
        records.push({ path, bytes: blob.stdout });
      }
    }
  }
  const failures = records.flatMap(record => inspectRecord(record.path, record.bytes).map(issue => `${record.path}: ${issue}`));
  if (failures.length) throw new Error(`Release scan failed:\n${[...new Set(failures)].join('\n')}`);
  console.log(`Release scan passed: ${new Set(records.filter(record => !record.path.startsWith('[commit metadata')).map(record => record.path)).size} paths, including ${viewerFiles} manifest-pinned Viewer sources; worktree and index; history scope: ${commitCount} commits reachable from fetched refs [${refs.join(', ')}], shallow=false; commit trees and metadata checked; no file contents printed.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkRelease();
