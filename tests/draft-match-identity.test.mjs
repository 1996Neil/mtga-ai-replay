import test from 'node:test';
import assert from 'node:assert/strict';
import { draftMatchIdentity } from '../src/draft-match-identity.mjs';
const match = { id: 'synthetic', event_id: 'QuickDraft_SYNTHETIC', account_key: 'a'.repeat(64),
  started_at: '2026-10-31T10:00:00Z', result: 'Win', game_count: 1 };
const deck = [{ arena_id: 101, quantity: 2 }, { arena_id: 102, quantity: 1 }];
test('relationship identity groups quantities, normalizes time, and ignores display and replay fields', () => {
  const hash = draftMatchIdentity(match, deck);
  assert.ok(hash);
  assert.equal(draftMatchIdentity({ ...match, player: 'Display correction', replay_revision: 'changed' }, [
    { arena_id: 102, quantity: 1 }, { arena_id: 101, quantity: 1 }, { arena_id: 101, quantity: 1 },
  ]), hash);
  assert.equal(draftMatchIdentity({ ...match, started_at: '2026-10-31T18:00:00+08:00' }, deck), hash);
  for (const changed of [
    { ...match, id: 'other' }, { ...match, event_id: 'OtherEvent' },
    { ...match, account_key: 'b'.repeat(64) }, { ...match, result: 'Loss' },
    { ...match, game_count: 2 }, { ...match, started_at: '2026-10-31T11:00:00Z' },
  ]) assert.notEqual(draftMatchIdentity(changed, deck), hash);
  assert.notEqual(draftMatchIdentity(match, [{ arena_id: 101, quantity: 3 }, deck[1]]), hash);
  for (const bad of [[], [{ arena_id: 101, quantity: -1 }], [{ arena_id: 0, quantity: 2 }]])
    assert.equal(draftMatchIdentity(match, bad), null);
});
