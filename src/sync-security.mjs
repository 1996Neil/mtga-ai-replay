import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Opaque, invocation-only capabilities. Another loaded ruleset cannot use this
// module's WeakMap, and callers cannot insert their own successful verdicts.
const validationSessions = new WeakMap();
export function createSyncValidationSession() {
  const session = Object.freeze({});
  validationSessions.set(session, { context: null, verified: new Set(), failed: false, busy: false });
  return session;
}

const ALLOWED_ROOT = new Set(['README.md', '.gitignore', 'index.json']);
const BUNDLE_NAME = '(?:summary|coach|cards|manifest)\\.json';
const BUNDLE_PATH = new RegExp(`^(?:latest/${BUNDLE_NAME}|matches/[A-Za-z0-9][A-Za-z0-9_-]{0,127}/${BUNDLE_NAME})$`);
const PART_PATH = /^matches\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/parts\/part-[0-9]{4,6}\.json$/;
const COLLECTION_PATH = /^(?:collection\/README\.md|collection\/latest\/(?:summary|inventory|manifest)\.json|collection\/latest\/parts\/cards-[0-9]{3,6}\.json)$/;
const MODES = new Set(['100644', '100755']);
const GITHUB_TOKEN = /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]*/i;
const API_KEY_NAME = /\b(?:OPENAI[_-]API[_-]KEY|API[_-]KEY)\b/i;
const LOCAL_PATH = /(?:\/(?:Users|Volumes|Applications|Library|System|private|home|tmp|var|etc|opt|usr|mnt|root|run)(?:\/|\b)|\b[A-Za-z]:[\\/]|(?:^|[\s"'])\\\\[^\s\\]+[\\/]|\bfile:\/\/|(?:^|[\s"'])~\/)/i;
const AUTHENTICATED_URL = /\bhttps?:\/\/[^\s/@]+@/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const CREDENTIAL_ASSIGNMENT = /\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|access[_-]?token|refresh[_-]?token|github[_-]?token|client[_-]?secret|password|passwd|secret[_-]?key)["']?\s*[:=]/i;
const LONG_BEARER = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{12,}(?=$|[\s"'])/im;
const SHORT_BEARER_VALUE = /^\s*Bearer[ \t]+(?!of\b|the\b|a\b|an\b)[A-Za-z0-9._~+/=-]+\s*$/im;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\b/;
const OPENAI_TOKEN = /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/;
const IMAGE_OR_BINARY_TEXT = /(?:\bdata:(?:image\/|application\/(?:octet-stream|x-sqlite3))|<svg\b)/i;
const CREDENTIAL_KEYS = new Set([
  'authorization', 'proxyauthorization', 'auth', 'authentication', 'credential', 'credentials',
  'cookie', 'cookies', 'setcookie', 'password', 'passwd', 'pwd', 'secret', 'secretkey',
  'apikey', 'openaiapikey', 'githubapikey', 'githubtoken', 'githubpat', 'authtoken', 'accesstoken',
  'refreshtoken', 'idtoken', 'sessiontoken', 'bearertoken', 'jwt', 'jwttoken', 'clientsecret',
  'privatekey', 'oauth', 'oauthcredential', 'oauthcredentials', 'accountauth', 'accounttoken',
  'authenticationtoken', 'authdata', 'accountcredentials', 'passwordhash', 'cookiejar', 'sessioncookie',
  'cookieheader', 'authheader', 'authorizationheader', 'apikeys', 'identitytoken',
]);
const INTERNAL_KEYS = new Set([
  'accountid', 'internalaccountid', 'accountauthid', 'authid', 'internalauthid', 'authenticationid', 'userid', 'internaluserid',
  'machineid', 'machineidentifier', 'deviceid', 'deviceidentifier', 'clientid', 'sessionid',
  'internalplayerid', 'playeruuid', 'accountuuid', 'clientuuid', 'machineuuid', 'deviceuuid',
  'installationid', 'hardwareid', 'hwid', 'trackingid',
  'email', 'emailaddress', 'ipaddress', 'macaddress',
]);
const RAW_KEYS = new Set([
  'gretoclientevent', 'gretoclientmessages', 'gamestatemessage', 'matchgameroomstatechangedevent',
  'rawlog', 'playerlog', 'rawgre', 'rawgremessage', 'telemetry', 'crashlog',
]);
const IMAGE_KEYS = new Set(['image', 'images', 'imageuris', 'imageurls', 'imageurl', 'imagepath', 'imagecache',
  'cardimage', 'cardimages', 'cachedimages', 'binarydata', 'imagedata', 'imagebase64', 'rawbytes']);
const normalizedKey = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const allowedPath = path => typeof path === 'string' && (ALLOWED_ROOT.has(path) || BUNDLE_PATH.test(path) || PART_PATH.test(path) || COLLECTION_PATH.test(path));
const RESEARCH_PATH = /^docs\/research\/live-coach\/[A-Za-z0-9_-]{1,128}\.md$/;
const OBJECT_HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Explicit local consent for immutable, already-published history; never inferred from Git. */
export function validateSyncHistoryApproval(value, { repository, branch } = {}) {
  if (value === undefined) return undefined;
  if (!value || value.schema !== 'MTGA_SYNC_HISTORY_APPROVAL_V1' || value.approved !== true ||
      typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      typeof branch !== 'string' || !/^[A-Za-z0-9_.\/-]+$/.test(branch) || value.repository !== repository || value.branch !== branch ||
      typeof value.approved_at !== 'string' || !Number.isFinite(Date.parse(value.approved_at)) ||
      !Array.isArray(value.commits) || !value.commits.length || value.commits.length > 16 ||
      new Set(value.commits).size !== value.commits.length || value.commits.some(hash => typeof hash !== 'string' || !OBJECT_HASH.test(hash)) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > 16) reject('', 'invalid-history-approval');
  const paths = new Set();
  for (const file of value.files) {
    if (!file || !RESEARCH_PATH.test(file.path) || paths.has(file.path) || file.mode !== '100644' ||
        !OBJECT_HASH.test(file.blob) || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 1024 * 1024) reject('', 'invalid-history-approval');
    paths.add(file.path);
  }
  return { schema: value.schema, approved: true, repository, branch, approved_at: value.approved_at,
    commits: [...value.commits], files: value.files.map(file => ({ path: file.path, mode: file.mode,
      blob: file.blob, sha256: file.sha256, bytes: file.bytes })) };
}

export const isCollectionSyncPath = path => typeof path === 'string' && COLLECTION_PATH.test(path);
export const isCoachSyncPath = path => typeof path === 'string' && (ALLOWED_ROOT.has(path) || BUNDLE_PATH.test(path) || PART_PATH.test(path));

function safeErrorPath(path) {
  if (path === '[commit metadata]') return path;
  if (!allowedPath(path)) return '[unapproved path]';
  if (GITHUB_TOKEN.test(path) || OPENAI_TOKEN.test(path)) return '[redacted path]';
  return path;
}
function reject(path, rule) {
  const safePath = safeErrorPath(path);
  const error = new Error(`Sync security rejected ${safePath}: ${rule}`);
  error.name = 'SyncSecurityError'; error.code = 'MTGA_SYNC_SECURITY';
  error.path = safePath; error.rule = rule;
  throw error;
}

function scanText(text, path) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) reject(path, 'binary-or-control-data');
  if (IMAGE_OR_BINARY_TEXT.test(text)) reject(path, 'image-or-binary-data');
  if (GITHUB_TOKEN.test(text) || PRIVATE_KEY.test(text) || JWT.test(text) || OPENAI_TOKEN.test(text) ||
      API_KEY_NAME.test(text) || CREDENTIAL_ASSIGNMENT.test(text) || LONG_BEARER.test(text) || SHORT_BEARER_VALUE.test(text) || AUTHENTICATED_URL.test(text)) reject(path, 'credential-text');
  if (LOCAL_PATH.test(text)) reject(path, 'local-machine-path');
  if (EMAIL.test(text)) reject(path, 'email-address');
}
function scanJsonKey(key, isStringValue, path) {
  const normalized = normalizedKey(key);
  if (CREDENTIAL_KEYS.has(normalized) || (normalized === 'token' && isStringValue)) reject(path, 'credential-key');
  if (INTERNAL_KEYS.has(normalized)) reject(path, 'internal-account-or-machine-identifier');
  if (RAW_KEYS.has(normalized)) reject(path, 'raw-client-record');
  if (IMAGE_KEYS.has(normalized)) reject(path, 'image-or-binary-data');
  scanText(key, path);
}
function scanRawJsonKeys(text, path) {
  // JSON.parse discards earlier duplicate members. Inspect every syntactic key
  // in the original bytes so such members cannot hide forbidden metadata.
  // Walk complete string tokens to avoid mistaking quoted Oracle text for keys.
  for (let cursor = 0; cursor < text.length; cursor++) {
    if (text[cursor] !== '"') continue;
    const start = cursor++;
    for (; cursor < text.length && text[cursor] !== '"'; cursor++) if (text[cursor] === '\\') cursor++;
    const end = cursor;
    let next = end + 1;
    while (/\s/.test(text[next] ?? '') && next < text.length) next++;
    if (text[next] !== ':') continue;
    next++;
    while (/\s/.test(text[next] ?? '') && next < text.length) next++;
    scanJsonKey(JSON.parse(text.slice(start, end + 1)), text[next] === '"', path);
  }
}
function scanJson(value, path) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (/^\/(?!\/)[^\s]/.test(current)) reject(path, 'local-machine-path');
      scanText(current, path); continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) { for (const item of current) pending.push(item); continue; }
    for (const [key, item] of Object.entries(current)) {
      scanJsonKey(key, typeof item === 'string', path); pending.push(item);
    }
  }
}
function textContent(value, path) {
  if (typeof value === 'string') return value;
  if (!(value instanceof Uint8Array)) reject(path, 'non-text-file');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { reject(path, 'invalid-utf8'); }
}

/** Validate the complete publishable tree without truncating or rewriting it. */
export function validateBundleFiles(filesMap) {
  let entries;
  if (filesMap instanceof Map) entries = [...filesMap];
  else if (filesMap && typeof filesMap === 'object' && !Array.isArray(filesMap)) entries = Object.entries(filesMap);
  else reject('', 'invalid-files-map');
  for (const [path, content] of entries) {
    if (!allowedPath(path)) reject(path, 'unapproved-file-path');
    // Match keys must not themselves carry a credential.
    scanText(path, path);
    const text = textContent(content, path);
    if (path.endsWith('.json')) {
      let value;
      try { value = JSON.parse(text); } catch { reject(path, 'invalid-json'); }
      scanRawJsonKeys(text, path);
      scanJson(value, path);
      // Also inspect discarded duplicate values: JSON.parse keeps only the final
      // property, while the earlier text would still be committed to Git.
      const decoded = text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\\//g, '/');
      if (/"\/(?!\/)[^"\r\n]+/.test(decoded)) reject(path, 'local-machine-path');
      scanText(decoded, path);
    }
    scanText(text, path);
  }
  return { ok: true, fileCount: entries.length };
}

function defaultGit(repoDir) {
  return (args, { input } = {}) => new Promise((resolveCommand, rejectCommand) => {
    const child = execFile('git', args, { cwd: repoDir, encoding: 'buffer', timeout: 30000, maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, GIT_DIR: resolve(repoDir, '.git'), GIT_WORK_TREE: repoDir, GIT_INDEX_FILE: resolve(repoDir, '.git/index') } }, (error, stdout) => {
      if (error) rejectCommand(error); else resolveCommand(stdout);
    });
    child.stdin.on('error', rejectCommand);
    child.stdin.end(input);
  });
}
function commandOutput(result) {
  const output = result && typeof result === 'object' && !(result instanceof Uint8Array) ? result.stdout : result;
  if (typeof output === 'string') return Buffer.from(output);
  if (output instanceof Uint8Array) return Buffer.from(output);
  reject('', 'git-inspection-output');
}
function parseEntries(output, kind, approvedFiles = new Map()) {
  const result = [];
  for (const record of output.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) reject('', 'git-inspection-format');
    const path = record.slice(tab + 1), fields = record.slice(0, tab).split(' ');
    const [mode, middle, last] = fields;
    const approved = approvedFiles.get(path);
    if (!allowedPath(path) && !approved) reject(path, 'unapproved-file-path');
    if (!MODES.has(mode)) reject(path, 'symlink-or-gitlink');
    if (kind === 'index' && last !== '0') reject(path, 'unmerged-index-entry');
    if (kind === 'tree' && middle !== 'blob') reject(path, 'non-blob-git-entry');
    const hash = kind === 'index' ? middle : last;
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(hash ?? '')) reject(path, 'invalid-git-object');
    if (approved && (mode !== approved.mode || hash !== approved.blob)) reject(path, 'changed-approved-document');
    // Paths must be scanned even when another path uses an identical blob.
    scanText(path, path);
    result.push({ path, hash });
  }
  return result;
}

/** Bounded batches; verify framing, type, length and the Git object digest.
 * Reading/hash verification is repeated even on a cached semantic verdict,
 * so replacing a loose object under its old name cannot bypass inspection. */
async function inspectObjects(git, hashes, kind, inspect) {
  if (!hashes.length) return;
  const input = Buffer.from(hashes.join('\n') + '\n');
  const lines = (await git(['cat-file', '--batch-check'], input)).toString('utf8').trim().split('\n');
  if (lines.length !== hashes.length) reject('', 'git-inspection-format');
  const objects = lines.map((line, index) => {
    const match = line.match(/^([a-f0-9]{40}(?:[a-f0-9]{24})?) (blob|commit) ([0-9]+)$/);
    if (!match || match[1] !== hashes[index] || match[2] !== kind) reject('', 'invalid-git-object');
    const bytes = Number(match[3]);
    if (!Number.isSafeInteger(bytes) || bytes > 512 * 1024 * 1024 - 1024) reject('', 'git-inspection-format');
    return { hash: match[1], bytes };
  });
  let offset = 0;
  while (offset < objects.length) {
    const batch = []; let size = 0;
    while (offset < objects.length && (!batch.length || size + objects[offset].bytes < 16 * 1024 * 1024)) {
      const object = objects[offset++]; batch.push(object); size += object.bytes + 100;
    }
    const output = await git(['cat-file', '--batch'], Buffer.from(batch.map(item => item.hash).join('\n') + '\n'));
    let cursor = 0;
    for (const object of batch) {
      const end = output.indexOf(10, cursor);
      if (end < 0 || output.subarray(cursor, end).toString('ascii') !== `${object.hash} ${kind} ${object.bytes}`) reject('', 'git-inspection-format');
      cursor = end + 1;
      if (cursor + object.bytes >= output.length || output[cursor + object.bytes] !== 10) reject('', 'git-inspection-format');
      const content = output.subarray(cursor, cursor + object.bytes);
      const digest = createHash(object.hash.length === 40 ? 'sha1' : 'sha256').update(`${kind} ${object.bytes}\0`).update(content).digest('hex');
      if (digest !== object.hash) reject('', 'invalid-git-object');
      await inspect(object.hash, content);
      cursor += object.bytes + 1;
    }
    if (cursor !== output.length) reject('', 'git-inspection-format');
  }
}

function validateCommitMetadata(content, approvedExistingIdentity = false) {
  const path = '[commit metadata]', text = textContent(content, path);
  const boundary = text.indexOf('\n\n');
  if (boundary < 0) reject(path, 'invalid-commit-metadata');
  const headers = text.slice(0, boundary).split('\n');
  for (const field of ['author', 'committer']) {
    const indices = headers.flatMap((line, index) => line.startsWith(`${field} `) ? [index] : []);
    if (indices.length !== 1) reject(path, 'invalid-commit-metadata');
    const index = indices[0], identity = headers[index].match(/^(?:author|committer) (.+) <([^<>\r\n]+)> [0-9]+ [+-][0-9]{4}$/);
    if (!identity || (!approvedExistingIdentity && !/^[A-Za-z0-9][A-Za-z0-9+._-]*@users\.noreply\.github\.com$/.test(identity[2]))) reject(path, 'commit-personal-identity');
    // Only the validated Git header identity may contain a noreply address.
    // Commit messages and additional headers are scanned without exceptions.
    headers[index] = headers[index].replace(`<${identity[2]}>`, '<git-noreply>');
  }
  scanText(`${headers.join('\n')}\n\n${text.slice(boundary + 2)}`, path);
}

/** Read index and reachable commits as raw Git objects, never worktree links. */
export async function validateStagedRepository(repoDir, { runGit, historyApproval, repository, branch, validationSession, onValidation } = {}) {
  const session = validationSession === undefined ? null : validationSessions.get(validationSession);
  if (validationSession !== undefined && (!session || session.failed)) reject('', 'invalid-validation-session');
  // Reject a concurrent caller before it can change the first caller's scope.
  if (session?.busy) reject('', 'concurrent-validation-session');
  if (session) session.busy = true;
  try {
  const approval = validateSyncHistoryApproval(historyApproval, { repository, branch });
  if (session) {
    const context = JSON.stringify([resolve(repoDir), repository ?? null, branch ?? null, approval ?? null]);
    if (session.context !== context) { session.verified.clear(); session.context = context; }
  }
  const approvedCommits = new Set(approval?.commits ?? []);
  const approvedFiles = new Map((approval?.files ?? []).map(file => [file.path, file]));
  const execute = runGit ?? defaultGit(repoDir);
  const git = async (args, input) => {
    try { return commandOutput(await execute(args, { cwd: repoDir, encoding: 'buffer', input })); }
    catch (error) {
      if (error?.code === 'MTGA_SYNC_SECURITY') throw error;
      // Never expose Git stderr, cwd, malformed payloads or a credential URL.
      reject('', 'git-inspection-failed');
    }
  };
  const staged = await git(['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-renames']);
  for (const path of staged.toString('utf8').split('\0').filter(Boolean)) if (!allowedPath(path)) reject(path, 'unapproved-file-path');
  const index = parseEntries(await git(['ls-files', '--stage', '-z']), 'index', approvedFiles);
  const revisions = (await git(['rev-list', '--all'])).toString('utf8').trim().split('\n').filter(Boolean);
  for (const revision of revisions) if (!OBJECT_HASH.test(revision)) reject('', 'invalid-git-revision');
  const trees = [];
  await inspectObjects(git, revisions, 'commit', (hash, content) => validateCommitMetadata(content, approvedCommits.has(hash)));
  for (const revision of revisions) {
    const approved = approvedCommits.has(revision);
    if (!approved && approvedFiles.size) {
      const changed = await git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-z', '--no-renames', '-m', '-r', revision]);
      if (changed.toString('utf8').split('\0').some(path => approvedFiles.has(path))) reject('', 'changed-approved-document');
    }
    trees.push(...parseEntries(await git(['ls-tree', '-r', '-z', '--full-tree', revision]), 'tree', approvedFiles));
  }
  const inspected = new Set(), pending = new Map();
  for (const { path, hash } of [...index, ...trees]) {
    // Identical bytes in JSON and README are validated under both file formats.
    const approved = approvedFiles.get(path);
    const identity = `${approved ? `approved-document:${path}` : 'data'}:${hash}:${path.endsWith('.json') ? 'json' : 'text'}`;
    if (inspected.has(identity)) continue;
    inspected.add(identity);
    if (!pending.has(hash)) pending.set(hash, []);
    pending.get(hash).push({ path, approved, identity });
  }
  let checked = 0, reused = 0;
  await inspectObjects(git, [...pending.keys()], 'blob', (hash, content) => {
    for (const { path, approved, identity } of pending.get(hash)) {
    if (session?.verified.has(identity)) { reused++; continue; }
    if (approved) {
      if (content.length !== approved.bytes || createHash('sha256').update(content).digest('hex') !== approved.sha256) reject(path, 'changed-approved-document');
      scanText(textContent(content, path), path);
    } else validateBundleFiles(new Map([[path, content]]));
    session?.verified.add(identity); checked++;
  }
  });
  onValidation?.({ objects: pending.size, checked, reused });
  return { ok: true, fileCount: index.length };
  } catch (error) {
    if (session) { session.verified.clear(); session.failed = true; }
    throw error;
  } finally { if (session) session.busy = false; }
}
