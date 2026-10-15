import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultDataDir } from './history.mjs';
import { selectPrintedFace } from './card-image-identity.mjs';
import { getEnglishRuinsImage } from './card-image-fallback.mjs';

const pending = new Map();
let requestQueue = Promise.resolve(), lastRequest = -Infinity;
const failedImages = new Map();
let metadataActive = 0; const metadataWaiters = [];
async function metadataSlot(callback) {
  if(metadataWaiters.length>=32)throw Error('Public metadata queue is full');
  if (metadataActive >= 2) await new Promise(resolve => metadataWaiters.push(resolve));
  else metadataActive++;
  try { return await callback(); }
  finally { const next = metadataWaiters.shift(); if(next)next(); else metadataActive--; }
}
const cachePath = (dataDir, arenaId, extension) => join(dataDir, 'cards', `${arenaId}.${extension}`);
function validateId(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid Arena card ID.');
}
let imageActive=0;const imageWaiters=[];
async function imageSlot(callback){if(imageWaiters.length>=32)throw Error('Public image queue is full');if(imageActive>=2)await new Promise(resolve=>imageWaiters.push(resolve));else imageActive++;try{return await callback();}finally{const next=imageWaiters.shift();if(next)next();else imageActive--;}}
async function request(url, fetchFn) {
  const start = requestQueue.then(async () => {
    const delay = Math.max(0, 120 - (performance.now() - lastRequest));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastRequest = performance.now();
  });
  requestQueue = start.catch(() => {});
  await start;
  return fetchFn(url, { redirect: 'error', headers: { 'User-Agent': 'mtga-gpt-replay/0.2 (private local replay viewer)', Accept: 'application/json,image/*' }, signal: AbortSignal.timeout(8000) });
}
async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}
function withIdentityStatus(metadata) {
  const verified = metadata.image_identity_status === 'verified' && metadata.identity_schema === 1 && metadata.image_identity?.lang === 'en';
  return { ...metadata, image_identity_status: verified ? 'verified'
    : metadata.image_identity_status === 'unverified' || metadata.source === 'local' ? 'unverified' : 'legacy_unverified' };
}
function normalizeCard(card, id, local, selected, identityVerified) {
  const face = selected?.face ?? card.card_faces?.[0];
  const secondary = selected?.identity.faceIndex === 1;
  return { ...local, arena_id: id, name: secondary ? face.name : card.name ?? local.name,
    mana_cost: secondary ? face.mana_cost : card.mana_cost ?? face?.mana_cost ?? local.mana_cost,
    type_line: secondary ? face.type_line : card.type_line ?? face?.type_line ?? local.type_line,
    power: secondary ? face.power : card.power ?? face?.power,
    toughness: secondary ? face.toughness : card.toughness ?? face?.toughness,
    oracle_text: secondary ? face.oracle_text : card.oracle_text ?? card.card_faces?.map(f => `${f.name}\n${f.oracle_text ?? ''}`).join('\n\n'),
    keywords: Array.isArray(face?.keywords ?? card.keywords) ? [...(face?.keywords ?? card.keywords)] : undefined,
    layout: card.layout, scryfall_id: card.id,
    image_source: selected ? selected.image : card.image_uris?.normal ?? face?.image_uris?.normal,
    image_identity: selected?.identity, identity_schema: selected ? 1 : undefined,
    image_identity_status: selected ? 'verified' : 'unverified',
    identity_verified: identityVerified,
    card_faces: card.card_faces?.map(f => ({ name: f.name, mana_cost: f.mana_cost, type_line: f.type_line,
      oracle_text: f.oracle_text, power: f.power, toughness: f.toughness, keywords: f.keywords, image_source: f.image_uris?.normal })),
    source: 'scryfall', cache_schema: 2, rules_schema: 1, fetched_at: new Date().toISOString(),
  };
}

/** Only public card identifiers leave the Mac. Local catalog identity prevents wrong-print/name substitutions. */
export async function getCardMetadata(arenaId, { dataDir = defaultDataDir(), local = {}, fetchFn = fetch, identityResolver } = {}) {
  validateId(arenaId);
  const key = `${dataDir}:${arenaId}:metadata`;
  if (pending.has(key)) return pending.get(key);
  const task = metadataSlot(async () => {
    const identity = await identityResolver?.(arenaId);
    const filename = cachePath(dataDir, arenaId, 'json');
    let previousSafeMetadata;
    try {
      const cached = withIdentityStatus(JSON.parse(await readFile(filename, 'utf8')));
      if (cached.arena_id !== undefined && cached.arena_id !== arenaId) throw new SyntaxError('Mismatched cached identity');
      const safePrinted = cached.source === 'scryfall' && cached.cache_schema === 2;
      if (cached.source === 'local' && cached.retry_after > Date.now()) return cached;
      const needsIdentity = identity?.faceIndex === 1 && (!cached.image_identity || cached.image_identity.primaryId !== identity.primaryId || cached.image_identity.faceIndex !== identity.faceIndex);
      if (!needsIdentity && (cached.source !== 'scryfall' || (safePrinted && (cached.rules_schema === 1 || cached.retry_after > Date.now())))
        && (!cached.retry_after || cached.retry_after > Date.now())) return cached;
      if (safePrinted && (!identity?.faceIndex || cached.image_identity?.primaryId === identity.primaryId)) previousSafeMetadata = cached;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await mkdir(join(dataDir, 'cards'), { recursive: true, mode: 0o700 });
    let card, selected, namedLookup = false, retryAfter = Date.now() + 60_000;
    try {
      let response = await request(`https://api.scryfall.com/cards/arena/${identity?.primaryId ?? arenaId}`, fetchFn);
      if (response.status === 404 && !identity && local.name && !/^Arena card \d+$/.test(local.name)) {
        namedLookup = true;
        response = await request(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(local.name)}`, fetchFn);
      }
      if (!response.ok) retryAfter = retryDeadline(response);
      if (response.ok) {
        const result = await response.json();
        selected = selectPrintedFace(result, identity);
        if ((!identity || selected) && (!namedLookup || result.name === local.name || result.card_faces?.some(face => face.name === local.name))) card = result;
      }
    } catch { /* Offline/rate limited: the local board remains usable. */ }
    const metadata = card ? normalizeCard(card, arenaId, local, selected, Boolean(selected) || !namedLookup || card.arena_id === arenaId) : previousSafeMetadata ? { ...previousSafeMetadata, retry_after: retryAfter } : { ...local, arena_id: arenaId, name: local.name ?? `Arena card ${arenaId}`,
      source: 'local', image_available: false, image_identity_status: 'unverified', retry_after: retryAfter };
    await atomicWrite(filename, JSON.stringify(metadata));
    return metadata;
  });
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

export function cardImageRetryAfter(arenaId, { dataDir = defaultDataDir() } = {}) {
  return Math.max(0, failedImages.get(`${dataDir}:${arenaId}:image`) ?? 0);
}
function retryDeadline(response) {
  const value = response?.headers.get('retry-after');
  const retry = value && /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value ?? '');
  return Math.max(Date.now() + 60_000, Number.isFinite(retry) ? retry : 0);
}
function cooldown(key, response) { failedImages.set(key, retryDeadline(response)); }
export function validImageBytes(data, type) {
  return type === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255 && data.length > 32 && data[data.length - 2] === 255 && data[data.length - 1] === 217
    : type === 'image/png' ? data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.subarray(12,16).toString() === 'IHDR' && data.subarray(-8,-4).toString() === 'IEND'
    : type === 'image/webp' && data.length >= 20 && data.readUInt32LE(4) + 8 === data.length && ['VP8 ', 'VP8L', 'VP8X'].includes(data.subarray(12,16).toString()) && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
}
async function imageBytes(response) {
  const contentType = response.headers.get('content-type')?.split(';')[0];
  if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) return null;
  const limit = 8 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) return null;
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel?.().catch(() => {}); return null; }
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  return data.length && validImageBytes(data, contentType) ? { data, contentType } : null;
}
export async function getCardImage(arenaId, options = {}) {
  validateId(arenaId);
  const dataDir = options.dataDir ?? defaultDataDir(), filename = cachePath(dataDir, arenaId, 'jpg');
  const key = `${dataDir}:${arenaId}:image`;
  if (pending.has(key)) return pending.get(key);
  const task = imageSlot(async () => {
    try {
      const data = await readFile(filename);
      const metadata = withIdentityStatus(JSON.parse(await readFile(cachePath(dataDir, arenaId, 'json'), 'utf8')));
      // Old secondary-face caches need revalidation; ordinary existing caches remain usable offline.
      const identity = await options.identityResolver?.(arenaId);
      if (!options.refreshImage && validImageBytes(data, metadata.image_content_type ?? 'image/jpeg') && data.length <= 8 * 1024 * 1024 && (!identity?.faceIndex || (metadata.image_identity?.faceIndex === identity.faceIndex && metadata.image_identity?.primaryId === identity.primaryId))) {
        return { data, contentType: metadata.image_content_type ?? 'image/jpeg', identityStatus: metadata.image_identity_status };
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (cardImageRetryAfter(arenaId, { dataDir }) > Date.now()) return null;
    const metadata = await getCardMetadata(arenaId, options);
    const fetchFn = options.fetchFn ?? fetch;
    let result, provider = 'scryfall', source = metadata.image_source;
    const identity = metadata.image_identity;
    if (!options.refreshImage && identity?.faceIndex === 1 && identity.side === 'front' && identity.primaryId !== arenaId) {
      try {
        const primary = JSON.parse(await readFile(cachePath(dataDir, identity.primaryId, 'json'), 'utf8'));
        const data = await readFile(cachePath(dataDir, identity.primaryId, 'jpg'));
        const contentType = primary.image_content_type ?? 'image/jpeg';
        if (primary.scryfall_id === identity.printingId && primary.image_source === source && data.length <= 8 * 1024 * 1024 && validImageBytes(data, contentType)) {
          result = { data, contentType };
          provider = primary.image_provider ?? 'scryfall';
          source = primary.image_download_source ?? primary.image_source;
        }
      } catch { /* No verified primary image is cached yet. */ }
    }
    try {
      const url = source ? new URL(source) : null;
      if (!result && url?.protocol === 'https:' && url.hostname === 'cards.scryfall.io' && !url.username && !url.password && !url.port) {
        const response = await request(url.href, fetchFn);
        result = await imageBytes(response);
        if (!result) cooldown(key, response);
      }
    } catch { cooldown(key); }
    if (!result && options.ruinsEnabled === true && metadata.image_identity_status === 'verified' && metadata.image_identity) {
      try {
        source = await getEnglishRuinsImage(metadata.image_identity, { enabled: true, request: url => request(url, fetchFn) });
        if (source) { result = await imageBytes(await request(source, fetchFn)); provider = 'mtgch'; }
      } catch { /* The local text fallback remains usable. */ }
    }
    if (!result) { if (!failedImages.has(key) || failedImages.get(key) <= Date.now()) cooldown(key); return null; }
    await atomicWrite(filename, result.data);
    await atomicWrite(cachePath(dataDir, arenaId, 'json'), JSON.stringify({ ...metadata, image_content_type: result.contentType,
      image_provider: provider, image_download_source: source }));
    failedImages.delete(key);
    return result;
  });
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
export async function cardImageIsCached(arenaId, { dataDir = defaultDataDir() } = {}) {
  try { return (await stat(cachePath(dataDir, arenaId, 'jpg'))).isFile(); } catch { return false; }
}
