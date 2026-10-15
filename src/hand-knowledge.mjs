// Viewer-only memory. Learn identities only through the existing local-perspective
// visibility gate; never recover a hidden identity from its raw grpId or name.
const emptyNames = new Map();
const has = (a, type) => (Array.isArray(a.type) ? a.type : [a.type]).includes(`AnnotationType_${type}`);
export function prepareHandKnowledge(state, gsm) {
  state.handKnowledge ??= { current:new Map(), history:new Map(), serial:0 };
  const memory = state.handKnowledge;
  if (gsm.gameInfo?.gameNumber != null && state.gameInfo?.gameNumber != null && gsm.gameInfo.gameNumber !== state.gameInfo.gameNumber) {
    memory.current.clear(); memory.history.clear(); memory.serial=0;
  }
  const handZones = new Set([...state.zones.values(),...(gsm.zones ?? [])].filter(z=>z.type==='ZoneType_Hand').map(z=>z.zoneId));
  // A hand randomization may break individual identity tracking. Library-only
  // shuffling does not erase knowledge of cards still in the opponent's hand.
  for (const a of gsm.annotations ?? []) if (has(a,'Shuffle')) {
    const affected = [a.affectorId,...(a.affectedIds ?? [])];
    if (affected.some(id=>handZones.has(id))) memory.current.clear();
    else for (const id of affected) memory.current.delete(id);
  }
  memory.terminal = state.ended || state.roomCompleted || gsm.gameInfo?.stage==='GameStage_GameOver';
}
export function updateHandKnowledge(state) {
  const memory=state.handKnowledge;
  if (!memory) return;
  const membership=new Map();
  for (const zone of state.zones.values()) if (zone.type==='ZoneType_Hand' && [1,2].includes(zone.ownerSeatId) && zone.ownerSeatId!==state.localSeat)
    for (const id of zone.objectInstanceIds ?? []) membership.set(id,zone.ownerSeatId);
  for (const [id,record] of memory.current) if (membership.get(id)!==record.seat) memory.current.delete(id);
  if (memory.terminal) return;
  for (const [id,seat] of membership) {
    const observed=state.card(id,emptyNames);
    if (!observed || !['public','player_known'].includes(observed.visibility)) continue;
    const previous=memory.current.get(id);
    if (previous?.arenaId===observed.arena_id) continue;
    const record={id,seat,arenaId:observed.arena_id,token:++memory.serial};
    memory.current.set(id,record); memory.history.set(record.token,record);
  }
}
export function handKnowledgeView(state, seat, names) {
  const memory=state.handKnowledge;
  if (!memory) return { known:[], history:[] };
  const present=new Set([...state.zones.values()].filter(z=>z.type==='ZoneType_Hand' && z.ownerSeatId===seat).flatMap(z=>z.objectInstanceIds ?? []));
  const active=[...memory.current.values()].filter(r=>r.seat===seat && present.has(r.id));
  const activeTokens=new Set(active.map(r=>r.token));
  const view=(r,historical=false)=>({instance_id:historical?-r.token:r.id,arena_id:r.arenaId,name:names.get(r.arenaId) ?? `Arena card ${r.arenaId}`,
    visibility:'player_known',logical_id:`HandObservation${r.token}`,hand_knowledge:historical?'historical':'remembered'});
  return {known:active.map(r=>view(r)),history:[...memory.history.values()].filter(r=>r.seat===seat && !activeTokens.has(r.token)).map(r=>view(r,true))};
}
