import test from 'node:test';
import assert from 'node:assert/strict';
import {combatPresentation} from '../src/lib/combatPresentation.ts';
import {layoutFixture} from '../src/lib/layoutFixtures.ts';
import {handFanLayout} from '../src/lib/cardPresentation.ts';
test('many-to-many uses three edges and one mark per instance',()=>{const {step}=layoutFixture();const c=combatPresentation(step.gameState,1,step.event);assert.equal(c.links.filter(l=>l.kind==='block').length,3);assert.equal(c.marks.size,4);assert.match(c.marks.get(201)!.text,/模拟卡牌 101 \/ 模拟卡牌 102/);});
test('player target uses semantic event; raw numeric seat is not assumed',()=>{const {step}=layoutFixture(1,'single');step.gameState.battlefieldByOwner[1][0].attackingTargetId=1;assert.deepEqual(combatPresentation(step.gameState,1,step.event).links[0].to,{player:2});assert.equal(combatPresentation(step.gameState,1).links.length,0);});
test('planeswalker target is resolved by permanent instance',()=>{const {step}=layoutFixture(1,'planeswalker');assert.deepEqual(combatPresentation(step.gameState,1,step.event).links[0].to,{card:203});});
test('hidden, unresolved targets and before/idle state do not borrow later information',()=>{const {step}=layoutFixture(1,'single');step.gameState.battlefieldByOwner[1][0].attackingTargetId=999;assert.equal(combatPresentation(step.gameState,1).links.length,0);delete step.gameState.battlefieldByOwner[1][0].attackingTargetId;step.event!.targets=[{player:'opponent',hidden:true}];assert.equal(combatPresentation(step.gameState,1,step.event).links.length,0);assert.equal(combatPresentation(step.beforeGameState!,1).attackers,0);step.gameState.turnInfo.phase='Phase_Main1';assert.equal(combatPresentation(step.gameState,1).marks.size,0);});
test('P1 hand row size is count-independent and every card remains reachable',()=>{for(const n of [0,1,3,7,12,16]){const l=handFanLayout(n,230,{overlap:false,cardWidth:104});assert.equal(l.cardWidth,104);assert.equal(l.stride,n<=1?104:118);}});

test('resolved attack arrow needs no duplicate target label; unknown targets stay explicit',()=>{
  const {step}=layoutFixture(1,'single');
  assert.equal(combatPresentation(step.gameState,1,step.event).marks.get(101)?.text,'');
  assert.equal(combatPresentation(step.gameState,1).marks.get(101)?.text,'攻击目标未知');
});

test('second-seat local player and explicit current event survive unresolved numeric attack target',()=>{
  const {step}=layoutFixture(1,'single');step.gameState.battlefieldByOwner[1][0].attackingTargetId=999;
  assert.deepEqual(combatPresentation(step.gameState,2,step.event).links[0].to,{player:1});
  step.event!.targets=[{player:'me'}];assert.deepEqual(combatPresentation(step.gameState,2,step.event).links[0].to,{player:2});
  step.event!.targets=[{player:'opponent',hidden:true}];assert.equal(combatPresentation(step.gameState,2,step.event).links.length,0);
  step.event!.targets=[{player:'opponent'}];step.event!.card={instance_id:999};assert.equal(combatPresentation(step.gameState,2,step.event).links.length,0);
});

test('second-seat fixture owns its battlefield and stack; both relationship kinds point to its opponent',()=>{
  const {match,step}=layoutFixture(1,'second-seat');assert.equal(match.localSeatId,2);
  assert.equal(step.gameState.battlefieldByOwner[2][0].controllerSeatId,2);
  assert.deepEqual(combatPresentation(step.gameState,2,step.event).links[0].to,{player:1});
});
test('explicitly hidden current attack target cannot be recovered from a retained permanent ID',()=>{
  const {step}=layoutFixture(1,'planeswalker');step.event!.targets=[{instance_id:203,hidden:true}];
  const result=combatPresentation(step.gameState,1,step.event);assert.equal(result.links.length,0);assert.equal(result.marks.get(101)?.text,'攻击目标未知');
});
