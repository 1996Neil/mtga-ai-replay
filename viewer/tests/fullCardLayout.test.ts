import test from 'node:test';
import assert from 'node:assert/strict';
import { fitFullCardRows } from '../src/lib/fullCardLayout.ts';
import type { FullCardItem, FullCardLayout, FullCardLayoutOptions } from '../src/lib/fullCardLayout.ts';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 1e-7, `${actual} differs from ${expected}`);

// Independently measure the returned rectangles, rather than trust usedWidth /
// usedHeight or repeat the implementation's partition search.
function assertGeometry(items: readonly FullCardItem[], width: number, height: number, layout: FullCardLayout,
  { gap = 6, captionHeight = 18, headingHeight = 0 }: FullCardLayoutOptions = {}) {
  assert.deepEqual(layout.rows.flat(), items.map((_, index) => index), 'each original instance appears once, in order');
  assert.ok(layout.cardWidth > 0);
  let y = headingHeight, measuredWidth = 0;
  for (const row of layout.rows) {
    assert.ok(row.length > 0);
    let x = 0, faceHeight = 0;
    for (const [position, index] of row.entries()) {
      const tapped = items[index].tapped === true;
      const cardWidth = layout.cardWidth * (tapped ? 1.4 : 1);
      const cardHeight = layout.cardWidth * (tapped ? 1 : 1.4);
      if (position) x += gap;
      assert.ok(x + cardWidth <= width + 1e-7, 'complete face remains inside the panel');
      x += cardWidth; faceHeight = Math.max(faceHeight, cardHeight);
    }
    measuredWidth = Math.max(measuredWidth, x);
    y += faceHeight + captionHeight;
    assert.ok(y <= height + 1e-7, 'caption and complete face remain inside the panel');
    y += gap;
  }
  near(layout.usedWidth, measuredWidth); near(layout.usedHeight, y - gap);
  assert.ok(layout.usedWidth <= width + 1e-7); assert.ok(layout.usedHeight <= height + 1e-7);
}

test('roomy panels keep the card cap and reserve exact upright and tapped geometry', () => {
  const upright = fitFullCardRows([{}], 500, 500), sideways = fitFullCardRows([{ tapped: true }], 500, 500);
  assert.equal(upright.cardWidth, 118); assert.equal(sideways.cardWidth, 118);
  near(upright.usedWidth, 118); near(upright.usedHeight, 183.2);
  near(sideways.usedWidth, 165.2); near(sideways.usedHeight, 136);
  assertGeometry([{}], 500, 500, upright); assertGeometry([{ tapped: true }], 500, 500, sideways);
});

test('six upright faces reach the exact maximum allowed by a two-row panel', () => {
  const items = Array.from({ length: 6 }, () => ({})), layout = fitFullCardRows(items, 312, 322);
  near(layout.cardWidth, 100); assert.equal(layout.rows.length, 2);
  near(layout.usedWidth, 312); near(layout.usedHeight, 322);
  assertGeometry(items, 312, 322, layout);
});

test('all-tapped rows use their shorter height rather than reserving upright height', () => {
  const items = Array.from({ length: 4 }, () => ({ tapped: true })), layout = fitFullCardRows(items, 400, 250);
  near(layout.cardWidth, 104); assert.equal(layout.rows.length, 2);
  near(layout.usedWidth, 297.2); near(layout.usedHeight, 250);
  assertGeometry(items, 400, 250, layout);
});

test('heading space and custom captions participate in the fit', () => {
  const items = [{}, { tapped: true }], options = { maxCardWidth: 150, gap: 8, captionHeight: 24, headingHeight: 30 };
  const layout = fitFullCardRows(items, 248, 194, options);
  near(layout.cardWidth, 100); assert.deepEqual(layout.rows, [[0, 1]]);
  near(layout.usedWidth, 248); near(layout.usedHeight, 194);
  assertGeometry(items, 248, 194, layout, options);
});

test('twenty mixed instances shrink into a narrow panel without overlap, omissions, or input mutation', () => {
  const items = Object.freeze(Array.from({ length: 20 }, (_, index) => Object.freeze({ tapped: index % 3 === 0 })));
  const before = JSON.stringify(items), layout = fitFullCardRows(items, 160, 420);
  assert.ok(layout.cardWidth < 118); assert.ok(layout.rows.length > 1);
  assertGeometry(items, 160, 420, layout); assert.equal(JSON.stringify(items), before);
  assert.deepEqual(fitFullCardRows(items, 160, 420), layout, 'identical inputs have deterministic geometry');
});

test('wide-short and tall-narrow panels both retain all instances', () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ tapped: index % 2 === 0 }));
  for (const [width, height] of [[1100, 90], [58, 1200], [320, 240]]) {
    assertGeometry(items, width, height, fitFullCardRows(items, width, height));
  }
});

test('subpixel panels have no minimum card-size clamp when fixed labels are disabled', () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ tapped: index % 2 === 0 }));
  const options = { captionHeight: 0, gap: 0 }, layout = fitFullCardRows(items, 0.25, 0.3, options);
  assert.ok(layout.cardWidth < 0.1); assertGeometry(items, 0.25, 0.3, layout, options);
});

test('loading, nonfinite and nonpositive dimensions return finite zero geometry safely', () => {
  assert.deepEqual(fitFullCardRows(undefined, 100, 100), { cardWidth: 0, rows: [], usedWidth: 0, usedHeight: 0 });
  assert.deepEqual(fitFullCardRows([], 100, 100), { cardWidth: 0, rows: [], usedWidth: 0, usedHeight: 0 });
  const items = [{}, { tapped: true }];
  for (const [width, height] of [[0, 100], [-1, 100], [100, 0], [NaN, 100], [100, Infinity]]) {
    assert.deepEqual(fitFullCardRows(items, width, height), { cardWidth: 0, rows: [[0, 1]], usedWidth: 0, usedHeight: 0 });
  }
});

test('impossible fixed labels never force thumbnails outside a tiny panel', () => {
  const items = [{}, {}, {}];
  for (const [width, height, options] of [[1, 17, {}], [100, 30, { headingHeight: 20 }], [1, 40, {}]] as const) {
    const layout = fitFullCardRows(items, width, height, options);
    assert.deepEqual(layout.rows.flat(), [0, 1, 2]); assert.equal(layout.cardWidth, 0);
    assert.equal(layout.usedWidth, 0); assert.equal(layout.usedHeight, 0);
  }
});
