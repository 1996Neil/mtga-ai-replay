export interface ArrowAnchor { x: number; y: number; width: number; height: number; }

/** Combat leaves the facing card edge consistently, including tapped cards.
 * Keep the original S curve with facing tangents; cap long combat handles.
 * No game relation changes. */
export function relationshipGeometry(kind: string, a: ArrowAnchor, b: ArrowAnchor) {
  const vertical = kind === 'attack' || kind === 'block' || Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
  const direction = Math.sign(b.y - a.y) || 1;
  const horizontal = Math.sign(b.x - a.x) || 1;
  const x1 = vertical ? a.x : a.x + horizontal * (a.width / 2 + 3);
  const y1 = vertical ? a.y + direction * (a.height / 2 + 3) : a.y;
  const x2 = vertical ? b.x : b.x - horizontal * (b.width / 2 + 3);
  const y2 = vertical ? b.y - direction * (b.height / 2 + 3) : b.y;
  const dx = x2 - x1, dy = y2 - y1;
  const combat = kind === 'attack' || kind === 'block';
  const verticalCurve = combat || Math.abs(dy) >= Math.abs(dx);
  // Preserve the original midpoint curve for ordinary source/target lines.
  // Combat always leaves/arrives vertically, without a lateral-distance switch.
  const span = verticalCurve ? dy : dx;
  const handleLength = combat ? Math.min(Math.abs(span) / 2, 180) : Math.abs(span) / 2;
  const handle = (Math.sign(span) || 1) * handleLength;
  const c1 = verticalCurve ? { x:x1, y:y1 + handle } : { x:x1 + handle, y:y1 };
  const c2 = verticalCurve ? { x:x2, y:y2 - handle } : { x:x2 - handle, y:y2 };
  return { x1, y1, x2, y2, c1, c2, handleLength,
    path: `M${x1},${y1} C${c1.x},${c1.y} ${c2.x},${c2.y} ${x2},${y2}` };
}
