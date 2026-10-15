// Presentation provenance from observed GRE causes, not card-text inference.
const has = (a, type) => (Array.isArray(a.type) ? a.type : [a.type]).includes(`AnnotationType_${type}`);
const detail = (a, key) => { const d = a.details?.find(d => d.key === key); return (d?.valueInt32 ?? d?.valueString ?? [])[0]; };
const valid = id => Number.isSafeInteger(id) && id > 0;
const emptyNames = new Map();
function inZone(state, id, type) {
  const object = state.objects.get(id), zone = object && state.zones.get(object.zoneId);
  return zone?.type === `ZoneType_${type}` && zone.objectInstanceIds?.includes(id);
}

/** Called before PerspectiveState merges/deletes objects. A resolving ability
 * can disappear in the very frame which records its exile effect. */
export function prepareExileLinks(state, gsm) {
  state.exileLinks ??= new Map();
  if (gsm.gameInfo?.gameNumber != null && state.gameInfo?.gameNumber != null && gsm.gameInfo.gameNumber !== state.gameInfo.gameNumber) state.exileLinks.clear();
  const incoming = new Map((gsm.gameObjects ?? []).map(o => [o.instanceId, o]));
  const created = new Map();
  for (const a of gsm.annotations ?? []) if (has(a,'AbilityInstanceCreated') && valid(a.affectorId)) {
    for (const id of a.affectedIds ?? []) if (valid(id)) created.set(id, created.has(id) && created.get(id) !== a.affectorId ? null : a.affectorId);
  }
  const read = id => state.objects.has(id) || incoming.has(id) ? { ...state.objects.get(id), ...incoming.get(id) } : undefined;
  function source(id) {
    const seen = new Set();
    while (valid(id) && !seen.has(id)) {
      seen.add(id); const object = read(id);
      if (object?.type !== 'GameObjectType_Ability' && !created.has(id)) return object && valid(object.instanceId) ? object.instanceId : undefined;
      const parent = object?.parentId ?? created.get(id);
      if (object?.parentId != null && created.has(id) && created.get(id) !== object.parentId) return;
      id = parent;
    }
  }
  state.exileCandidates = [];
  for (const a of gsm.annotations ?? []) {
    if (!has(a,'ZoneTransfer') || detail(a,'category') !== 'Exile' || detail(a,'zone_src') === detail(a,'zone_dest')) continue;
    const host = source(a.affectorId); if (!valid(host)) continue;
    for (const id of a.affectedIds ?? []) if (valid(id) && id !== host) state.exileCandidates.push({ id, host, annotationId:a.id, destination:detail(a,'zone_dest') });
  }
}

/** No lifetime/rules simulation: an entry is active only while these exact
 * instances remain in exile and on the battlefield respectively. */
export function updateExileLinks(state) {
  for (const [id, link] of state.exileLinks ?? []) {
    if (!inZone(state,id,'Exile') || !inZone(state,link.host,'Battlefield')) state.exileLinks.delete(id);
  }
  const groups = new Map();
  for (const candidate of state.exileCandidates ?? []) groups.set(candidate.id,[...(groups.get(candidate.id) ?? []),candidate]);
  for (const [id, candidates] of groups) {
    if (new Set(candidates.map(c=>c.host)).size !== 1) { state.exileLinks.delete(id); continue; }
    const candidate = candidates[0];
    if (state.objects.get(id)?.zoneId !== candidate.destination || !inZone(state,id,'Exile') || !inZone(state,candidate.host,'Battlefield')) continue;
    // Never let a future reveal turn an anonymous historical cause into a link.
    if (!state.card(id,emptyNames) || !state.card(candidate.host,emptyNames)) continue;
    state.exileLinks.set(id,{ host:candidate.host, annotationId:candidate.annotationId });
  }
  state.exileCandidates = [];
}

export function visibleExileSource(state, id, names) {
  const link = state.exileLinks?.get(id);
  if (!link || !inZone(state,id,'Exile') || !inZone(state,link.host,'Battlefield') || !state.card(id,names) || !state.card(link.host,names)) return;
  return { instance_id:link.host, logical_id:state.logicalIds?.get(link.host) ?? `C${link.host}`, annotation_id:link.annotationId };
}
