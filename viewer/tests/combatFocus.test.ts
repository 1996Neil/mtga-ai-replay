import test from 'node:test';
import assert from 'node:assert/strict';
import { combatFocus, lightHandFan } from '../src/lib/combatFocus.ts';
import { combatPresentation } from '../src/lib/combatPresentation.ts';
import type { CombatLink } from '../src/lib/combatPresentation.ts';
import { layoutFixture } from '../src/lib/layoutFixtures.ts';

const links: CombatLink[] = [
  {from:{card:1},to:{player:2},kind:'attack'},
  {from:{card:2},to:{card:90},kind:'attack'},
  {from:{card:11},to:{card:1},kind:'block'},
  {from:{card:12},to:{card:1},kind:'block'},
  {from:{card:12},to:{card:2},kind:'block'},
  {from:{card:3},to:{player:2},kind:'attack'},
];
test('focus is direct many-to-many, and blocked attack lines hide without changing recorded targets',()=>{
  const before=JSON.stringify(links), a=combatFocus(links,1), b=combatFocus(links,12);
  assert.deepEqual([...a.related],[1,11,12]); assert.equal(a.visible.length,2);
  assert.deepEqual(new Set(b.related),new Set([12,1,2])); assert.equal(b.visible.length,2);
  assert.equal(JSON.stringify(links),before);
  assert.deepEqual(combatFocus(links,null).visible.map(l=>l.kind),['block','block','block','attack']);
  assert.equal(combatFocus(links,999).active,false);
});
test('unblocked permanent attack target and second-seat semantic target remain exact',()=>{
  assert.deepEqual(combatFocus([links[1]],2).visible[0].to,{card:90});
  const {step}=layoutFixture(1,'second-seat');const data=combatPresentation(step.gameState,2,step.event);
  assert.deepEqual(combatFocus(data.links,null).visible.find(l=>l.kind==='attack')?.to,{player:1});
});
test('presentation focus cannot restore hidden or unresolved relationships',()=>{
  const {step}=layoutFixture(1,'single');step.event!.targets=[{player:'opponent',hidden:true}];
  const data=combatPresentation(step.gameState,1,step.event);
  assert.equal(combatFocus(data.links,101).visible.length,0);
  assert.equal(combatFocus(data.links,101).active,false);
});
test('fan keeps all indices and fixed face size for zero, crowded and extreme hands',()=>{
  for(const n of [0,1,3,7,12,16,40])for(const width of [155,230,302,460]){
    const f=lightHandFan(n,width);assert.equal(f.cards.length,n);assert.equal(f.cardWidth,104);
    assert(f.width>=width);assert(f.cards.every(c=>Math.abs(c.angle)<=5));
    for(let i=1;i<n;i++)assert(f.cards[i].x>f.cards[i-1].x);
    if(n)assert(f.cards.at(-1)!.x+104<=f.width);
    if(n===1)assert.equal(f.cards[0].angle,0);
  }
  assert(lightHandFan(16,230).width>230);
});
