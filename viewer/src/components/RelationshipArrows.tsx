import { useId, useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { boardRelationships } from '../lib/relationships';
import type { Endpoint, Relationship } from '../lib/relationships';
import type { CanonicalEvent, GameState } from '../types/game';
import type { CombatLink } from '../lib/combatPresentation';

interface Line { key: string; kind: Relationship['kind'] | CombatLink['kind']; from: string; to: string; x1: number; y1: number; x2: number; y2: number; }
export function RelationshipArrows({ board, state, event, localSeat, combatLinks = [] }: { board: RefObject<HTMLElement | null>; state: GameState; event?: CanonicalEvent; localSeat: number; combatLinks?: CombatLink[] }) {
  const marker = useId().replace(/:/g, '');
  const [drawing, setDrawing] = useState<{ width: number; height: number; lines: Line[] }>({ width: 0, height: 0, lines: [] });
  useEffect(() => {
    const root = board.current;
    if (!root) return;
    let frame = 0;
    const links = [...boardRelationships(state, event, localSeat), ...combatLinks];
    function element(endpoint: Endpoint) {
      return root!.querySelector<HTMLElement>('card' in endpoint ? `[data-card-instance="${endpoint.card}"]` : `[data-player-seat="${endpoint.player}"]`);
    }
    function center(el: HTMLElement, bounds: DOMRect) {
      const art = el.querySelector('.card-art-viewport') ?? el.querySelector('.life-total') ?? el;
      const rect = art.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (rect.width <= 0 || rect.height <= 0 || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
      // Omit an endpoint scrolled out of its own clipped card list.
      for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
        const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
        if ((/(auto|scroll|hidden|clip)/.test(style.overflowX) && (x < clip.left || x > clip.right)) ||
            (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (y < clip.top || y > clip.bottom))) return;
      }
      return { x: x - bounds.left, y: y - bounds.top };
    }
    function measure() {
      frame = 0;
      const bounds = root!.getBoundingClientRect();
      const lines: Line[] = [];
      for (const link of links) {
        const from = element(link.from), to = element(link.to);
        if (!from || !to) continue;
        const a = center(from, bounds), b = center(to, bounds);
        if (!a || !b) continue;
        lines.push({ key: JSON.stringify(link), kind: link.kind, from: JSON.stringify(link.from), to: JSON.stringify(link.to), x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      const next = { width: bounds.width, height: bounds.height, lines };
      setDrawing(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(measure); }
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    // Observe card regions so layout fitting and analysis mode also move the arrows.
    root.querySelectorAll('.full-card-zone, .contextual-stack, .player-header, .hand-scroll').forEach(el => resize.observe(el));
    const mutation = new MutationObserver(schedule);
    root.querySelectorAll('.full-card-zone, .contextual-stack').forEach(el => mutation.observe(el, { childList: true, subtree: true, attributes: true }));
    root.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    schedule();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); root.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); };
  }, [board, state, event, localSeat, combatLinks]);
  if (!drawing.width || !drawing.lines.length) return null;
  return <svg className="relationship-arrows" viewBox={`0 0 ${drawing.width} ${drawing.height}`} aria-label="来源与目标指向" role="img">
    <title>白色为异能来源，黄色为目标，橙色虚线为攻击，蓝色为阻挡；卡牌 A 编号表示对应关系</title>
    <defs>{(['source', 'target', 'attack', 'block'] as const).map(kind => <marker key={kind} id={`${marker}-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill={{ source: '#f1f3f5', target: '#fff36a', attack: '#f3b46d', block: '#7ed7e6' }[kind]} />
    </marker>)}</defs>
    {drawing.lines.map(line => <line key={line.key} data-kind={line.kind} data-from={line.from} data-to={line.to} className={`relationship-arrow ${line.kind}`} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} markerEnd={`url(#${marker}-${line.kind})`} />)}
  </svg>;
}
