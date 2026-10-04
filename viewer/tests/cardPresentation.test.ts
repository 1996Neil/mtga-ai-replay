import test from 'node:test';
import assert from 'node:assert/strict';
import { handFanLayout, visibleCardId, printedCardStats } from '../src/lib/cardPresentation.ts';
import { useHoverStore } from '../src/store/hoverStore.ts';
import { useCardCacheStore } from '../src/store/cardCacheStore.ts';
import type { CardInstance } from '../src/types/game.ts';
const card = (id: number): CardInstance => ({ instanceId: id, grpId: id + 100, zoneId: 101, ownerSeatId: 1, controllerSeatId: 1,
  cardTypes: [], isTapped: false, isAttacking: false, counters: {} });

test('hand cards stay 128px while crowded hands overlap and extreme hands scroll', () => {
  const normal = handFanLayout(3, 1000), crowded = handFanLayout(12, 800), extreme = handFanLayout(40, 700);
  assert.equal(normal.cardWidth, 128); assert.equal(crowded.cardWidth, 128); assert.equal(extreme.cardWidth, 128);
  assert.equal(normal.stride, 142); assert.ok(crowded.stride < 128); assert.ok(crowded.width <= 768);
  assert.equal(extreme.stride, 28); assert.ok(extreme.width > 700);
  assert.equal(handFanLayout(0, 700).width, 0);
});

test('only visible positive Arena ids enter card image or metadata requests', () => {
  assert.equal(visibleCardId(101, { visibility: 'public' }), 101);
  assert.equal(visibleCardId(101, { visibility: 'hidden' }), 0);
  assert.equal(visibleCardId(101, { visibility: 'post_game_revealed' }), 0);
  assert.equal(visibleCardId(0), 0); assert.equal(visibleCardId(-1), 0); assert.equal(visibleCardId(NaN), 0);
});

test('card click pins preview; hover or mouse leave cannot replace it; repeat click closes', () => {
  const a = card(1), b = card(2), store = useHoverStore.getState(); store.close();
  store.preview(a); assert.equal(useHoverStore.getState().card, a); assert.equal(useHoverStore.getState().pinned, false);
  store.clearPreview(a); assert.equal(useHoverStore.getState().card, null);
  store.togglePinned(a); store.preview(b); store.clearPreview(a);
  assert.equal(useHoverStore.getState().card, a); assert.equal(useHoverStore.getState().pinned, true);
  store.togglePinned(b); assert.equal(useHoverStore.getState().card, b);
  store.togglePinned(b); assert.equal(useHoverStore.getState().card, null); assert.equal(useHoverStore.getState().pinned, false);
});

test('frame navigation forcibly clears pinned preview to avoid showing a future card', () => {
  useHoverStore.getState().togglePinned(card(2));
  useHoverStore.getState().setHovered(null);
  assert.equal(useHoverStore.getState().card, null); assert.equal(useHoverStore.getState().pinned, false);
});

test('offline later buffed stats never backfill an earlier hand or Before snapshot', () => {
  const earlyHand = { ...card(5), name: 'Galewind Moose' };
  const laterBattlefield = { ...earlyHand, power: 8, toughness: 8 };
  // A local offline API cache has the final dynamic observation, not printed card data.
  useCardCacheStore.getState().put(earlyHand.grpId, { arena_id: earlyHand.grpId, name: earlyHand.name,
    power: '8', toughness: '8', source: 'local' });
  const localStats = printedCardStats(useCardCacheStore.getState().cards.get(earlyHand.grpId));
  assert.equal(earlyHand.power ?? localStats.power, undefined);
  assert.equal(earlyHand.toughness ?? localStats.toughness, undefined);
  assert.equal(laterBattlefield.power ?? localStats.power, 8);
  assert.equal(laterBattlefield.toughness ?? localStats.toughness, 8);
  // Only card data explicitly sourced from Scryfall can supply a printed fallback.
  const printed = printedCardStats({ source: 'scryfall', power: '6', toughness: '6' });
  assert.equal(earlyHand.power ?? printed.power, '6');
  assert.equal(laterBattlefield.power ?? printed.power, 8);
  assert.equal(printedCardStats({ power: '8', toughness: '8' }).power, undefined);
});
