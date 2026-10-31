const publicZones = new Set(['ZoneType_Battlefield', 'ZoneType_Graveyard', 'ZoneType_Stack', 'ZoneType_Command']);
const faceDown = o => o.isFaceDown === true || /FaceDown/i.test(o.face ?? o.status ?? '') || (o.grpId ?? 0) <= 0;

export function identityVisibility(object, zones, localSeat) {
  if (!object || !Number.isInteger(localSeat) || faceDown(object)) return 'hidden';
  const zone = zones.get(object.zoneId);
  const viewers = object.viewers ?? [];
  if (object.visibility === 'Visibility_Hidden') return 'hidden';
  if (object.visibility === 'Visibility_Private') {
    if (!viewers.includes(localSeat)) return 'hidden';
    return 'player_known';
  }
  // Hand/library/exile require explicit visibility; never trust a grpId alone.
  if (object.visibility === 'Visibility_Public') return 'public';
  if (publicZones.has(zone?.type)) return 'public';
  if (zone?.type === 'ZoneType_Hand' && object.ownerSeatId === localSeat) return 'player_known';
  return 'hidden';
}

export class PerspectiveState {
  constructor(localSeat) {
    this.localSeat = localSeat; this.objects = new Map(); this.zones = new Map();
    this.players = new Map(); this.turn = {}; this.gameInfo = {}; this.ended = false;
  }
  apply(gsm) {
    prepareVisualState(this, gsm);
    this.deletedIds = gsm.diffDeletedInstanceIds ?? [];
    if (gsm.type === 'GameStateType_Full') {
      this.objects.clear(); this.zones.clear();
    }
    for (const z of gsm.zones ?? []) {
      const zone = { ...this.zones.get(z.zoneId), ...z };
      // Full zone observations omit their repeated IDs when empty. A minimal
      // zoneId-only delta still preserves membership.
      if (z.type && ('visibility' in z || 'ownerSeatId' in z) && !('objectInstanceIds' in z)) zone.objectInstanceIds = [];
      this.zones.set(z.zoneId, zone);
    }
    for (const o of gsm.gameObjects ?? []) {
      const previous = this.objects.get(o.instanceId);
      const merged = { ...previous, ...o };
      if (o.type && 'grpId' in o && 'visibility' in o) {
        // Proto defaults are omitted in a complete changed-object observation.
        merged.isTapped = o.isTapped ?? o.status === 'StatusType_Tapped';
        merged.attackState = o.attackState ?? 'AttackState_None';
        merged.blockState = o.blockState ?? 'BlockState_None';
        merged.attackInfo = o.attackInfo; merged.blockInfo = o.blockInfo;
        // Complete changed-object observations omit protobuf zero/false defaults.
        // Partial object deltas retain the last observed resource state.
        merged.damage = o.damage ?? 0;
        merged.hasSummoningSickness = o.hasSummoningSickness ?? false;
        merged.isCopy = o.isCopy ?? false;
      }
      if (previous && o.zoneId !== undefined && o.zoneId !== previous.zoneId && !('visibility' in o)) {
        delete merged.visibility; delete merged.viewers;
      }
      this.objects.set(o.instanceId, merged);
    }
    // Zone membership is authoritative even when a delta omits object.zoneId.
    const incoming = new Map((gsm.gameObjects ?? []).map(o => [o.instanceId, o]));
    for (const z of gsm.zones ?? []) for (const id of z.objectInstanceIds ?? []) {
      const object = this.objects.get(id);
      if (object && object.zoneId !== z.zoneId) {
        object.zoneId = z.zoneId;
        if (!('visibility' in (incoming.get(id) ?? {}))) { delete object.visibility; delete object.viewers; }
      }
    }
    for (const id of gsm.diffDeletedInstanceIds ?? []) this.objects.delete(id);
    for (const p of gsm.players ?? []) {
      const player = { ...this.players.get(p.systemSeatNumber), ...p };
      if ('status' in p && !('manaPool' in p)) player.manaPool = [];
      this.players.set(p.systemSeatNumber, player);
    }
    if (gsm.turnInfo) {
      if (gsm.turnInfo.phase && gsm.turnInfo.phase !== this.turn.phase) this.turn.step = '';
      this.turn = { ...this.turn, ...gsm.turnInfo };
    }
    this.gameInfo = { ...this.gameInfo, ...gsm.gameInfo };
    updateVisualState(this, gsm);
  }
  card(id, names) {
    if (this.terminalCards) return this.terminalCards.get(id) ?? null;
    const o = this.objects.get(id);
    const visibility = identityVisibility(o, this.zones, this.localSeat);
    if (visibility === 'hidden' || this.ended) return null;
    return { name: names.get(o.grpId) ?? `Arena card ${o.grpId}`, arena_id: o.grpId, instance_id: id,
      logical_id: this.logicalIds?.get(id) ?? `C${id}`, visibility };
  }
  target(id, names) {
    if (this.players.has(id)) return { player: id === this.localSeat ? 'me' : 'opponent' };
    return this.card(id, names) ?? { hidden: true };
  }
  actor(id) {
    if (this.players.has(id)) return id === this.localSeat ? 'me' : 'opponent';
    const o = this.objects.get(id);
    const seat = o?.controllerSeatId ?? o?.ownerSeatId;
    return seat === undefined ? 'unknown' : seat === this.localSeat ? 'me' : 'opponent';
  }
  safeMessage(message) {
    const gsm = message.gameStateMessage;
    const objects = [...this.objects.values()].map(o => {
      const known = identityVisibility(o, this.zones, this.localSeat) !== 'hidden' && !this.ended && !this.roomCompleted;
      return { instanceId: o.instanceId, grpId: known ? o.grpId : 0, type: o.type,
        ownerSeatId: o.ownerSeatId, controllerSeatId: o.controllerSeatId, zoneId: o.zoneId,
        power: typeof o.power === 'object' ? o.power.value : o.power,
        toughness: typeof o.toughness === 'object' ? o.toughness.value : o.toughness,
        isTapped: o.isTapped ?? o.status === 'StatusType_Tapped' };
    });
    for (const id of this.deletedIds ?? []) objects.push({ instanceId: id, grpId: 0 });
    return { ...message, systemSeatIds: [this.localSeat], gameStateMessage: {
      ...gsm, gameObjects: objects, zones: [...this.zones.values()], players: [...this.players.values()],
      turnInfo: this.turn, gameInfo: this.gameInfo,
    } };
  }
}
import { prepareVisualState, updateVisualState } from './visual-state.mjs';
