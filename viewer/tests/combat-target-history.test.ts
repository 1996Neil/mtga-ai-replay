import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReplay } from '../src/lib/canonicalAdapter.ts';
import { combatPresentation, observedAttackTargets } from '../src/lib/combatPresentation.ts';
import { layoutFixture } from '../src/lib/layoutFixtures.ts';

function replay() {
  const card = (id:number) => ({instance_id:id,arena_id:id,name:`Public ${id}`,logical_id:`C${id}`,is_attacking:true,attacking_target_id:1,visibility:'public'});
  const state = (phase='Phase_Combat') => ({turn:19,phase,players:{me:{name:'Me',battlefield:[card(101),card(102)]},opponent:{name:'Opponent',battlefield:[]}},stack:[]});
  return {match:{id:'synthetic-history'},games:[{states:{S0:state(),S1:state(),S2:state(),S3:state()},steps:[
    {anchor:'T19-A10',state_id:'S1',before_state_id:'S0',event:{type:'attack',card:{instance_id:101},targets:[{player:'opponent'}]}},
    {anchor:'T19-A11',state_id:'S2',before_state_id:'S1',event:{type:'attack',card:{instance_id:102},targets:[{player:'opponent'}]}},
    {anchor:'T19-A27',state_id:'S3',before_state_id:'S2',event:{type:'state'}},
  ]}]};
}

test('later stack frame retains only earlier observed combat targets; going backward never borrows the future',()=>{
  const raw=replay(),original=structuredClone(raw),match=normalizeReplay(raw)[0],current=match.steps[2];
  const known=observedAttackTargets(match.steps,current);
  const result=combatPresentation(current.gameState,1,current.event,{attackTargets:known});
  assert.deepEqual(result.links.filter(l=>l.kind==='attack').map(l=>l.to),[{player:2},{player:2}]);
  assert([...result.marks.values()].every(m=>m.text===''));
  assert.equal(observedAttackTargets(match.steps,match.steps[0],true).size,0);
  assert.deepEqual([...observedAttackTargets(match.steps,match.steps[1],true).keys()],[101]);
  assert.deepEqual([...observedAttackTargets(match.steps,match.steps[0]).keys()],[101]);
  assert.deepEqual(raw,original);
});

test('combat history rejects changed raw targets, removed attackers, new combats and explicit hidden targets',()=>{
  for(const change of ['redirect','leave','new-combat','hidden'] as const){
    const raw=replay();
    if(change==='redirect')raw.games[0].states.S3.players.me.battlefield[0].attacking_target_id=2;
    if(change==='leave')raw.games[0].states.S3.players.me.battlefield[0].is_attacking=false;
    if(change==='new-combat')raw.games[0].states.S2.phase='Phase_Main2';
    if(change==='hidden')(raw.games[0].steps[1].event as any)={type:'attack',card:{instance_id:101},targets:[{player:'opponent',hidden:true}]};
    const match=normalizeReplay(raw)[0],current=match.steps[2],known=observedAttackTargets(match.steps,current);
    const result=combatPresentation(current.gameState,1,current.event,{attackTargets:known});
    assert.equal(result.links.some(l=>'card' in l.from&&l.from.card===101),false,change);
  }
});

test('combat labels resolve Chinese names without mutating canonical English identities',()=>{
  const {step}=layoutFixture(1,'many'),state=step.gameState;
  state.battlefieldByOwner[1][0].name='Blessed Ghoul';state.battlefieldByOwner[1][1].name='Screeching Soulbreaker';
  const names=new Map([[101,'受福食尸鬼'],[102,'尖鸣裂魂妖']]);
  const result=combatPresentation(state,1,step.event,{displayName:card=>names.get(card.instanceId)});
  assert.equal(result.marks.get(201)?.text,'阻挡 受福食尸鬼 / 尖鸣裂魂妖');
  assert.equal(state.battlefieldByOwner[1][0].name,'Blessed Ghoul');
  state.battlefieldByOwner[1][0].visibility='hidden';
  const safe=combatPresentation(state,1,step.event,{displayName:()=> 'Private Name'});
  assert(!safe.marks.get(202)?.text.includes('Private Name'));
});


test('action-before excludes earlier UI rows from the same pooled after-frame',()=>{
  const raw=replay();raw.games[0].steps[1].state_id='S1';raw.games[0].steps[1].before_state_id='S0';
  const match=normalizeReplay(raw)[0];
  assert.equal(observedAttackTargets(match.steps,match.steps[1],true).size,0);
  assert.equal(observedAttackTargets(match.steps,match.steps[1]).size,2);
  raw.games[0].states.S0={...raw.games[0].states.S0,gameStateId:10} as any;
  raw.games[0].states.S1={...raw.games[0].states.S1,gameStateId:12} as any;
  const numeric=normalizeReplay(raw)[0];
  assert.equal(observedAttackTargets(numeric.steps,numeric.steps[1],true).size,0);
});
