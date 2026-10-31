import type { CombatLink } from './combatPresentation.ts';

/** View-only focus. Never change a recorded attack target or infer a new edge. */
export function combatFocus(links: readonly CombatLink[], selected: number | null) {
  const related = new Set<number>();
  const active = selected !== null && links.some(link =>
    ('card' in link.from && link.from.card === selected) || ('card' in link.to && link.to.card === selected));
  if (active) {
    related.add(selected!);
    for (const link of links) {
      if (('card' in link.from && link.from.card === selected) || ('card' in link.to && link.to.card === selected)) {
        if ('card' in link.from) related.add(link.from.card);
        if ('card' in link.to) related.add(link.to.card);
      }
    }
  }
  const blocked = new Set(links.filter(link => link.kind === 'block' && 'card' in link.to).map(link => (link.to as {card:number}).card));
  const visible = links.filter(link => {
    if (link.suppressed || (link.kind === 'attack' && 'card' in link.from && blocked.has(link.from.card))) return false;
    return !active || ('card' in link.from && link.from.card === selected) || ('card' in link.to && link.to.card === selected);
  });
  return { active, related, visible };
}

/** Fixed-size faces; overflow is scrollable rather than shrinking the card. */
export function lightHandFan(count: number, width: number, cardWidth = 104) {
  const n = Math.max(0, Math.floor(count));
  const available = Math.max(0, width - 24);
  const stride = n <= 1 ? 0 : Math.max(n <= 7 ? 18 : 26, Math.min(43, (available - cardWidth) / (n - 1)));
  const used = n ? cardWidth + (n - 1) * stride : 0;
  const offset = 12 + Math.max(0, (available - used) / 2);
  return { cardWidth, stride, width: Math.max(width, used + 24), cards: Array.from({length:n}, (_, index) => {
    const t = n <= 1 ? 0 : index / (n - 1) * 2 - 1;
    return { x: offset + index * stride, angle: t * 5, y: t * t * 10 };
  }) };
}
