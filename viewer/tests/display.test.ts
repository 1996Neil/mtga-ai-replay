import test from 'node:test';
import assert from 'node:assert/strict';
import { displayCardName, describeEventZh, phaseTextZh } from '../src/lib/display.ts';

test('Chinese display names remain separate from immutable English event identities', () => {
  const metadata = new Map([[5, { arena_id: 5, name: 'Canonical Card', display_name_zh: '中文卡名' }]]);
  const card = { name: 'Canonical Card', arena_id: 5, visibility: 'public' };
  const event = { type: 'cast', actor: 'me', card, targets: [{ name: 'Target Card', arena_id: 6, visibility: 'public' }] };
  const before = structuredClone(event);
  assert.equal(displayCardName(card, metadata), '中文卡名');
  assert.equal(displayCardName(card), 'Canonical Card');
  assert.equal(describeEventZh(event, metadata), '我施放 中文卡名 → Target Card');
  assert.deepEqual(event, before);
  assert.equal(metadata.get(5)?.name, 'Canonical Card');
});

test('display localization cannot expose hidden cards, hidden targets or opponent draw identities', () => {
  const secret = { name: 'Secret Sentinel', arena_id: 999, visibility: 'hidden' };
  const metadata = new Map([[999, '秘密中文哨兵']]);
  assert.equal(displayCardName(secret, metadata), '未知牌');
  const draw = describeEventZh({ type: 'draw', actor: 'opponent', card: { ...secret, visibility: 'public' }, amount: 2 }, metadata);
  assert.equal(draw, '对手抓 2 张牌');
  const target = describeEventZh({ type: 'target', card: { name: 'Public Card', arena_id: 5 }, targets: [secret] }, metadata);
  assert.equal(target, 'Public Card指定目标 → 未知牌');
  assert.doesNotMatch(`${draw} ${target}`, /Secret Sentinel|秘密中文哨兵|999/);
  assert.equal(displayCardName({ ...secret, visibility: 'post_game_revealed' }, metadata), '未知牌');
});

test('first-strike and normal combat damage remain distinct in Chinese with actual player targets', () => {
  const event = { type: 'damage', actor: 'opponent', card: { name: 'Scarblade Scout' }, amount: 4, targets: [{ name: 'Icecave Crasher' }], step: 'Step_FirstStrikeDamage' };
  assert.equal(describeEventZh(event), 'Scarblade Scout对Icecave Crasher造成 4 点先攻伤害');
  assert.equal(describeEventZh({ ...event, step: 'Step_CombatDamage', targets: [{ player: 'me' }] }), 'Scarblade Scout对我造成 4 点战斗伤害');
  assert.equal(phaseTextZh('Phase_Combat', 'Step_FirstStrikeDamage'), '战斗阶段 · 先攻伤害');
  assert.equal(phaseTextZh('Unobserved_phase', 'Unobserved_step'), '未记录阶段');
});
