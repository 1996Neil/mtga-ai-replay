import { isDraftSyncPath, parseDraftBackup } from './draft-backup.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createGitBatch } from './git-batch.mjs';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { isReviewSyncPath, parseCloudReview } from './review/cloud-review-contract.mjs';
export { isReviewSyncPath } from './review/cloud-review-contract.mjs';

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
const COLLECTION_PATH = /^collection\/(?:accounts\/[a-f0-9]{64}\/)?(?:README\.md|latest\/(?:summary|inventory|manifest)\.json|latest\/parts\/cards-[0-9]{3,6}\.json)$/;
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
export const allowedPath = path => typeof path === 'string' && (ALLOWED_ROOT.has(path) || BUNDLE_PATH.test(path) || PART_PATH.test(path) || COLLECTION_PATH.test(path) || isReviewSyncPath(path) || isDraftSyncPath(path));
const RESEARCH_PATH = /^docs\/research\/replay\/[A-Za-z0-9_-]{1,128}\.md$/;
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
  if (text.includes('@') && EMAIL.test(text)) reject(path, 'email-address');
}
function scanJsonKey(key, isStringValue, path, memo) {
  const identity = `${isStringValue ? 'string' : 'other'}:${key}`;
  if (memo?.keys.has(identity)) return;
  const normalized = normalizedKey(key);
  if (CREDENTIAL_KEYS.has(normalized) || (normalized === 'token' && isStringValue)) reject(path, 'credential-key');
  if (INTERNAL_KEYS.has(normalized)) reject(path, 'internal-account-or-machine-identifier');
  if (RAW_KEYS.has(normalized)) reject(path, 'raw-client-record');
  if (IMAGE_KEYS.has(normalized)) reject(path, 'image-or-binary-data');
  scanText(key, path);
  if (memo && key.length <= 256 && memo.keys.size < 2048) memo.keys.add(identity);
}
function scanRawJsonKeys(text, path, memo) {
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
    scanJsonKey(JSON.parse(text.slice(start, end + 1)), text[next] === '"', path, memo);
  }
}
function scanJson(value, path, memo) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (/^\/(?!\/)[^\s]/.test(current)) reject(path, 'local-machine-path');
      if (!memo?.strings.has(current)) {
        scanText(current, path);
        if (memo && current.length <= 256 && memo.strings.size < 2048) memo.strings.add(current);
      }
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) { for (const item of current) pending.push(item); continue; }
    for (const [key, item] of Object.entries(current)) {
      scanJsonKey(key, typeof item === 'string', path, memo); pending.push(item);
    }
  }
}
function textContent(value, path) {
  if (typeof value === 'string') return value;
  if (!(value instanceof Uint8Array)) reject(path, 'non-text-file');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { reject(path, 'invalid-utf8'); }
}

function scanSerializedJsonText(text, path) {
  const decoded = text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\\//g, '/');
  if (/"\/(?!\/)[^"\r\n]+/.test(decoded)) reject(path, 'local-machine-path');
  scanText(decoded, path);
  if (decoded !== text) scanText(text, path); // Identical bytes have the same verdict.
}

/** Additional continuous-value check for an already parsed/reconstructed coach.
 * Raw files STILL require validateBundleFiles (UTF-8, duplicate members, etc.).
 * Canonical pretty JSON separates tokens by punctuation/newlines; the only
 * credential pattern spanning that punctuation is key + closing quote + colon.
 * Scan that exact token as well as every complete string and semantic key.
 * No toJSON/getter/prototype can substitute a different serialized value. */
export function validateExpandedCoach(value) {
  const path = 'latest/coach.json';
  if (!value || typeof value !== 'object' || Object.getOwnPropertyDescriptor(value, 'schema')?.value !== 'MTGA_FULL_COACH_V1') reject(path, 'expanded-coach-type');
  const pending = [{ value }], active = new WeakSet(), done = new WeakSet();
  while (pending.length) {
    const frame = pending.pop(), current = frame.value;
    if (frame.exit) { active.delete(current); done.add(current); continue; }
    if (typeof current === 'string') {
      if (/^\/(?!\/)[^\s]/.test(current)) reject(path, 'local-machine-path');
      scanText(current, path); scanSerializedJsonText(JSON.stringify(current), path); continue;
    }
    if (current === null || current === undefined || typeof current === 'boolean' || typeof current === 'number') continue;
    if (typeof current !== 'object') reject(path, 'non-json-coach-value');
    const array = Array.isArray(current), proto = Object.getPrototypeOf(current);
    if (proto !== (array ? Array.prototype : Object.prototype) && proto !== null) reject(path, 'non-json-coach-value');
    if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) reject(path, 'non-json-coach-value');
    if (active.has(current)) reject(path, 'cyclic-coach-value');
    if (done.has(current)) continue;
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]) ||
        (key === 'toJSON' && typeof descriptors[key].value === 'function'))) reject(path, 'non-json-coach-value');
    active.add(current); pending.push({ value: current, exit: true });
    const keys = array ? null : Object.keys(current);
    for (let i = 0, length = array ? current.length : keys.length; i < length; i++) {
      const key = array ? String(i) : keys[i];
      // JSON.stringify reads inherited array indices, including getters. Reject
      // those holes without invoking inherited code or silently skipping data.
      if (array && !Object.hasOwn(descriptors, key) && key in current) reject(path, 'non-json-coach-value');
      const child = Object.hasOwn(descriptors, key) ? descriptors[key].value : undefined;
      // JSON.stringify omits undefined object fields and encodes array holes as null.
      if (child === undefined) continue;
      if (!array) { scanJsonKey(key, typeof child === 'string', path); scanSerializedJsonText(JSON.stringify(key) + ':', path); }
      pending.push({ value: child });
    }
  }
  return { ok: true };
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
    if (isDraftSyncPath(path)) {
      try { parseDraftBackup(path, text); } catch { reject(path, 'invalid-draft-backup'); }
    }
    if (isReviewSyncPath(path)) {
      try { parseCloudReview(content, { path }); }
      catch { reject(path, 'invalid-cloud-review'); }
    }
    if (path.endsWith('.json')) {
      let value;
      try { value = JSON.parse(text); } catch { reject(path, 'invalid-json'); }
      // Positive string/key results are pure within this one file. Keep bounded
      // local sets; raw syntax, duplicate members, complete text and every object
      // still undergo their original checks. No verdict survives this call.
      const memo = { keys: new Set(), strings: new Set() };
      scanRawJsonKeys(text, path, memo);
      scanJson(value, path, memo);
      // Also inspect discarded duplicate values: JSON.parse keeps only the final
      // property, while the earlier text would still be committed to Git.
      scanSerializedJsonText(text, path);
    } else scanText(text, path);
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
    if (kind === 'index' && last !== '0') reject(path, 'unmerged-index-entry');
    if (kind === 'tree' && middle !== 'blob') reject(path, 'non-blob-git-entry');
    const hash = kind === 'index' ? middle : last;
    result.push(validateFileEntry(path, mode, hash, approvedFiles));
  }
  return result;
}

function validateFileEntry(path, mode, hash, approvedFiles) {
  const approved = approvedFiles.get(path);
  if (!allowedPath(path) && !approved) reject(path, 'unapproved-file-path');
  if (!MODES.has(mode)) reject(path, 'symlink-or-gitlink');
  if ((isReviewSyncPath(path) || isDraftSyncPath(path)) && mode !== '100644') reject(path, 'review-file-mode');
  if (!OBJECT_HASH.test(hash ?? '')) reject(path, 'invalid-git-object');
  if (approved && (mode !== approved.mode || hash !== approved.blob)) reject(path, 'changed-approved-document');
  // A new path never inherits the permission of another path with the same bytes.
  scanText(path, path);
  return { path, hash };
}

function parseRawTree(content, hash) {
  const entries = [], names = new Set(), hashBytes = hash.length / 2;
  let cursor = 0;
  while (cursor < content.length) {
    const space = content.indexOf(32, cursor), nul = content.indexOf(0, space + 1);
    if (space < cursor || nul < space + 1 || nul + 1 + hashBytes > content.length) reject('', 'git-inspection-format');
    const mode = content.subarray(cursor, space).toString('utf8');
    const nameBytes = content.subarray(space + 1, nul);
    const name = textContent(nameBytes, '');
    // Path permissions apply to the exact Git bytes. TextDecoder may strip a
    // leading UTF-8 BOM, which must never turn a different name into an allowed
    // README or data directory. JSON body decoding keeps its existing behavior.
    if (!Buffer.from(name, 'utf8').equals(nameBytes)) reject('', 'git-inspection-format');
    if (!/^[0-7]{5,6}$/.test(mode) || !name || name === '.' || name === '..' || name.includes('/') || names.has(name)) reject('', 'git-inspection-format');
    names.add(name);
    entries.push({ mode, name, hash: content.subarray(nul + 1, nul + 1 + hashBytes).toString('hex') });
    cursor = nul + 1 + hashBytes;
  }
  return entries;
}

/** Read each unique tree once per guard, without one recursive Git process per
 * historical commit. Paths remain part of traversal identity: sharing a subtree
 * under a different directory must still recheck all of its leaf paths. */
async function inspectTrees(git, roots, approvedFiles, metrics) {
  const trees = new Map(), visited = new Set(), files = [];
  let work=0,lastYield=performance.now();
  let pending = new Map([...new Set(roots)].map(hash => [hash, new Set([''])]));
  while (pending.size) {
    await inspectObjects(git, [...pending.keys()].filter(hash => !trees.has(hash)), 'tree', (hash, content) => {
      trees.set(hash, parseRawTree(content, hash));
    }, metrics);
    const next = new Map();
    for (const [hash, prefixes] of pending) for (const prefix of prefixes) {
      const identity = `${hash}:${prefix}`;
      if (visited.has(identity)) continue;
      visited.add(identity);
      for (const entry of trees.get(hash)) {
        if(++work%512===0&&performance.now()-lastYield>=5){await yieldLoop();lastYield=performance.now();}
        const path = prefix + entry.name;
        if (entry.mode === '40000' || entry.mode === '040000') {
          scanText(path, path);
          if (!next.has(entry.hash)) next.set(entry.hash, new Set());
          next.get(entry.hash).add(`${path}/`);
        } else files.push(validateFileEntry(path, entry.mode, entry.hash, approvedFiles));
      }
    }
    pending = next;
  }
  return { trees, files };
}

function entryAtPath(trees, root, path) {
  let hash = root;
  const components = path.split('/');
  for (let index = 0; index < components.length; index++) {
    const entry = trees.get(hash)?.find(value => value.name === components[index]);
    if (!entry) return null;
    if (index === components.length - 1) return `${entry.mode}:${entry.hash}`;
    if (entry.mode !== '40000' && entry.mode !== '040000') return null;
    hash = entry.hash;
  }
  return null;
}

/** Bounded batches; verify framing, type, length and the Git object digest.
 * Reading/hash verification is repeated even on a cached semantic verdict,
 * so replacing a loose object under its old name cannot bypass inspection. */
async function inspectObjects(git, hashes, kind, inspect, metrics) {
  if (!hashes.length) return;
  const input = Buffer.from(hashes.join('\n') + '\n');
  const lines = (await git(['cat-file', '--batch-check'], input)).toString('utf8').trim().split('\n');
  if (lines.length !== hashes.length) reject('', 'git-inspection-format');
  const objects = lines.map((line, index) => {
    const match = line.match(/^([a-f0-9]{40}(?:[a-f0-9]{24})?) (blob|commit|tree) ([0-9]+)$/);
    if (!match || match[1] !== hashes[index] || match[2] !== kind) reject('', 'invalid-git-object');
    const bytes = Number(match[3]);
    if (!Number.isSafeInteger(bytes) || bytes > 512 * 1024 * 1024 - 1024) reject('', 'git-inspection-format');
    return { hash: match[1], bytes };
  });
  let offset = 0,lastYield=performance.now();
  while (offset < objects.length) {
    const batch = []; let size = 0;
    while (offset < objects.length && (!batch.length || size + objects[offset].bytes < 16 * 1024 * 1024)) {
      const object = objects[offset++]; batch.push(object); size += object.bytes + 100;
    }
    const output = await git(['cat-file', '--batch'], Buffer.from(batch.map(item => item.hash).join('\n') + '\n'));
    let cursor = 0;
    for (const object of batch) {
      if(performance.now()-lastYield>=5){await yieldLoop();lastYield=performance.now();}
      const end = output.indexOf(10, cursor);
      if (end < 0 || output.subarray(cursor, end).toString('ascii') !== `${object.hash} ${kind} ${object.bytes}`) reject('', 'git-inspection-format');
      cursor = end + 1;
      if (cursor + object.bytes >= output.length || output[cursor + object.bytes] !== 10) reject('', 'git-inspection-format');
      const content = output.subarray(cursor, cursor + object.bytes);
      const hashStarted=performance.now();
      const digest = createHash(object.hash.length === 40 ? 'sha1' : 'sha256').update(`${kind} ${object.bytes}\0`).update(content).digest('hex');
      if(metrics){metrics.hash_ms+=performance.now()-hashStarted;metrics.object_reads[kind]=(metrics.object_reads[kind]??0)+1;metrics.object_bytes[kind]=(metrics.object_bytes[kind]??0)+object.bytes;}
      if (digest !== object.hash) reject('', 'invalid-git-object');
      await inspect(object.hash, content);
      cursor += object.bytes + 1;
    }
    if (cursor !== output.length) reject('', 'git-inspection-format');
  }
}

export function validateOutgoingCommit(content) { return validateCommitMetadata(content); }
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
  const tree = headers.filter(line => line.startsWith('tree '));
  const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (tree.length !== 1 || !OBJECT_HASH.test(tree[0].slice(5)) || parents.some(hash => !OBJECT_HASH.test(hash))) reject(path, 'invalid-commit-metadata');
  return { tree: tree[0].slice(5), parents };
}

/** Read index and reachable commits as raw Git objects, never worktree links. */
export async function validateStagedRepository(repoDir, { runGit, historyApproval, repository, branch, validationSession, onValidation, gitBatchFactory, computePool } = {}) {
  const session = validationSession === undefined ? null : validationSessions.get(validationSession);
  if (validationSession !== undefined && (!session || session.failed)) reject('', 'invalid-validation-session');
  // Reject a concurrent caller before it can change the first caller's scope.
  if (session?.busy) reject('', 'concurrent-validation-session');
  if (session) session.busy = true;
  const startedAt=performance.now(),metrics={hash_ms:0,semantic_ms:0,object_reads:{},object_bytes:{},git_calls:0,git_commands:{}};
  let batch; const semanticJobs = [];
  try {
  const approval = validateSyncHistoryApproval(historyApproval, { repository, branch });
  if (session) {
    const context = JSON.stringify([resolve(repoDir), repository ?? null, branch ?? null, approval ?? null]);
    if (session.context !== context) { session.verified.clear(); session.context = context; }
  }
  const approvedCommits = new Set(approval?.commits ?? []);
  const approvedFiles = new Map((approval?.files ?? []).map(file => [file.path, file]));
  const execute = runGit ?? defaultGit(repoDir);
  batch=gitBatchFactory?.() ?? (!runGit ? createGitBatch({cwd:repoDir,env:{GIT_DIR:resolve(repoDir,'.git'),GIT_WORK_TREE:repoDir,GIT_INDEX_FILE:resolve(repoDir,'.git/index')}}) : null);
  const git = async (args, input) => {
    try { metrics.git_calls++;metrics.git_commands[args.slice(0,args[0]==='cat-file'?2:1).join(' ')]=(metrics.git_commands[args.slice(0,args[0]==='cat-file'?2:1).join(' ')]??0)+1; return commandOutput(await (batch && args[0]==='cat-file' ? batch.run(args,{input}) : execute(args, { cwd: repoDir, encoding: 'buffer', input }))); }
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
  const commits = new Map();
  await inspectObjects(git, revisions, 'commit', (hash, content) => {
    commits.set(hash, validateCommitMetadata(content, approvedCommits.has(hash)));
  }, metrics);
  // A shallow/grafted walk must never certify only a suffix of history.
  for (const commit of commits.values()) for (const parent of commit.parents)
    if (!commits.has(parent)) reject('', 'incomplete-git-history');
  const { trees, files: historicalFiles } = await inspectTrees(git, [...commits.values()].map(commit => commit.tree), approvedFiles, metrics);
  // The approved file cannot be introduced, removed, or changed by any later
  // commit, including either side of a merge. Compare already verified raw trees
  // instead of spawning diff-tree for each historical revision.
  if (approvedFiles.size) for (const [hash, commit] of commits) {
    if (approvedCommits.has(hash)) continue;
    for (const parent of commit.parents.length ? commit.parents : [null]) {
      const previous = parent === null ? null : commits.get(parent);
      if (parent !== null && !previous) reject('', 'incomplete-git-history');
      for (const path of approvedFiles.keys()) {
        const before = previous ? entryAtPath(trees, previous.tree, path) : null;
        if (before !== entryAtPath(trees, commit.tree, path)) reject('', 'changed-approved-document');
      }
    }
  }
  const inspected = new Set(), pending = new Map();
  let semanticYield=performance.now(),semanticEntries=0;
  for (const { path, hash } of [...index, ...historicalFiles]) {
    if(++semanticEntries%512===0&&performance.now()-semanticYield>=5){await yieldLoop();semanticYield=performance.now();}
    // Identical bytes in JSON and README are validated under both file formats.
    const approved = approvedFiles.get(path);
    const identity = `${approved ? `approved-document:${path}` : isReviewSyncPath(path) ? `review:${path}` : isDraftSyncPath(path) ? `draft:${path}` : 'data'}:${hash}:${path.endsWith('.json') ? 'json' : 'text'}`;
    if (inspected.has(identity)) continue;
    inspected.add(identity);
    if (!pending.has(hash)) pending.set(hash, []);
    pending.get(hash).push({ path, approved, identity });
  }
  let checked = 0, reused = 0;
  // Own compact bytes: a subarray otherwise clones the entire 16 MiB Git batch
  // for each worker message. Batch only distinct paths; older versions of the
  // same path must each be checked, never overwritten in a Map.
  let semanticFiles = new Map(), semanticIdentities = [], semanticBytes = 0;
  let semanticFailure;
  const flushSemantic = async () => {
    if (!semanticFiles.size) return;
    const files = semanticFiles, identities = semanticIdentities, started = performance.now();
    semanticFiles = new Map(); semanticIdentities = []; semanticBytes = 0;
    // At most two compact batches in flight, matching the existing CPU pool.
    // Resolve errors into a retained failure so no background rejection escapes.
    semanticJobs.push(computePool.run('validateFiles', { files }).then(() => {
      metrics.semantic_ms += performance.now() - started;
      for (const identity of identities) { if (!session?.failed) session?.verified.add(identity); checked++; }
    }, error => { semanticFailure ??= error; }));
    if (semanticJobs.length >= 2) await semanticJobs.shift();
    if (semanticFailure) throw semanticFailure;
  };
  await inspectObjects(git, [...pending.keys()], 'blob', async (hash, content) => {
    for (const { path, approved, identity } of pending.get(hash)) {
    if (session?.verified.has(identity)) { reused++; continue; }
    const semanticStarted=performance.now();
    if (approved) {
      if (content.length !== approved.bytes || createHash('sha256').update(content).digest('hex') !== approved.sha256) reject(path, 'changed-approved-document');
      scanText(textContent(content, path), path);
    } else if (computePool) {
      if (semanticFiles.has(path) || semanticBytes + content.length > 2 * 1024 * 1024) await flushSemantic();
      semanticFiles.set(path, Buffer.from(content)); semanticIdentities.push(identity); semanticBytes += content.length;
      continue;
    } else validateBundleFiles(new Map([[path, content]]));
    metrics.semantic_ms+=performance.now()-semanticStarted;
    session?.verified.add(identity); checked++;
  }
  }, metrics);
  await flushSemantic();
  await Promise.all(semanticJobs);
  if (semanticFailure) throw semanticFailure;
  onValidation?.({ objects: pending.size, checked, reused, commits: commits.size, trees: trees.size, ...metrics, duration_ms:performance.now()-startedAt, rss_bytes:process.memoryUsage().rss });
  return { ok: true, fileCount: index.length };
  } catch (error) {
    if (session) { session.verified.clear(); session.failed = true; }
    throw error;
  } finally { await Promise.all(semanticJobs); try { await batch?.close(); } catch {if(session){session.verified.clear();session.failed=true;}reject('', 'git-inspection-failed');} finally { if (session) session.busy = false; } }
}
