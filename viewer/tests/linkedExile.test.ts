import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedExileGroups} from '../src/lib/linkedExile.ts';
import {normalizeCard} from '../src/lib/canonicalAdapter.ts';
import {fixtureCard} from '../src/lib/layoutFixtures.ts';
test('only explicit visible current-instance exile sources produce thumbnail views',()=>{
 const host=fixtureCard(1,1,{logicalId:'C1'}),other=fixtureCard(2,2);
 const cards=[fixtureCard(10,2,{exiledBy:1,exileSourceLogicalId:'C1'}),fixtureCard(11,1,{exiledBy:1}),fixtureCard(12,1,{exiledBy:99}),fixtureCard(13,1,{exiledBy:1,visibility:'hidden'}),fixtureCard(14,1,{exiledBy:1,exileSourceLogicalId:'old'})];
 const before=JSON.stringify(cards),groups=linkedExileGroups([host,other],cards);
 assert.deepEqual(groups.get(1)?.map(c=>c.instanceId),[10,11]);assert.equal(JSON.stringify(cards),before);assert.equal(groups.get(1)?.[0],cards[0]);
 assert.equal(linkedExileGroups([{...host,visibility:'hidden'}],cards).size,0);assert.equal(linkedExileGroups([other],cards).size,0);
});
test('adapter ignores hidden source metadata and never confuses exile with attachment',()=>{
 const card=normalizeCard({instance_id:10,arena_id:100,exiled_by:{instance_id:1,logical_id:'C1'}},2,30);
 assert.equal(card.exiledBy,1);assert.equal(card.attachedTo,undefined);
 assert.equal(normalizeCard({instance_id:10,arena_id:100,visibility:'hidden',exiled_by:{instance_id:1}},2,30).exiledBy,undefined);
 assert.equal(normalizeCard({instance_id:10,arena_id:100,exiled_by:{instance_id:1,hidden:true}},2,30).exiledBy,undefined);
});
