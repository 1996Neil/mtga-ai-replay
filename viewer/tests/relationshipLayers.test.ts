import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutCombatDuplicates } from '../src/lib/relationshipLayers.ts';
import { boardRelationships } from '../src/lib/relationships.ts';
import { layoutFixture } from '../src/lib/layoutFixtures.ts';
test('all ordinary event types use one line for an already visible combat source/target pair',()=>{
 for(const type of ['attack','damage','target','trigger','activate','cast'])for(const to of [{player:2},{card:203}]){
  const {step}=layoutFixture(1,'many');
  const target='player' in to?{player:'opponent'}:{instance_id:to.card};
  const ordinary=boardRelationships(step.gameState,{type,card:{instance_id:101},targets:[target]});
  const combat=[{kind:'attack' as const,from:{card:101},to}];
  const before=JSON.stringify(ordinary);assert.equal(withoutCombatDuplicates(ordinary,combat).length,0);assert.equal(JSON.stringify(ordinary),before);
 }
});
test('independent stack targets and source lines, and different event targets, remain unchanged',()=>{
 const {step}=layoutFixture(1,'stack-multi');
 const ordinary=boardRelationships(step.gameState,{type:'damage',card:{instance_id:101},targets:[{player:'opponent'},{instance_id:202}]});
 const filtered=withoutCombatDuplicates(ordinary,[{kind:'attack',from:{card:101},to:{player:2}}]);
 assert.equal(filtered.length,ordinary.length-1);
 assert.deepEqual(filtered.filter(link=>'card' in link.from && link.from.card>=600),ordinary.filter(link=>'card' in link.from && link.from.card>=600));
 assert(filtered.some(link=>'card' in link.to&&link.to.card===202));
 assert.equal(filtered.filter(link=>link.kind==='source').length,3);
});
