import { createHash } from 'node:crypto';
import { readDraftCapture, projectDraftCaptures } from './draft-capture.mjs';
import { draftLinkPath, parseDraftLinks, validateDraftLinkSources } from './draft-link-contract.mjs';
export const serializeDraft = value => JSON.stringify(value, null, 2) + '\n';
export const draftDigest = value => createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const INDEX = /^drafts\/accounts\/([a-f0-9]{64})\/index\.json$/;
const CHUNK = /^drafts\/accounts\/([a-f0-9]{64})\/objects\/([a-f0-9]{64})\.json$/;
const LINKS = /^drafts\/accounts\/([a-f0-9]{64})\/bindings\.json$/;
export const isDraftSyncPath = path => path === 'drafts/index.json' || INDEX.test(path) || CHUNK.test(path) || LINKS.test(path);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const fail = () => { throw new Error('Invalid sanitized draft backup.'); };
const accountRoot = key => `drafts/accounts/${key}`;
const parseCache = new Map(); let parseBytes = 0;
const chunkCaches = new Map();
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function parseDraftBackup(path, text) {
  const previous = parseCache.get(path);
  if (previous?.text === text) return previous.value;
  const value = freeze(parseDraftBackupFresh(path, text)), bytes = Buffer.byteLength(text);
  if (previous) { parseCache.delete(path); parseBytes -= previous.bytes; }
  if (bytes <= 4 * 1024 * 1024) {
    while (parseCache.size >= 128 || parseBytes + bytes > 4 * 1024 * 1024) {
      const first = parseCache.keys().next().value;
      parseBytes -= parseCache.get(first).bytes; parseCache.delete(first);
    }
    parseCache.set(path, { text, value, bytes }); parseBytes += bytes;
  }
  return value;
}

export function validateDraftObservation(item) {
  if (!exact(item, ['observation_id', 'adapter', 'kind', 'event_id', 'pack_number', 'pick_number', 'card_ids', 'logged_at', 'account_key']) ||
    !SHA.test(item.observation_id) || !SHA.test(item.account_key) || item.adapter !== '17lands-log-v2' || !['pack', 'pick'].includes(item.kind) ||
    !/^[A-Za-z][A-Za-z0-9_-]{1,120}$/.test(item.event_id) || !integer(item.pack_number, 1, 3) || !integer(item.pick_number, 1, 30) ||
    !Array.isArray(item.card_ids) || !integer(item.card_ids.length, 1, 100) || item.card_ids.some(id => !integer(id, 1, 2147483647)) ||
    typeof item.logged_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(item.logged_at) ||
    !Number.isFinite(Date.parse(item.logged_at))) fail();
}

function parseDraftBackupFresh(path, text) {
  if (!isDraftSyncPath(path) || typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) fail();
  if (LINKS.test(path)) return parseDraftLinks(path, text);
  const value = JSON.parse(text);
  if (serializeDraft(value) !== text) fail();
  if (path === 'drafts/index.json') {
    if (!exact(value, ['schema', 'accounts']) || !['MTGA_DRAFT_ACCOUNTS_V1', 'MTGA_DRAFT_ACCOUNTS_V2'].includes(value.schema) || !Array.isArray(value.accounts) || value.accounts.length > 10000) fail();
    const seen = new Set();
    for (const a of value.accounts) {
      if (!exact(a, ['account_key', 'path', 'sha256', 'bytes', 'observations', ...(value.schema === 'MTGA_DRAFT_ACCOUNTS_V2' ? ['bindings'] : [])]) || !SHA.test(a.account_key) || seen.has(a.account_key) ||
        a.path !== `${accountRoot(a.account_key)}/index.json` || !SHA.test(a.sha256) || !integer(a.bytes, 1, 4 * 1024 * 1024) || !integer(a.observations, 1, 10000000)) fail();
      if (value.schema === 'MTGA_DRAFT_ACCOUNTS_V2' && (!exact(a.bindings, ['path', 'sha256', 'bytes', 'runs']) ||
        a.bindings.path !== draftLinkPath(a.account_key) || !SHA.test(a.bindings.sha256) ||
        !integer(a.bindings.bytes, 1, 4 * 1024 * 1024) || !integer(a.bindings.runs, 0, 10000))) fail();
      seen.add(a.account_key);
    }
  } else if (INDEX.test(path)) {
    const key = INDEX.exec(path)[1];
    if (!exact(value, ['schema', 'adapter', 'account_key', 'observations', 'gaps', 'chunks']) || value.schema !== 'MTGA_DRAFT_INDEX_V1' ||
      value.account_key !== key || value.adapter !== '17lands-log-v2' || !integer(value.observations, 1, 10000000) || !integer(value.gaps, 0, 10000000) ||
      !Array.isArray(value.chunks) || value.chunks.length > 100000) fail();
    const seen = new Set(); let count = 0;
    for (const chunk of value.chunks) {
      if (!exact(chunk, ['path', 'sha256', 'bytes', 'count']) || !SHA.test(chunk.sha256) ||
        chunk.path !== `${accountRoot(key)}/objects/${chunk.sha256}.json` || seen.has(chunk.path) ||
        !integer(chunk.bytes, 1, 4 * 1024 * 1024) || !integer(chunk.count, 1, 100)) fail();
      seen.add(chunk.path); count += chunk.count;
    }
    if (count !== value.observations) fail();
  } else {
    const [, key, hash] = CHUNK.exec(path);
    if (!exact(value, ['schema', 'account_key', 'observations']) || value.schema !== 'MTGA_DRAFT_OBSERVATIONS_V1' || value.account_key !== key ||
      !Array.isArray(value.observations) || !integer(value.observations.length, 1, 100) || draftDigest(text) !== hash) fail();
    const seen = new Set();
    for (const item of value.observations) {
      validateDraftObservation(item);
      if (item.account_key !== key || seen.has(item.observation_id)) fail();
      seen.add(item.observation_id);
    }
  }
  return value;
}

export function buildDraftBackup({ observations, gaps }, { chunkCache = new Map(), onBuild } = {}) {
  const byAccount = new Map(), files = new Map(), accounts = [];
  for (const item of observations) {
    if (!SHA.test(item.account_key ?? '')) continue; // Unknown ownership remains LOCAL, never guessed/uploaded.
    const items = byAccount.get(item.account_key) ?? []; items.push(item); byAccount.set(item.account_key, items);
  }
  for (const [account_key, items] of [...byAccount].sort(([a], [b]) => a.localeCompare(b))) {
    const chunks = [], root = accountRoot(account_key);
    for (let i = 0; i < items.length; i += 100) {
      const block = items.slice(i, i + 100), key = `${account_key}:${i}`, prior = chunkCache.get(key);
      if (prior && block.length === prior.items.length && block.every((item, n) => item === prior.items[n])) {
        files.set(prior.descriptor.path, prior.text); chunks.push(prior.descriptor);
        onBuild?.({ built: 0, reused: 1 });
        continue;
      }
      const text = serializeDraft({ schema: 'MTGA_DRAFT_OBSERVATIONS_V1', account_key, observations: items.slice(i, i + 100) });
      const sha256 = draftDigest(text), path = `${root}/objects/${sha256}.json`;
      parseDraftBackup(path, text); files.set(path, text);
      const descriptor = { path, sha256, bytes: Buffer.byteLength(text), count: block.length };
      chunks.push(descriptor);
      if (chunkCache.size >= 512 && !chunkCache.has(key)) chunkCache.delete(chunkCache.keys().next().value);
      chunkCache.set(key, { items: block, text, descriptor }); onBuild?.({ built: 1, reused: 0 });
    }
    const index = { schema: 'MTGA_DRAFT_INDEX_V1', adapter: '17lands-log-v2', account_key, observations: items.length, gaps, chunks };
    const text = serializeDraft(index), path = `${root}/index.json`;
    parseDraftBackup(path, text); files.set(path, text);
    accounts.push({ account_key, path, sha256: draftDigest(text), bytes: Buffer.byteLength(text), observations: items.length });
  }
  const index = { schema: 'MTGA_DRAFT_ACCOUNTS_V1', accounts }, text = serializeDraft(index);
  files.set('drafts/index.json', text);
  const snapshot = { files, index, content_hash: draftDigest(text), observations: accounts.reduce((n, a) => n + a.observations, 0) };
  validateDraftBackup(snapshot); return snapshot;
}

export function validateDraftBackup(snapshot) {
  if (!(snapshot.files instanceof Map)) fail();
  const text = snapshot.files.get('drafts/index.json'), root = parseDraftBackup('drafts/index.json', text);
  if (draftDigest(text) !== snapshot.content_hash) fail();
  const seen = new Set(), paths = new Set(['drafts/index.json']);
  for (const account of root.accounts) {
    const body = snapshot.files.get(account.path);
    if (typeof body !== 'string' || Buffer.byteLength(body) !== account.bytes || draftDigest(body) !== account.sha256) fail();
    const index = parseDraftBackup(account.path, body); paths.add(account.path);
    if (index.observations !== account.observations) fail();
    const observations = [];
    for (const chunk of index.chunks) {
      const body = snapshot.files.get(chunk.path);
      if (typeof body !== 'string' || Buffer.byteLength(body) !== chunk.bytes || draftDigest(body) !== chunk.sha256) fail();
      const parsed = parseDraftBackup(chunk.path, body); paths.add(chunk.path);
      if (parsed.observations.length !== chunk.count) fail();
      for (const item of parsed.observations) {
        if (seen.has(item.observation_id)) fail();
        seen.add(item.observation_id);
        observations.push(item);
      }
    }
    if (account.bindings) {
      const { path, bytes, sha256, runs } = account.bindings, text = snapshot.files.get(path);
      if (typeof text !== 'string' || Buffer.byteLength(text) !== bytes || draftDigest(text) !== sha256) fail();
      const doc = parseDraftLinks(path, text);
      if (doc.runs.length !== runs) fail();
      validateDraftLinkSources(doc, projectDraftCaptures(observations, { gaps: index.gaps }));
      paths.add(path);
    }
  }
  if (paths.size !== snapshot.files.size || [...snapshot.files.keys()].some(p => !paths.has(p))) fail();
  return root;
}
export function attachDraftBindings(snapshot, documents) {
  const files = new Map(snapshot.files), accounts = snapshot.index.accounts.map(account => {
    const doc = documents.get(account.account_key);
    if (!doc) fail();
    const path = draftLinkPath(account.account_key), text = serializeDraft(doc);
    parseDraftLinks(path, text); files.set(path, text);
    return { ...account, bindings: { path, sha256: draftDigest(text), bytes: Buffer.byteLength(text), runs: doc.runs.length } };
  });
  const index = { schema: 'MTGA_DRAFT_ACCOUNTS_V2', accounts }, text = serializeDraft(index);
  files.set('drafts/index.json', text);
  const result = { ...snapshot, files, index, content_hash: draftDigest(text) };
  validateDraftBackup(result); return result;
}
export async function createDraftBackup(options) {
  let chunkCache = chunkCaches.get(options.dataDir);
  if (!chunkCache) {
    if (chunkCaches.size >= 4) chunkCaches.delete(chunkCaches.keys().next().value);
    chunkCache = new Map(); chunkCaches.set(options.dataDir, chunkCache);
  }
  return buildDraftBackup(await readDraftCapture(options), { chunkCache, onBuild: options.onBuild });
}
