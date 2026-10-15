import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from '../src/lib/canonicalAdapter.ts';
import { boardRelationships } from '../src/lib/relationships.ts';

const snapshot = () => ({ players: { me: { battlefield: [{instance_id: 10, arena_id: 100, logical_id: 'C10'}] }, opponent: { battlefield: [{instance_id: 20, arena_id: 200}] } },
  stack: [{instance_id: 30, arena_id: 200, is_ability: true, ability_source: {instance_id:20}, targets:[{instance_id:10},{player:'me'}]}] });
test('observed ability links its source to the stack and each target, with deduplicated event targets', () => {
  const state = normalizeState(snapshot());
  assert.deepEqual(boardRelationships(state, { type:'target', card:{instance_id:20}, targets:[{instance_id:10}] }), [
    {from:{card:20},to:{card:30},kind:'source'}, {from:{card:30},to:{card:10},kind:'target'}, {from:{card:30},to:{player:1},kind:'target'}]);
});
test('redacted targets cannot be recovered from retained target IDs or a matching printed card ID', () => {
  const raw = snapshot();
  raw.stack[0].targets = [{instance_id:10, hidden:true} as any];
  (raw.stack[0] as any).target_ids = [10];
  (raw.stack[0] as any).ability_source = {instance_id:20, hidden:true};
  const state = normalizeState(raw);
  assert.deepEqual(boardRelationships(state), []);
  assert.deepEqual(boardRelationships(state, {type:'target',card:{instance_id:999, arena_id:200},targets:[{instance_id:10}]}), []);
});
test('current logical identity supports changed object IDs, but future and removed cards produce no endpoints', () => {
  const raw = snapshot();
  raw.stack[0].targets = [{instance_id:9, logical_id:'C10'} as any,{instance_id:999}];
  assert.deepEqual(boardRelationships(normalizeState(raw)).filter(link => link.kind==='target'), [{from:{card:30},to:{card:10},kind:'target'}]);
  assert.deepEqual(boardRelationships(normalizeState({players:raw.players})), []);
});
test('before snapshots use only their own stack targets; no later event is required', () => {
  const before = normalizeState({players:snapshot().players});
  const after = normalizeState(snapshot());
  assert.equal(boardRelationships(before).length, 0);
  assert.equal(boardRelationships(after).length, 3);
});

test('ordinary semantic targets respect a second-seat local player without changing card identities',()=>{
  const state=normalizeState(snapshot());
  const links=boardRelationships(state,{type:'cast',card:{instance_id:10},targets:[{player:'opponent'},{player:'me'}]},2);
  assert.ok(links.some(l=>'player' in l.to && l.to.player===1 && 'card' in l.from && l.from.card===10));
  assert.ok(links.some(l=>'player' in l.to && l.to.player===2 && 'card' in l.from && l.from.card===30));
  assert.ok(links.some(l=>'card' in l.to && l.to.card===10 && 'card' in l.from && l.from.card===30));
  assert.equal(boardRelationships(state,{type:'target',card:{instance_id:10},targets:[{player:'opponent',hidden:true}]},2).filter(l=>'card' in l.from&&l.from.card===10).length,0);
});
