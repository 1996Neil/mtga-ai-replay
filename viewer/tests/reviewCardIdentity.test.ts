import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewCardId, reviewCardTranslation } from '../src/replay/reviewCardIdentity.ts';
import type { CardInstance } from '../src/types/game.ts';
const card = (grpId: number, name = 'Forest', visibility = 'visible') => ({ grpId, name, visibility } as CardInstance);
test('review translations require exact English identity and one visible printing at the note boundary', () => {
  assert.equal(reviewCardId('Forest', new Map([[1, card(1)], [2, card(1)]])), 1);
  assert.equal(reviewCardId('Forest', new Map([[1, card(1)], [2, card(2)]])), 0);
  assert.equal(reviewCardId('Forest', new Map([[1, card(1, 'Forest', 'hidden')]])), 0);
  assert.equal(reviewCardId('Forest', new Map([[1, card(1, 'Forest', 'player_known')]])), 1);
  assert.equal(reviewCardId('Forest', new Map([[1, card(1, 'Forest', 'post_game')]])), 0);
  assert.equal(reviewCardId('forest', new Map([[1, card(1)]])), 0);
  assert.equal(reviewCardId('Forest'), 0);
  assert.equal(reviewCardTranslation('Forest', 'Forest', '树林'), '树林');
  assert.equal(reviewCardTranslation('Forest', 'Island', '海岛'), null);
  assert.equal(reviewCardTranslation('Forest', 'Forest'), null);
});
