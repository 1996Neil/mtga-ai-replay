import test from 'node:test';
import assert from 'node:assert/strict';
import { combatGroups, landPiles, permanentGroups } from '../src/lib/boardLayout.ts';
import type { CardInstance } from '../src/types/game.ts';
const card=(instanceId:number,options:Partial<CardInstance>={}):CardInstance=>({instanceId,grpId:1,zoneId:1,ownerSeatId:1,controllerSeatId:1,cardTypes:['CardType_Creature'],isTapped:false,isAttacking:false,counters:{},...options});
test('five attackers retain two Moose blockers and one Treeguard blocker in separate lanes',()=>{
  const attackers=Array.from({length:5},(_,i)=>card(i+1,{isAttacking:true}));
  const blockers=[card(11,{isBlocking:true,blockedAttackerIds:[2]}),card(12,{isBlocking:true,blockedAttackerIds:[2]}),card(13,{isBlocking:true,blockedAttackerIds:[4]})];
  const input=[...attackers,...blockers], frozen=JSON.stringify(input), lanes=combatGroups(input);
  assert.equal(lanes.length,5);assert.deepEqual(lanes[1].blockers.map(c=>c.instanceId),[11,12]);
  assert.deepEqual(lanes[3].blockers.map(c=>c.instanceId),[13]);assert.equal(lanes[0].blockers.length,0);assert.equal(JSON.stringify(input),frozen);
});
test('land piles preserve availability and repeated permanents preserve different counters or attachment states',()=>{
  const a=card(1),b=card(2),tapped=card(3,{isTapped:true}),buffed=card(4,{counters:{'+1/+1':1}}),attached=card(5,{attachedTo:9});
  assert.deepEqual(landPiles([a,b,tapped]).map(g=>g.length),[2,1]);
  assert.deepEqual(permanentGroups([a,b,tapped,buffed,attached]).map(g=>g.length),[2,1,1,1]);
});
