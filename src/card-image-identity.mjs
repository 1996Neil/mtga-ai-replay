import { discoverCardDatabase } from './cards.mjs';

const links = value => String(value ?? '').split(/[,;|\s]+/).filter(Boolean).map(Number);
const collector = row => `${row.CollectorNumber}${row.CollectorSuffix ?? ''}`;
/** IDs are linked by Arena's catalog, never by similar names or shared artwork alone. */
export function resolveCatalogIdentity(row, linked) {
  if (!row || row.IsRebalanced) return null;
  // Arena numbers token printings in their parent expansion; the public
  // catalog stores that same token sheet separately (FRA -> TFRA).
  if (row.IsToken) {
    const token = { requestedId: row.GrpId, primaryId: row.GrpId, faceIndex: 0,
      set: `t${String(row.ExpansionCode).toLowerCase()}`, collector: collector(row), isToken: true };
    if (!links(row.LinkedFaceGrpIds).length) return token;
    // Arena's incubator tokens mark BOTH faces non-primary; use their explicit
    // reciprocal a/b relationship rather than the ordinary primary flag.
    if (linked?.IsToken && !linked.IsRebalanced && linked.ExpansionCode === row.ExpansionCode &&
        links(row.LinkedFaceGrpIds).length === 1 && links(linked.LinkedFaceGrpIds).length === 1 &&
        links(linked.LinkedFaceGrpIds)[0] === row.GrpId && String(row.CollectorNumber) === String(linked.CollectorNumber) &&
        [row.CollectorSuffix, linked.CollectorSuffix].sort().join('') === 'ab') {
      return { ...token, primaryId: row.CollectorSuffix === 'a' ? row.GrpId : linked.GrpId,
        faceIndex: row.CollectorSuffix === 'a' ? 0 : 1, collector: String(row.CollectorNumber) };
    }
    return { ...token, unresolved: true };
  }
  const reciprocal = linked && links(row.LinkedFaceGrpIds).length === 1 && links(linked.LinkedFaceGrpIds).length === 1
    && links(linked.LinkedFaceGrpIds)[0] === row.GrpId && linked.ExpansionCode === row.ExpansionCode;
  // Arena labels the two faces of e.g. NEO 141 as 141a/141b; the printing is 141.
  const primary = row.IsPrimaryCard ? row : linked, secondary = row.IsPrimaryCard ? linked : row;
  const faceSuffixPair = reciprocal && primary?.IsPrimaryCard && !secondary?.IsPrimaryCard
    && String(primary.CollectorNumber) === String(secondary.CollectorNumber)
    && primary.CollectorSuffix === 'a' && secondary.CollectorSuffix === 'b';
  const base = { requestedId: row.GrpId, primaryId: row.GrpId, faceIndex: 0,
    set: String(row.ExpansionCode).toLowerCase(), collector: faceSuffixPair ? String(row.CollectorNumber) : collector(row) };
  if (row.IsPrimaryCard) return base;
  if (links(row.LinkedFaceGrpIds).length !== 1 || !linked?.IsPrimaryCard || linked.IsToken || linked.IsRebalanced
    || !links(linked.LinkedFaceGrpIds).includes(row.GrpId)
    || links(linked.LinkedFaceGrpIds).length !== 1 || linked.ExpansionCode !== row.ExpansionCode
    || (!faceSuffixPair && collector(linked) !== collector(row))) return null;
  return { ...base, primaryId: linked.GrpId, faceIndex: 1 };
}

export function createCardIdentityResolver({ discover = discoverCardDatabase } = {}) {
  let path;
  const cache = new Map();
  return async id => {
    if (cache.has(id)) return cache.get(id);
    let db;
    try {
      path ??= await discover();
      if (!path) return null;
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(path, { readOnly: true });
      const query = db.prepare('SELECT GrpId, ExpansionCode, CollectorNumber, CollectorSuffix, IsPrimaryCard, IsToken, IsRebalanced, LinkedFaceGrpIds FROM Cards WHERE GrpId = ?');
      const row = query.get(id);
      const linked = row && links(row.LinkedFaceGrpIds).length === 1 ? query.get(links(row.LinkedFaceGrpIds)[0]) : null;
      const value = resolveCatalogIdentity(row, linked);
      cache.set(id, value);
      return value;
    } catch { return null; } finally { db?.close(); }
  };
}

const separateFaces = new Set(['transform', 'modal_dfc', 'double_faced_token', 'reversible_card']);
const sharedFaces = new Set(['prepare', 'adventure', 'split', 'aftermath', 'flip']);
export function selectPrintedFace(card, identity, {
  allowMissingArenaId = false,
  allowArenaIdAlias = false,
  allowNonEnglish = false,
} = {}) {
  if (!identity || identity.unresolved) return null;
  const arenaMatches = card.arena_id === identity.primaryId || allowMissingArenaId && card.arena_id == null;
  const exactArenaMatch = card.arena_id === identity.primaryId;
  // Scryfall appends an `a`/`b` suffix to a few Arena-only catalog numbers
  // (for example ANA 1 -> 1a). An explicit Arena ID is the authoritative
  // identity for that fallback response, so accept only this narrow alias.
  const collectorMatches = card.collector_number === identity.collector
    || exactArenaMatch && allowArenaIdAlias
      && [ `${identity.collector}a`, `${identity.collector}b` ].includes(card.collector_number);
  // Some Arena printings are intentionally non-English (currently the
  // Phyrexian basic lands). Their exact Arena ID still proves the printing;
  // a printing lookup without that ID must remain English-only.
  const phyrexianBasic = card.lang === 'ph'
    && ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'].includes(card.name);
  const languageMatches = card.lang === 'en' || allowNonEnglish && exactArenaMatch && phyrexianBasic;
  if (!languageMatches || !arenaMatches || card.set?.toLowerCase() !== identity.set
    || !collectorMatches || !card.id || !card.name) return null;
  if (identity.isToken && !['token', 'double_faced_token', 'emblem'].includes(card.layout)) return null;
  const face = identity.faceIndex ? card.card_faces?.[identity.faceIndex] : card.card_faces?.[0] ?? card;
  if (!face || (identity.faceIndex && !separateFaces.has(card.layout) && !sharedFaces.has(card.layout))) return null;
  const side = separateFaces.has(card.layout) && identity.faceIndex ? 'back' : 'front';
  const image = separateFaces.has(card.layout) ? card.card_faces?.[identity.faceIndex]?.image_uris?.normal
    : card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal;
  return { face, image, identity: { ...identity, side, lang: card.lang, printingId: card.id,
    oracleId: card.oracle_id, name: card.name, faceName: identity.faceIndex ? face.name : card.card_faces?.[0]?.name ?? card.name, layout: card.layout } };
}
