import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultDataDir } from './history.mjs';

const pending = new Map();
let requestQueue = Promise.resolve(), lastRequest = 0;
const failedImages = new Map();
const cachePath = (dataDir, arenaId, extension) => join(dataDir, 'cards', `${arenaId}.${extension}`);
function validateId(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid Arena card ID.');
}
async function request(url, fetchFn) {
  const result = requestQueue.then(async () => {
    const delay = Math.max(0, 120 - (Date.now() - lastRequest));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastRequest = Date.now();
    return fetchFn(url, { headers: { 'User-Agent': 'mtga-gpt-replay/0.2 (private local replay viewer)', Accept: 'application/json,image/*' }, signal: AbortSignal.timeout(8000) });
  });
  requestQueue = result.then(() => {}, () => {});
  return result;
}
async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}
function normalizeCard(card, id, local) {
  const face = card.card_faces?.[0];
  const image = card.image_uris?.normal ?? face?.image_uris?.normal;
  return { ...local, arena_id: id, name: card.name ?? local.name,
    mana_cost: card.mana_cost ?? face?.mana_cost ?? local.mana_cost,
    type_line: card.type_line ?? face?.type_line ?? local.type_line,
    // Printed card stats must never inherit dynamic values from later replay frames.
    power: card.power ?? face?.power, toughness: card.toughness ?? face?.toughness,
    oracle_text: card.oracle_text ?? (card.card_faces?.map(face => `${face.name}\n${face.oracle_text ?? ''}`).join('\n\n')),
    keywords: Array.isArray(card.keywords) ? [...card.keywords] : undefined,
    layout: card.layout,
    scryfall_id: card.id, image_source: image,
    card_faces: card.card_faces?.map(face => ({ name: face.name, mana_cost: face.mana_cost, type_line: face.type_line,
      oracle_text: face.oracle_text, power: face.power, toughness: face.toughness,
      keywords: face.keywords,
      image_source: face.image_uris?.normal })),
    source: 'scryfall', cache_schema: 2, rules_schema: 1, fetched_at: new Date().toISOString(),
  };
}

/** Only a public Arena ID/card name is requested from Scryfall; no replay data leaves the Mac. */
export async function getCardMetadata(arenaId, { dataDir = defaultDataDir(), local = {}, fetchFn = fetch } = {}) {
  validateId(arenaId);
  const filename = cachePath(dataDir, arenaId, 'json');
  let previousSafeMetadata;
  try {
    const cached = JSON.parse(await readFile(filename, 'utf8'));
    const safePrinted = cached.source === 'scryfall' && cached.cache_schema === 2;
    if ((cached.source !== 'scryfall' || (safePrinted && (cached.rules_schema === 1 || cached.retry_after > Date.now())))
      && (!cached.retry_after || cached.retry_after > Date.now())) return cached;
    if (safePrinted) previousSafeMetadata = cached;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const key = `${dataDir}:${arenaId}:metadata`;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    await mkdir(join(dataDir, 'cards'), { recursive: true, mode: 0o700 });
    let card;
    try {
      let response = await request(`https://api.scryfall.com/cards/arena/${arenaId}`, fetchFn);
      if (!response.ok && local.name && !/^Arena card \d+$/.test(local.name)) {
        response = await request(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(local.name)}`, fetchFn);
      }
      if (response.ok) card = await response.json();
    } catch { /* Offline/rate limited: the local board remains usable. */ }
    const metadata = card ? normalizeCard(card, arenaId, local) : previousSafeMetadata ? { ...previousSafeMetadata, retry_after: Date.now() + 60_000 } : { ...local, arena_id: arenaId, name: local.name ?? `Arena card ${arenaId}`,
      source: 'local', image_available: false, retry_after: Date.now() + 60_000 };
    await atomicWrite(filename, JSON.stringify(metadata));
    return metadata;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

export async function getCardImage(arenaId, options = {}) {
  validateId(arenaId);
  const dataDir = options.dataDir ?? defaultDataDir(), filename = cachePath(dataDir, arenaId, 'jpg');
  try {
    const data = await readFile(filename);
    const metadata = JSON.parse(await readFile(cachePath(dataDir, arenaId, 'json'), 'utf8'));
    return { data, contentType: metadata.image_content_type ?? 'image/jpeg' };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const key = `${dataDir}:${arenaId}:image`;
  if ((failedImages.get(key) ?? 0) > Date.now()) return null;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const metadata = await getCardMetadata(arenaId, options);
    if (!metadata.image_source) return null;
    let url;
    try { url = new URL(metadata.image_source); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'cards.scryfall.io') return null;
    try {
      const response = await request(url.href, options.fetchFn ?? fetch);
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type')?.split(';')[0];
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) return null;
      const data = Buffer.from(await response.arrayBuffer());
      if (!data.length || data.length > 8 * 1024 * 1024) return null;
      await atomicWrite(filename, data);
      await atomicWrite(cachePath(dataDir, arenaId, 'json'), JSON.stringify({ ...metadata, image_content_type: contentType }));
      return { data, contentType };
    } catch { failedImages.set(key, Date.now() + 60_000); return null; }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

export async function cardImageIsCached(arenaId, { dataDir = defaultDataDir() } = {}) {
  try { return (await stat(cachePath(dataDir, arenaId, 'jpg'))).isFile(); } catch { return false; }
}
