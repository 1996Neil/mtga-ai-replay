// Public API schema verified 2026-10-15. Usage conditions/quotas remain unverified.
// Deliberately no environment switch or CLI flag: production activation needs review.
export const RUINS_DEFAULT_ENABLED = false;
export const RUINS_ENABLE_BLOCKER = 'Public API/CDN usage conditions and quotas have not been verified.';

export function verifiedEnglishRuinsImage(card, expected) {
  if (!expected || !expected.oracleId || card.id !== expected.printingId || card.oracle_id !== expected.oracleId
    || card.lang !== 'en' || card.arena_id !== expected.primaryId || card.name !== expected.name
    || card.layout !== expected.layout || card.set?.toLowerCase() !== expected.set
    || card.collector_number !== expected.collector) return null;
  const face = expected.faceIndex ? card.other_faces?.find(f => f.face_index === expected.faceIndex) : card;
  if (!face || face.lang !== 'en' || face.id !== expected.printingId || face.face_index !== expected.faceIndex
    || (face.face_name ?? face.name) !== expected.faceName) return null;
  try {
    const url = new URL(face.image_uris?.normal);
    const prefix = `/sf/normal/${expected.side}/`;
    if (url.protocol !== 'https:' || url.hostname !== 'images.mtgch.com' || url.port || url.username || url.password
      || !url.pathname.startsWith(prefix) || !url.pathname.endsWith(`/${expected.printingId}.webp`)) return null;
    return url.href;
  } catch { return null; }
}

export async function getEnglishRuinsImage(expected, { enabled = RUINS_DEFAULT_ENABLED, request } = {}) {
  if (!enabled || !expected) return null;
  const url = `https://mtgch.com/api/v1/card/${encodeURIComponent(expected.set)}/${encodeURIComponent(expected.collector)}/`;
  const response = await request(url);
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
  return verifiedEnglishRuinsImage(await response.json(), expected);
}
