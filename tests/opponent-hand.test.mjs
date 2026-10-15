import test from 'node:test';
import assert from 'node:assert/strict';
import {PerspectiveState} from '../src/perspective.mjs';
import {visualSnapshot} from '../src/visual-state.mjs';
import {createCoachContext} from '../src/coach-context.mjs';
const names=new Map([[100,'Visible Sentinel'],[200,'Hidden Sentinel'],[300,'Future Sentinel']]);
for(const local of [1,2])test(`opponent hand inspection retains explicitly observed identities for seat ${local}`,()=>{
 const other=3-local,s=new PerspectiveState(local);
 s.apply({type:'GameStateType_Full',players:[{systemSeatNumber:local},{systemSeatNumber:other}],zones:[{zoneId:10,type:'ZoneType_Hand',ownerSeatId:other,objectInstanceIds:[1,2]},{zoneId:20,type:'ZoneType_Graveyard',ownerSeatId:other,objectInstanceIds:[]}],gameObjects:[{instanceId:1,grpId:100,ownerSeatId:other,zoneId:10,visibility:'Visibility_Private',viewers:[other]},{instanceId:2,grpId:200,ownerSeatId:other,zoneId:10,visibility:'Visibility_Hidden'}]});
 const before=visualSnapshot(s,names);assert.equal(before.players.opponent.revealed_hand,undefined);assert.equal(before.players.opponent.handSize,2);
 s.apply({gameObjects:[{instanceId:1,visibility:'Visibility_Private',viewers:[local,other]}]});
 const visible=visualSnapshot(s,names);assert.equal(visible.players.opponent.revealed_hand[0].name,'Visible Sentinel');assert.equal(visible.players.opponent.revealed_hand.length,1);assert.deepEqual(visible.players.opponent.hand,[]);assert.equal(JSON.stringify(visible).includes('Hidden Sentinel'),false);assert.equal(JSON.stringify(before).includes('Visible Sentinel'),false);
 s.apply({gameObjects:[{instanceId:1,visibility:'Visibility_Hidden'}]});assert.equal(visualSnapshot(s,names).players.opponent.revealed_hand[0].name,'Visible Sentinel');
 s.apply({gameObjects:[{instanceId:1,visibility:'Visibility_Public'}],zones:[{zoneId:10,type:'ZoneType_Hand',ownerSeatId:other,objectInstanceIds:[2]},{zoneId:20,type:'ZoneType_Graveyard',ownerSeatId:other,objectInstanceIds:[1]}]});assert.equal(visualSnapshot(s,names).players.opponent.revealed_hand,undefined);assert.equal(visualSnapshot(s,names).players.opponent.handSize,1);assert.equal(visualSnapshot(s,names).players.opponent.hand_history[0].name,'Visible Sentinel');
});
test('terminal identity freeze prevents future hand reveal and viewer inspection never changes Coach input',()=>{
 const s=new PerspectiveState(1);s.apply({zones:[{zoneId:10,type:'ZoneType_Hand',ownerSeatId:2,objectInstanceIds:[1]}],gameObjects:[{instanceId:1,grpId:300,zoneId:10,ownerSeatId:2,visibility:'Visibility_Hidden'}]});
 s.terminalCards=new Map();s.ended=true;s.apply({gameObjects:[{instanceId:1,visibility:'Visibility_Public'}]});assert.equal(visualSnapshot(s,names).players.opponent.revealed_hand,undefined);
 const state={players:{opponent:{hand:[],handSize:2,graveyard:[]},me:{hand:[]}}};
 const replay=state=>({match:{id:'synthetic'},games:[{game_number:1,states:{S1:state},steps:[{anchor:'T1-A1',state_id:'S1'}]}]});
 const before=createCoachContext(replay(state),{anchor:'T1-A1'}),visible=structuredClone(state);visible.players.opponent.revealed_hand=[{name:'Visible Sentinel',arena_id:100,visibility:'public'}];visible.players.opponent.hand_history=[{name:'Seen before',arena_id:200,visibility:'player_known'}];
 assert.deepEqual(createCoachContext(replay(visible),{anchor:'T1-A1'}),before);
});

function observedHand(){const s=new PerspectiveState(1);s.apply({gameInfo:{gameNumber:1},zones:[{zoneId:10,type:'ZoneType_Hand',ownerSeatId:2,objectInstanceIds:[10]},{zoneId:20,type:'ZoneType_Library',ownerSeatId:2,objectInstanceIds:[]}],gameObjects:[{instanceId:10,grpId:100,zoneId:10,ownerSeatId:2,visibility:'Visibility_Public'}]});return s;}
const opponent=s=>visualSnapshot(s,names).players.opponent;
test('deleted visible objects retain continuous hand knowledge; new hidden draw is not learned',()=>{
 const s=observedHand(),before=visualSnapshot(s,names);
 s.apply({diffDeletedInstanceIds:[10],zones:[{zoneId:10,objectInstanceIds:[10,11]}],gameObjects:[{instanceId:11,grpId:200,zoneId:10,ownerSeatId:2,visibility:'Visibility_Hidden'}]});
 assert.equal(opponent(s).revealed_hand[0].name,'Visible Sentinel');assert.equal(opponent(s).handSize,2);assert.equal(opponent(s).revealed_hand.length,1);assert.equal(JSON.stringify(opponent(s)).includes('Hidden Sentinel'),false);assert.equal(before.players.opponent.handSize,1);
});
test('departure remains in history and hidden return cannot reactivate observed identity',()=>{
 const s=observedHand();s.apply({zones:[{zoneId:10,objectInstanceIds:[]}],diffDeletedInstanceIds:[10]});
 assert.equal(opponent(s).revealed_hand,undefined);assert.equal(opponent(s).hand_history.length,1);assert.ok(opponent(s).hand_history[0].instance_id<0);
 s.apply({zones:[{zoneId:10,objectInstanceIds:[10]}],gameObjects:[{instanceId:10,grpId:200,zoneId:10,ownerSeatId:2,visibility:'Visibility_Hidden'}]});
 assert.equal(opponent(s).revealed_hand,undefined);assert.equal(opponent(s).hand_history[0].arena_id,100);
});
test('library shuffle preserves hand knowledge; explicit hand shuffle demotes it to history',()=>{
 const s=observedHand();s.apply({gameObjects:[{instanceId:10,visibility:'Visibility_Hidden'}],annotations:[{type:['AnnotationType_Shuffle'],affectedIds:[20]}]});
 assert.equal(opponent(s).revealed_hand.length,1);
 s.apply({annotations:[{type:['AnnotationType_Shuffle'],affectedIds:[10]}]});assert.equal(opponent(s).revealed_hand,undefined);assert.equal(opponent(s).hand_history.length,1);
});
test('same game full snapshot preserves continuous IDs; renamed hidden IDs never match by name; new game clears history',()=>{
 const s=observedHand();s.apply({type:'GameStateType_Full',gameInfo:{gameNumber:1},zones:[{zoneId:10,type:'ZoneType_Hand',ownerSeatId:2,objectInstanceIds:[10]}]});assert.equal(opponent(s).revealed_hand.length,1);
 s.apply({type:'GameStateType_Full',zones:[{zoneId:10,type:'ZoneType_Hand',ownerSeatId:2,objectInstanceIds:[11]}],gameObjects:[{instanceId:11,grpId:100,zoneId:10,ownerSeatId:2,visibility:'Visibility_Hidden'}]});assert.equal(opponent(s).revealed_hand,undefined);assert.equal(opponent(s).hand_history.length,1);
 s.apply({gameInfo:{gameNumber:2}});assert.equal(opponent(s).revealed_hand,undefined);assert.equal(opponent(s).hand_history,undefined);
});
test('public identity change records new observation; game over cannot learn a fresh hidden identity',()=>{
 const s=observedHand();s.apply({gameObjects:[{instanceId:10,grpId:200,visibility:'Visibility_Public'}]});assert.equal(opponent(s).revealed_hand[0].arena_id,200);assert.equal(opponent(s).hand_history[0].arena_id,100);
 s.apply({gameInfo:{stage:'GameStage_GameOver'},zones:[{zoneId:10,objectInstanceIds:[10,12]}],gameObjects:[{instanceId:12,grpId:300,zoneId:10,ownerSeatId:2,visibility:'Visibility_Public'}]});assert.equal(opponent(s).revealed_hand.length,1);assert.equal(JSON.stringify(opponent(s)).includes('Future Sentinel'),false);
});
