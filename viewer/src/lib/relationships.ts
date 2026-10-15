import type { CanonicalEvent, GameState } from '../types/game.ts';

export type Endpoint = { card: number } | { player: number };
export interface Relationship { from: Endpoint; to: Endpoint; kind: 'source' | 'target'; }
const hidden = (raw: Record<string, unknown>) => raw.hidden === true || /hidden|post.?game/i.test(String(raw.visibility ?? ''));

/** Resolve only identities already present in this frame; never match by name or printed card ID. */
export function boardRelationships(state: GameState, event?: CanonicalEvent, localSeat = 1): Relationship[] {
  const links = new Map<string, Relationship>();
  const seats = new Set(state.players.map(player => player.systemSeatId));
  const opponent = state.players.find(player => player.systemSeatId !== localSeat)?.systemSeatId;
  function endpoint(raw?: Record<string, unknown>): Endpoint | undefined {
    if (!raw || hidden(raw)) return;
    if (raw.player === 'me') return seats.has(localSeat) ? { player: localSeat } : undefined;
    if (raw.player === 'opponent') return opponent != null && seats.has(localSeat) ? { player: opponent } : undefined;
    const id = Number(raw.instance_id ?? raw.instanceId);
    const card = state.gameObjects.get(id) ?? (raw.logical_id ? [...state.gameObjects.values()].find(c => c.logicalId === raw.logical_id) : undefined);
    if (card && !hidden(card as unknown as Record<string, unknown>)) return { card: card.instanceId };
  }
  function add(from: Endpoint | undefined, to: Endpoint | undefined, kind: Relationship['kind']) {
    if (!from || !to || JSON.stringify(from) === JSON.stringify(to)) return;
    const link = { from, to, kind };
    links.set(JSON.stringify(link), link);
  }
  for (const card of state.stackObjects) {
    const stack = endpoint({ instance_id: card.instanceId });
    add(endpoint(card.abilitySource), stack, 'source');
    // Explicitly redacted targets take precedence over any raw IDs retained by older adapters.
    if (card.targets?.length) for (const target of card.targets) add(stack, endpoint(target), 'target');
    else for (const id of card.targetIds ?? []) add(stack, endpoint({ instance_id: id }), 'target');
  }
  if (event && ['cast', 'target', 'damage', 'activate', 'trigger'].includes(event.type ?? '')) {
    const from = endpoint(event.card);
    for (const target of event.targets ?? []) {
      const to = endpoint(target);
      // An event may name the permanent that created the ability. Its stack item
      // already carries that target; keep the source -> ability -> target chain.
      const represented = state.stackObjects.some(card => {
        const stack = endpoint({ instance_id: card.instanceId });
        const source = endpoint(card.abilitySource);
        return (JSON.stringify(from) === JSON.stringify(stack) || (source && JSON.stringify(from) === JSON.stringify(source))) &&
          [...links.values()].some(link => link.kind === 'target' && JSON.stringify(link.from) === JSON.stringify(stack) && JSON.stringify(link.to) === JSON.stringify(to));
      });
      if (!represented) add(from, to, 'target');
    }
  }
  return [...links.values()];
}
