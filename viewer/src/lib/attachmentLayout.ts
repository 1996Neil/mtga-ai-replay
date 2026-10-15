import type { CardInstance } from '../types/game.ts';

/** Observed links only; keep every instance exactly once, even for broken links.
 * Explicit attachedTo wins. Ambiguous reverse links and cycles stay separate. */
export function attachmentLayout(cards: readonly CardInstance[]) {
  const byId = new Map(cards.map(card => [card.instanceId, card]));
  const parents = new Map<number, number>();
  for (const card of cards) {
    if (card.attachedTo != null) {
      if (card.attachedTo !== card.instanceId && byId.has(card.attachedTo)) parents.set(card.instanceId, card.attachedTo);
      continue;
    }
    const hosts = cards.filter(host => host.instanceId !== card.instanceId && host.attachments?.includes(card.instanceId));
    if (hosts.length === 1) parents.set(card.instanceId, hosts[0].instanceId);
  }
  // Remove every cycle edge, retaining the cards as roots instead of losing them.
  for (const id of [...parents.keys()]) {
    const path: number[] = []; let next: number | undefined = id;
    while (next !== undefined && !path.includes(next)) { path.push(next); next = parents.get(next); }
    if (next !== undefined) for (const member of path.slice(path.indexOf(next))) parents.delete(member);
  }
  const groups = new Map<number, CardInstance[]>();
  for (const card of cards) {
    let root = card.instanceId;
    while (parents.has(root)) root = parents.get(root)!;
    if (root !== card.instanceId) groups.set(root, [...(groups.get(root) ?? []), card]);
  }
  return { roots: cards.filter(card => !parents.has(card.instanceId)), groups };
}
