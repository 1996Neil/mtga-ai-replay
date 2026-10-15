import type { CardInstance, GameState, ParsedMatch, ReplayStep } from '../types/game.ts';
export function fixtureCard(id: number, owner: number, extra: Partial<CardInstance> = {}): CardInstance {
  return { instanceId:id, grpId:106460, name:`模拟卡牌 ${id}`, zoneId:101, ownerSeatId:owner, controllerSeatId:owner,
    cardTypes:['CardType_Creature'], isTapped:false, isAttacking:false, counters:{}, power:4, toughness:3, ...extra };
}
export function layoutFixture(handCount=7, scenario='many', before=false): {match:ParsedMatch;step:ReplayStep} {
  const attacking = scenario !== 'idle';
  const stackCount = scenario === 'stack-many' ? 12 : scenario === 'stack-multi' ? 3 : ['stack','second-seat'].includes(scenario) ? 1 : 0;
  const own=[fixtureCard(101,1,{isAttacking:attacking,attackingTargetId:scenario==='planeswalker'?203:scenario==='second-seat'?999:undefined}),
    fixtureCard(102,1,{isAttacking:attacking&&scenario!=='single',isTapped:attacking}),
    fixtureCard(103,1,{objectType:'GameObjectType_Token',counters:{CounterType_P1P1:2},damage:1}),
    fixtureCard(104,1,{cardTypes:['CardType_Enchantment'],attachedTo:103})];
  const enemy=[fixtureCard(201,2,{isBlocking:scenario==='many',blockedAttackerIds:scenario==='many'?[101,102]:[]}),
    fixtureCard(202,2,{isBlocking:scenario==='many',blockedAttackerIds:scenario==='many'?[101]:[]}),
    fixtureCard(203,2,{cardTypes:['CardType_Planeswalker'],name:'模拟鹏洛客',counters:{Loyalty:5}})];
  let state:GameState={gameStateId:1, turnInfo:{turnNumber:5,phase:attacking?'Phase_Combat':'Phase_Main1',activePlayer:1},
    players:[{systemSeatId:1,playerName:'模拟我方',lifeTotal:12,handSize:handCount,librarySize:20},{systemSeatId:2,playerName:'模拟对手',lifeTotal:14,handSize:5,librarySize:22}],
    zones:new Map(),gameObjects:new Map(),zoneTypeMap:new Map(),annotations:[],exileObjects:[],graveyardByOwner:{1:[],2:[]},
    battlefieldByOwner:{1:[...own,...Array.from({length:7},(_,i)=>fixtureCard(300+i,1,{cardTypes:['CardType_Land'],isTapped:i<3}))],2:[...enemy,...Array.from({length:6},(_,i)=>fixtureCard(400+i,2,{cardTypes:['CardType_Land']}))]},
    handByOwner:{1:Array.from({length:handCount},(_,i)=>fixtureCard(500+i,1,i===handCount-1&&scenario==='hidden'?{grpId:0,name:undefined,visibility:'hidden'}:{})),2:[]},
    stackObjects:Array.from({length:stackCount},(_,i)=>fixtureCard(600+stackCount-1-i,1,{grpId:i===stackCount-1?106371:106464,power:undefined,toughness:undefined,targets:scenario==='second-seat'?[{player:'opponent'}]:[{instance_id:203}],targetIds:scenario==='second-seat'?[]:[203],abilitySource:{instance_id:101},objectType:i===stackCount-1&&stackCount>1?'GameObjectType_Card':'GameObjectType_Ability'}))};
  state.gameObjects=new Map([...Object.values(state.battlefieldByOwner).flat(),...Object.values(state.handByOwner).flat(),...state.stackObjects].map(c=>[c.instanceId,c]));
  let beforeState:GameState={...state,handByOwner:{1:state.handByOwner[1].slice(0,-1),2:[]},battlefieldByOwner:{...state.battlefieldByOwner,1:state.battlefieldByOwner[1].map(c=>({...c,isAttacking:false,isTapped:false}))}};
  if(scenario==='second-seat'){state=swapSeats(state);beforeState=swapSeats(beforeState);}
  const step:ReplayStep={stepIndex:0,turnNumber:5,phase:state.turnInfo.phase,label:'模拟布局回归',gameState:state,beforeGameState:beforeState,
    eventsSinceLastStep:[],anchor:'T5-A1',actionNumber:1,event:{type:'attack',card:{instance_id:101},targets:[{player:'opponent'}]},groupedFrame:false,coachNotes:[],warnings:[]};
  if(before)step.gameState=beforeState;
  const match:ParsedMatch={matchId:'synthetic-layout-p1',localSeatId:scenario==='second-seat'?2:1,players:state.players,steps:[step],grpIds:new Set(),startedAt:'',gameNumber:1,eventName:'模拟测试',warnings:[]};
  return {match,step};
}

/** Test-only seat inversion; semantic me/opponent strings retain their meaning. */
function swapSeats(state:GameState):GameState {
  const seat=(id:number)=>id===1?2:id===2?1:id;
  const card=(value:CardInstance)=>({...value,ownerSeatId:seat(value.ownerSeatId),controllerSeatId:seat(value.controllerSeatId)});
  const zones=(values:Record<number,CardInstance[]>)=>Object.fromEntries(Object.entries(values).map(([id,cards])=>[seat(Number(id)),cards.map(card)]));
  const next={...state,turnInfo:{...state.turnInfo,activePlayer:seat(state.turnInfo.activePlayer)},
    players:state.players.map(p=>({...p,systemSeatId:seat(p.systemSeatId)})),battlefieldByOwner:zones(state.battlefieldByOwner),
    handByOwner:zones(state.handByOwner),graveyardByOwner:zones(state.graveyardByOwner),exileObjects:state.exileObjects.map(card),stackObjects:state.stackObjects.map(card)};
  next.gameObjects=new Map([...Object.values(next.battlefieldByOwner).flat(),...Object.values(next.handByOwner).flat(),...next.stackObjects].map(c=>[c.instanceId,c]));return next;
}
