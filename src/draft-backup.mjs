import { createHash } from 'node:crypto';
import { readDraftCapture } from './draft-capture.mjs';
export const serializeDraft = value => JSON.stringify(value, null, 2) + '\n';
export const draftDigest = value => createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const INDEX = /^drafts\/accounts\/([a-f0-9]{64})\/index\.json$/;
const CHUNK = /^drafts\/accounts\/([a-f0-9]{64})\/objects\/([a-f0-9]{64})\.json$/;
export const isDraftSyncPath = path => path === 'drafts/index.json' || INDEX.test(path) || CHUNK.test(path);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const fail = () => { throw new Error('Invalid sanitized draft backup.'); };
const accountRoot = key => `drafts/accounts/${key}`;

export function validateDraftObservation(item) {
  if (!exact(item, ['observation_id', 'adapter', 'kind', 'event_id', 'pack_number', 'pick_number', 'card_ids', 'logged_at', 'account_key']) ||
    !SHA.test(item.observation_id) || !SHA.test(item.account_key) || item.adapter !== '17lands-bot-log-v1' || !['pack', 'pick'].includes(item.kind) ||
    !/^QuickDraft_[A-Za-z0-9_]{1,100}$/.test(item.event_id) || !integer(item.pack_number, 1, 3) || !integer(item.pick_number, 1, 30) ||
    !Array.isArray(item.card_ids) || !integer(item.card_ids.length, 1, 100) || item.card_ids.some(id => !integer(id, 1, 2147483647)) ||
    typeof item.logged_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(item.logged_at) ||
    !Number.isFinite(Date.parse(item.logged_at))) fail();
}

export function parseDraftBackup(path, text) {
  if (!isDraftSyncPath(path) || typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) fail();
  const value = JSON.parse(text);
  if (serializeDraft(value) !== text) fail();
  if (path === 'drafts/index.json') {
    if (!exact(value, ['schema', 'accounts']) || value.schema !== 'MTGA_DRAFT_ACCOUNTS_V1' || !Array.isArray(value.accounts) || value.accounts.length > 10000) fail();
    const seen = new Set();
    for (const a of value.accounts) {
      if (!exact(a, ['account_key', 'path', 'sha256', 'bytes', 'observations']) || !SHA.test(a.account_key) || seen.has(a.account_key) ||
        a.path !== `${accountRoot(a.account_key)}/index.json` || !SHA.test(a.sha256) || !integer(a.bytes, 1, 4 * 1024 * 1024) || !integer(a.observations, 1, 10000000)) fail();
      seen.add(a.account_key);
    }
  } else if (INDEX.test(path)) {
    const key = INDEX.exec(path)[1];
    if (!exact(value, ['schema', 'adapter', 'account_key', 'observations', 'gaps', 'chunks']) || value.schema !== 'MTGA_DRAFT_INDEX_V1' ||
      value.account_key !== key || value.adapter !== '17lands-bot-log-v1' || !integer(value.observations, 1, 10000000) || !integer(value.gaps, 0, 10000000) ||
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

export function buildDraftBackup({ observations, gaps }) {
  const byAccount = new Map(), files = new Map(), accounts = [];
  for (const item of observations) {
    if (!SHA.test(item.account_key ?? '')) continue; // Unknown ownership remains LOCAL, never guessed/uploaded.
    const items = byAccount.get(item.account_key) ?? []; items.push(item); byAccount.set(item.account_key, items);
  }
  for (const [account_key, items] of [...byAccount].sort(([a], [b]) => a.localeCompare(b))) {
    const chunks = [], root = accountRoot(account_key);
    for (let i = 0; i < items.length; i += 100) {
      const text = serializeDraft({ schema: 'MTGA_DRAFT_OBSERVATIONS_V1', account_key, observations: items.slice(i, i + 100) });
      const sha256 = draftDigest(text), path = `${root}/objects/${sha256}.json`;
      parseDraftBackup(path, text); files.set(path, text);
      chunks.push({ path, sha256, bytes: Buffer.byteLength(text), count: Math.min(100, items.length - i) });
    }
    const index = { schema: 'MTGA_DRAFT_INDEX_V1', adapter: '17lands-bot-log-v1', account_key, observations: items.length, gaps, chunks };
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
    for (const chunk of index.chunks) {
      const body = snapshot.files.get(chunk.path);
      if (typeof body !== 'string' || Buffer.byteLength(body) !== chunk.bytes || draftDigest(body) !== chunk.sha256) fail();
      const parsed = parseDraftBackup(chunk.path, body); paths.add(chunk.path);
      if (parsed.observations.length !== chunk.count) fail();
      for (const item of parsed.observations) {
        if (seen.has(item.observation_id)) fail();
        seen.add(item.observation_id);
      }
    }
  }
  if (paths.size !== snapshot.files.size || [...snapshot.files.keys()].some(p => !paths.has(p))) fail();
  return root;
}
export async function createDraftBackup(options) { return buildDraftBackup(await readDraftCapture(options)); }
