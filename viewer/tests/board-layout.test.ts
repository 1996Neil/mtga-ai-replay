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

test('same-name land printings stack while tap and individual state remain distinct',()=>{
  const lands=[card(1,{name:'Forest',grpId:10}),card(2,{name:'Forest',grpId:20}),
    card(3,{name:'Forest',isTapped:true}),card(4,{name:'Forest',counters:{Charge:1}}),
    card(5,{name:'Forest',attachedTo:99}),card(6,{name:'Forest',attachments:[100]}),
    card(7,{name:'Forest',controllerSeatId:2})];
  const before=JSON.stringify(lands), piles=landPiles(lands);
  assert.deepEqual(piles.map(p=>p.map(c=>c.instanceId)),[[1,2],[3],[4],[5],[6],[7]]);
  assert.equal(JSON.stringify(lands),before);
});
test('anonymous hidden lands stay separate and forty copies retain every instance',()=>{
  const hidden=[card(1,{grpId:0,name:undefined,visibility:'hidden'}),card(2,{grpId:0,name:undefined,visibility:'hidden'})];
  assert.equal(landPiles(hidden).length,2);
  const lands=Array.from({length:40},(_,i)=>card(i+10,{name:'Island',isTapped:i<25}));
  const piles=landPiles(lands);assert.deepEqual(piles.map(p=>p.length),[25,15]);
  assert.equal(new Set(piles.flat().map(c=>c.instanceId)).size,40);
});
