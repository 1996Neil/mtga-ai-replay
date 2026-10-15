import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentLayout } from '../src/lib/attachmentLayout.ts';
import { fixtureCard } from '../src/lib/layoutFixtures.ts';
test('observed attachments move underneath their host without copying or mutating instances',()=>{
 const cards=[fixtureCard(1,1),fixtureCard(2,2,{attachedTo:1}),fixtureCard(3,1,{attachedTo:2,isTapped:true}),fixtureCard(4,1,{attachedTo:999})];
 const before=JSON.stringify(cards), result=attachmentLayout(cards);
 assert.deepEqual(result.roots.map(c=>c.instanceId),[1,4]);
 assert.deepEqual(result.groups.get(1)?.map(c=>c.instanceId),[2,3]);
 assert.equal(result.groups.get(1)?.[0],cards[1]);assert.equal(JSON.stringify(cards),before);
 assert.deepEqual([...result.roots,...result.groups.values()].flat().map(c=>c.instanceId).sort(),[1,2,3,4]);
});
test('reverse attachment links resolve only when unique and do not override explicit links',()=>{
 const cards=[fixtureCard(1,1,{attachments:[3,4,5]}),fixtureCard(2,2,{attachments:[4,5]}),fixtureCard(3,1),fixtureCard(4,1),fixtureCard(5,1,{attachedTo:1}),fixtureCard(6,1,{attachedTo:999,attachments:[]})];
 const result=attachmentLayout(cards);assert.deepEqual(result.groups.get(1)?.map(c=>c.instanceId),[3,5]);
 assert.deepEqual(result.roots.map(c=>c.instanceId),[1,2,4,6]);
});
test('broken, self and cyclic attachments never discard cards or recurse forever',()=>{
 const cards=[fixtureCard(1,1,{attachedTo:2}),fixtureCard(2,1,{attachedTo:1}),fixtureCard(3,1,{attachedTo:3}),fixtureCard(4,1,{attachedTo:1})];
 const result=attachmentLayout(cards);assert.deepEqual(result.roots.map(c=>c.instanceId),[1,2,3]);
 assert.deepEqual(result.groups.get(1)?.map(c=>c.instanceId),[4]);
});
