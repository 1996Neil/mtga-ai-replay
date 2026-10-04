export interface FullCardItem { tapped?: boolean }

export interface FullCardLayoutOptions {
  maxCardWidth?: number;
  gap?: number;
  captionHeight?: number;
  headingHeight?: number;
}

export interface FullCardLayout {
  /** Width of the upright card face; a tapped face occupies 1.4 times this. */
  cardWidth: number;
  /** Input indices in their original order, including repeated card instances. */
  rows: number[][];
  usedWidth: number;
  /** Includes the reserved heading, captions, and gaps between rows. */
  usedHeight: number;
}

const aspect = 7 / 5;
const nonnegative = (value: number | undefined, fallback: number) =>
  value === undefined ? fallback : Number.isFinite(value) ? Math.max(0, value) : 0;

/** Fit complete, disjoint card faces without clipping, scrolling, or a minimum
 * thumbnail size. Captions have fixed height; the caller owns their contents.
 *
 * A zero cardWidth means the panel is not measurable or cannot hold even the
 * fixed caption/heading geometry. Its rows still retain every input index, but
 * callers must wait for a usable panel rather than render that zero-size result.
 */
export function fitFullCardRows(
  items: readonly FullCardItem[] | null | undefined,
  width: number,
  height: number,
  options: FullCardLayoutOptions = {},
): FullCardLayout {
  const cards = Array.isArray(items) ? items : [];
  const count = cards.length;
  const indices = Array.from({ length: count }, (_, index) => index);
  const unavailable = (): FullCardLayout => ({ cardWidth: 0, rows: count ? [indices] : [], usedWidth: 0, usedHeight: 0 });
  if (!count || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return unavailable();

  const maxCardWidth = nonnegative(options.maxCardWidth, 118);
  const gap = nonnegative(options.gap, 6);
  const captionHeight = nonnegative(options.captionHeight, 18);
  const headingHeight = nonnegative(options.headingHeight, 0);
  const bodyHeight = height - headingHeight;
  const tapped = cards.map(card => card?.tapped === true);
  // Every face must fit individually, so these bounds also scale the search
  // interval correctly for subpixel panels without introducing a size floor.
  const upper = Math.min(maxCardWidth, width / (tapped.some(Boolean) ? aspect : 1),
    (bodyHeight - captionHeight) / (tapped.some(value => !value) ? aspect : 1));
  if (upper <= 0) return unavailable();

  const pack = (cardWidth: number, keepRows = false): FullCardLayout | null => {
    const heights = new Float64Array(count + 1).fill(Infinity);
    const rowCounts = new Float64Array(count + 1).fill(Infinity);
    const starts = keepRows ? new Int32Array(count + 1).fill(-1) : null;
    heights[0] = 0; rowCounts[0] = 0;
    // For each prefix, choose the partition with the least occupied height.
    // Unlike a widest-first greedy row, this accounts for all-tapped rows being
    // shorter than rows containing an upright card.
    for (let end = 1; end <= count; end++) {
      let widthUnits = 0, hasUpright = false;
      for (let start = end - 1; start >= 0; start--) {
        widthUnits += tapped[start] ? aspect : 1;
        hasUpright ||= !tapped[start];
        if (widthUnits * cardWidth + gap * (end - start - 1) > width) break;
        const nextHeight = heights[start] + (start ? gap : 0) + captionHeight + (hasUpright ? aspect : 1) * cardWidth;
        const nextRows = rowCounts[start] + 1;
        if (nextHeight < heights[end] || nextHeight === heights[end] && nextRows < rowCounts[end]) {
          heights[end] = nextHeight; rowCounts[end] = nextRows;
          if (starts) starts[end] = start;
        }
      }
    }
    const usedHeight = headingHeight + heights[count];
    if (usedHeight > height || !Number.isFinite(usedHeight)) return null;
    if (!starts) return { cardWidth, rows: [], usedWidth: 0, usedHeight };
    const rows: number[][] = [];
    for (let end = count; end > 0;) {
      const start = starts[end];
      rows.push(indices.slice(start, end)); end = start;
    }
    rows.reverse();
    const usedWidth = Math.max(...rows.map(row => row.reduce((sum, index) => sum + (tapped[index] ? aspect : 1), 0)
      * cardWidth + gap * (row.length - 1)));
    return { cardWidth, rows, usedWidth, usedHeight };
  };

  const atMaximum = pack(upper, true);
  if (atMaximum) return atMaximum;
  if (!pack(0)) return unavailable();
  // A given partition has monotone affine dimensions in cardWidth. Taking the
  // minimum height over all legal partitions therefore gives monotone fit.
  let low = 0, high = upper;
  for (let iteration = 0; iteration < 56; iteration++) {
    const middle = low + (high - low) / 2;
    if (pack(middle)) low = middle; else high = middle;
  }
  return low > 0 ? pack(low, true) ?? unavailable() : unavailable();
}
