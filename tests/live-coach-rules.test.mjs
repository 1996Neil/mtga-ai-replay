import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateCandidates, verifyCandidate, candidateToAdvice, checkBasicManaCost, evaluateCombat, EFFECT_MAPPINGS } from '../src/live-coach/rules.mjs';

const mapping = name => EFFECT_MAPPINGS.find(m=>m.name===name);
const rule = (name,id,extra={}) => ({ arena_id:id,name,display_name_zh:name,mana_cost:'{1}{R}',type_line:'Creature',oracle_text:mapping(name)?.text??'',keywords:[],metadata_complete:true,missing_fields:[],source:'unit_fixture',...extra });
const card = (name,id,arena,extra={}) => ({instance_id:id,arena_id:arena,name,display_name_zh:name,controller:'me',owner:'me',card_types:['Creature'],power:2,toughness:2,damage_marked:0,is_tapped:false,is_copy:false,attachments:[],counters:[],has_summoning_sickness:false,...extra});
const land = (name,id,arena,extra={}) => card(name,id,arena,{card_types:['Land'],power:null,toughness:null,...extra});
const emptyPlayer = () => ({life:20,hand:[],battlefield:[],graveyard:[],exile:[],mana_pool:[],mana_pool_source:'last_observed'});
function base(){return{session_id:'s',match_id:'m',game_id:'g',seq:1,state_id:'S1',source_mode:'replay',turn:6,phase:'Phase_Main1',step:null,active_player:'me',priority:{player:'me',source:'observed',observed_seq:1,fresh:true},board:{players:{me:emptyPlayer(),opponent:emptyPlayer()},stack:[]},rules:[],coverage:{state_complete:true,dynamic_abilities:'observed_complete',missing:[]},committed_combat:{attackers:[],blockers:[],source:'final_visual_snapshot'},tentative:{known:false},offered_actions:null,terminal:false,life_lost_this_turn:{me:false,opponent:false}};}
function removeState(spellName='Rabid Gnaw'){
  const s=base();s.board.players.me.hand=[card(spellName,1,101,{card_types:['Instant'],power:null,toughness:null})];
  s.board.players.me.battlefield=[card('Helper',2,102),land('Mountain',3,103),land('Plains',4,104)];
  s.board.players.opponent.battlefield=[card('Victim',5,105,{controller:'opponent',owner:'opponent',power:3,toughness:3})];
  s.rules=[rule(spellName,101,{type_line:'Instant'}),rule('Helper',102),rule('Mountain',103,{type_line:'Basic Land — Mountain',oracle_text:'({T}: Add {R}.)'}),rule('Plains',104,{type_line:'Basic Land — Plains',oracle_text:'({T}: Add {W}.)'}),rule('Victim',105)];return s;
}
const select = s => generateCandidates(s).find(c=>c.effect==='one_way_power_damage');

test('one-way power primitive adds before damage and never requires an attack or fight',()=>{
  const s=removeState(),c=select(s);assert(c);assert.equal(c.immutable_facts.damage,3);assert.equal(c.immutable_facts.requires_attack,false);assert.equal(c.immutable_facts.one_way,true);assert.equal(c.kind,'tactic');assert.match(c.speech_core,/不用攻击/);assert.match(c.speech_followup,/不会反打/);assert.deepEqual(c.targets,[2,5]);
  s.board.players.me.battlefield[0].has_summoning_sickness=true;assert(select(s));
});
test('same primitive supports another audited spell and fails closed for unmapped text',()=>{
  const s=removeState('Rabid Bite');s.rules[0].mana_cost='{1}{G}';s.rules[3]=rule('Forest',104,{type_line:'Basic Land — Forest',oracle_text:'({T}: Add {G}.)'});s.board.players.me.battlefield[3-1]=land('Forest',4,104);s.board.players.me.battlefield[0].power=3;
  const c=select(s);assert(c);assert.equal(c.immutable_facts.power_bonus,0);assert.equal(c.immutable_facts.damage,3);
  s.rules[0].oracle_text+=' Draw a card.';assert.equal(select(s),undefined);
});
test('basic mana requires correct colors and a distinct source per symbol',()=>{
  const s=removeState();assert.equal(checkBasicManaCost(s,'{1}{R}').payable,true);assert.equal(checkBasicManaCost(s,'{R}{R}').payable,false);assert.equal(checkBasicManaCost(s,'{2}{R}').payable,false);assert.equal(checkBasicManaCost(s,'{X}{R}').status,'unknown');s.board.players.me.battlefield.find(c=>c.name==='Mountain').is_tapped=true;assert.equal(select(s),undefined);
});
test('only current pool can pay, and attachments/unknown lands cannot supply assumed mana',()=>{
  const s=removeState();s.board.players.me.battlefield=s.board.players.me.battlefield.filter(c=>!c.card_types.includes('Land'));s.board.players.me.mana_pool=[{color:'Red',amount:2}];assert.equal(checkBasicManaCost(s,'{1}{R}').payable,false);s.board.players.me.mana_pool_source='current_observed';assert.equal(checkBasicManaCost(s,'{1}{R}').payable,true);
  s.board.players.me.mana_pool=[];s.board.players.me.battlefield.push(land('Mountain',3,103,{attachments:[99]}));assert.equal(checkBasicManaCost(s,'{R}').payable,false);
});
test('missing rules/protection/prevention/extra costs cannot produce certain removal advice',()=>{
  for(const update of [s=>s.rules[4].metadata_complete=false,s=>s.rules[4].oracle_text='Hexproof',s=>s.rules[4].oracle_text='Protection from red',s=>s.rules[4].oracle_text='Prevent all damage that would be dealt to this creature.',s=>s.rules[0].oracle_text+=' As an additional cost, sacrifice a creature.']){const s=removeState();update(s);assert.equal(select(s),undefined);}
});
test('unknown priority gives a useful conditional explanation instead of an urgent command',()=>{
  const s=removeState();s.priority.fresh=false;const c=select(s);assert(c);assert.equal(c.kind,'explanation');assert.match(c.speech_core,/没有额外响应/);assert.equal(c.legality_status,'supported_subset_checked');
});
test('verify cancels target/number/payment/window/game changes but keeps an unrelated frame',()=>{
  const s=removeState(),c=select(s);const n=structuredClone(s);n.seq=2;n.state_id='S2';n.priority.observed_seq=2;assert.equal(verifyCandidate(c,n).valid,true);n.board.players.me.battlefield.push(land('Plains',99,104));assert.equal(verifyCandidate(c,n).valid,true);
  const changes=[s=>s.board.players.opponent.battlefield=[],s=>s.board.players.me.hand=[],s=>s.board.players.me.battlefield[0].power=4,s=>s.board.players.me.battlefield.find(c=>c.name==='Mountain').is_tapped=true,s=>s.phase='Phase_Main2',s=>s.game_id='next',s=>s.priority.fresh=false,s=>s.terminal=true];
  for(const change of changes){const n=structuredClone(s);change(n);assert.equal(verifyCandidate(c,n).valid,false);}
});
test('structured facts and speech cannot be rewritten by model selection',()=>{
  const s=removeState(),c=select(s),mutated=structuredClone(c);mutated.immutable_facts.damage=99;assert.equal(verifyCandidate(mutated,s).valid,false);const speech=structuredClone(c);speech.speech_core='现在稳赢！';assert.equal(verifyCandidate(speech,s).valid,false);const advice=candidateToAdvice(c,s);assert.equal(advice.session_id,'s');assert.equal(advice.seq,1);assert.equal(advice.deadline,null);assert.equal(advice.strategic_confidence,'not_evaluated');
});
test('Frilled hand condition requires observed life loss; current 4/4 includes counters',()=>{
  const s=base();s.rules=[rule('Frilled Sparkshooter',101,{mana_cost:'{3}{R}'}),rule('Mountain',102,{type_line:'Basic Land — Mountain',oracle_text:'({T}: Add {R}.)'})];s.board.players.me.hand=[card('Frilled Sparkshooter',1,101)];s.board.players.me.battlefield=[2,3,4,5].map(i=>land('Mountain',i,102));
  s.life_lost_this_turn.opponent=null;const c=generateCandidates(s).find(c=>c.effect==='conditional_etb_counter');assert(c);assert.equal(c.kind,'explanation');assert.equal(c.legality_status,'unknown');assert.match(c.speech_core,/没核实/);
  s.life_lost_this_turn.opponent=true;assert.equal(generateCandidates(s).find(c=>c.effect==='conditional_etb_counter').immutable_facts.opponent_lost_life,true);
  s.board.players.me.hand=[];s.board.players.me.battlefield.push(card('Frilled Sparkshooter',6,101,{power:4,toughness:4,counters:[{name:'+1/+1',count:1}],has_summoning_sickness:true}));const stats=generateCandidates(s).find(c=>c.effect==='current_observed_stats');assert(stats);assert.equal(stats.immutable_facts.power,4);assert.match(stats.speech_core,/4\/4/);assert.match(stats.speech_followup,/不妨碍普通阻挡/);
});
test('Recruiter does not count itself as another Lizard',()=>{
  const s=base();s.rules=[rule('Reptilian Recruiter',101,{mana_cost:'{3}{R}{R}',type_line:'Creature — Lizard Warrior'}),rule('Mountain',102,{type_line:'Basic Land — Mountain',oracle_text:'({T}: Add {R}.)'}),rule('Victim',103)];s.board.players.me.hand=[card('Reptilian Recruiter',1,101)];s.board.players.me.battlefield=[2,3,4,5,6].map(i=>land('Mountain',i,102));s.board.players.opponent.battlefield=[card('Victim',7,103,{controller:'opponent',power:4})];let c=generateCandidates(s).find(c=>c.effect==='conditional_etb_control');assert.equal(c.immutable_facts.condition_satisfied,false);assert.deepEqual(c.immutable_facts.other_lizard_ids,[]);s.board.players.me.battlefield.push(card('Reptilian Recruiter',8,101));c=generateCandidates(s).find(c=>c.effect==='conditional_etb_control');assert.equal(c.immutable_facts.condition_satisfied,true);assert.deepEqual(c.immutable_facts.other_lizard_ids,[8]);
});
function combatState(){const s=base();s.active_player='opponent';s.phase='Phase_Combat';s.step='Step_DeclareBlock';s.priority.fresh=false;s.board.players.me.life=2;s.rules=[rule('Attacker',101,{oracle_text:'Trample',keywords:['Trample']}),rule('Blocker',102)];s.board.players.opponent.battlefield=[card('Attacker',1,101,{controller:'opponent',power:7,toughness:5,is_attacking:true})];s.board.players.me.battlefield=[2,3,4].map(id=>card('Blocker',id,102,{has_summoning_sickness:true}));s.committed_combat.attackers=[1];return s;}
const blocks=s=>s.board.players.me.battlefield.map(c=>({instance_id:c.instance_id,attacker_ids:[1]}));
test('ordinary multi-block and trample uses current dynamic numbers and permits sick blockers',()=>{
  const s=combatState(),r=evaluateCombat(s,blocks(s));assert.equal(r.supported,true);assert.equal(r.life_damage,1);assert.equal(r.results[0].attacker_dies,true);const c=generateCandidates(s).find(c=>c.effect==='ordinary_combat');assert(c);assert.equal(c.immutable_facts.remaining_life,1);assert.equal(c.kind,'explanation');assert.doesNotMatch(c.speech_core,/赢/);
});
test('first strike is resolved before normal damage; flying and tapped blocks are checked',()=>{
  const s=combatState();s.rules[0].oracle_text='First strike, Trample';s.rules[0].keywords=['First strike','Trample'];const r=evaluateCombat(s,blocks(s));assert.equal(r.life_damage,1);assert.equal(r.results[0].attacker_dies,false);
  s.rules[0].oracle_text='Flying';s.rules[0].keywords=['Flying'];assert.equal(evaluateCombat(s,blocks(s)).supported,false);s.rules[1].oracle_text='Reach';s.rules[1].keywords=['Reach'];assert.equal(evaluateCombat(s,blocks(s)).supported,true);s.board.players.me.battlefield[0].is_tapped=true;assert.equal(evaluateCombat(s,blocks(s)).supported,false);
});
test('unknown combat mechanics and tentative attack selections never become fixed blocks',()=>{
  for(const kw of ['Menace','Double strike','Deathtouch','Protection from white']){const s=combatState();s.rules[0].oracle_text=kw;s.rules[0].keywords=[kw];assert.equal(evaluateCombat(s,blocks(s)).supported,false);assert.equal(generateCandidates(s).filter(c=>c.effect==='ordinary_combat').length,0);}
  const s=combatState();s.committed_combat.attackers=[];s.tentative={known:true,attackers:[1]};assert.equal(generateCandidates(s).length,0);
});

const fixture=JSON.parse(readFileSync(new URL('./fixtures/live-coach-rule-windows.json',import.meta.url),'utf8'));
test('19 genuine fixed-ref windows are current-only regression, not blind or API validation',()=>{
  assert.equal(fixture.window_count,19);assert.equal(fixture.data_ref,'91b60e81e2ddefe4de748623e53d1eb6027a86e9');
  for(const {state,source} of fixture.windows){assert.equal(source.blind,false);assert.equal(source.known_regression,true);const current=new Set(['me','opponent'].flatMap(r=>['hand','battlefield','graveyard','exile'].flatMap(z=>state.board.players[r][z].map(c=>c.arena_id))).concat(state.board.stack.map(c=>c.arena_id)));assert(state.rules.every(r=>current.has(r.arena_id)));assert.deepEqual(state.board.players.opponent.hand,[]);for(const c of generateCandidates(state)){assert.equal(verifyCandidate(c,state).valid,true);assert.notEqual(c.kind,'tactic');}}
});
const window = (id,state_id) => fixture.windows.find(w=>w.state.match_id.startsWith(id)&&w.state.state_id===state_id).state;
test('true T6/S110 has 3-point one-way removal and no attack requirement',()=>{
  const s=window('32cdbcfa','S110'),c=select(s);assert(c);assert.equal(c.immutable_facts.damage,3);assert.equal(c.immutable_facts.source.instance_id,322);assert.equal(c.immutable_facts.target.instance_id,328);assert.equal(c.kind,'explanation');
});
test('true T10/S210 permits Hare/Crusader strategy disagreement without blaming a loss',()=>{
  const s=window('7a6cd0dd','S210'),cs=generateCandidates(s).filter(c=>c.effect==='etb_named_creature_tokens'||c.effect==='current_creature_count_stats');assert.equal(cs.length,2);assert(cs.every(c=>c.kind==='explanation'&&c.strategy_disputed));const hare=cs.find(c=>c.effect==='etb_named_creature_tokens');assert.equal(hare.immutable_facts.token_count,2);assert(cs.every(c=>/不能.*判.*错/.test(c.speech_followup)));
});
test('true T13/S334 respects unresolved stack and finds conditional survival, not a win claim',()=>{
  const s=window('7a6cd0dd','S334'),c=generateCandidates(s).find(c=>c.effect==='ordinary_combat');assert(c);assert(c.immutable_facts.life_damage<=1);assert.equal(c.immutable_facts.remaining_life,2-c.immutable_facts.life_damage);assert.equal(c.legality_status,'unknown');assert.match(c.speech_core,/堆叠还没结算/);assert.match(c.speech_followup,/不能保证赢/);assert.equal(evaluateCombat(s,c.combat_assignment).supported,false);
  const hypothetical=structuredClone(s);hypothetical.board.stack=[];const assignment=[278,272,235].map(instance_id=>({instance_id,attacker_ids:[283]})).concat([{instance_id:221,attacker_ids:[241]},{instance_id:209,attacker_ids:[215]},{instance_id:276,attacker_ids:[200]}]);assert.equal(evaluateCombat(hypothetical,assignment).life_damage,1);
});
test('true S232 committed attack contains Rammer and excludes cancelled Marshal selection',()=>{
  const s=window('d48bc0ac','S232');assert.deepEqual(s.committed_combat.attackers,[232]);assert.equal(s.board.players.opponent.battlefield.find(c=>c.name==='Dawnwing Marshal').is_attacking,false);assert.equal(s.board.players.opponent.battlefield.find(c=>c.name==='Wedgelight Rammer').is_attacking,true);assert.equal(generateCandidates(s).filter(c=>c.effect==='ordinary_combat').length,0); // Station keyword activation is intentionally uncovered.
});
test('true S207 Frilled remains 4/4 and historical loss is used only through that window',()=>{
  const s=window('8e6f1b7e','S207'),c=generateCandidates(s).find(c=>c.effect==='current_observed_stats');assert(c);assert.equal(c.immutable_facts.power,4);assert.equal(c.immutable_facts.toughness,4);assert.equal(s.life_lost_this_turn.opponent,true);assert.doesNotMatch(c.speech_core,/5\/5/);
});
test('true Frilled before/after-combat hand windows condition on observed loss, never guaranteed attack damage',()=>{
  const pre=window('8e6f1b7e','S186'),post=window('8e6f1b7e','S203');const a=generateCandidates(pre).find(c=>c.effect==='conditional_etb_counter'),b=generateCandidates(post).find(c=>c.effect==='conditional_etb_counter');assert(a);assert(b);assert.equal(a.immutable_facts.opponent_lost_life,false);assert.equal(b.immutable_facts.opponent_lost_life,true);assert.match(a.speech_core,/别假定攻击一定能打中/);assert.equal(verifyCandidate(a,post).valid,false);
  const early=window('d48bc0ac','S175'),c=generateCandidates(early).find(c=>c.effect==='conditional_etb_counter');assert(c);assert.equal(c.immutable_facts.opponent_lost_life,false);
});

test('unknown temporary ability coverage never becomes a definite tactic even with fresh priority',()=>{
  const s=removeState(),previous=select(s);assert.equal(previous.kind,'tactic');s.coverage.dynamic_abilities='unknown';const c=select(s);assert(c);assert.equal(c.kind,'explanation');assert.equal(c.legality_status,'unknown');assert.match(c.speech_core,/临时保护/);assert(c.premises.some(p=>p.type==='dynamic_abilities'&&p.observed_complete===false));assert.equal(verifyCandidate(previous,s).valid,false);
});

test('true T11 blocker deselection and last pre-damage frame are not cumulative',()=>{
  const selected=window('7a6cd0dd','S268'),cleared=window('7a6cd0dd','S269'),final=window('7a6cd0dd','S273');assert.deepEqual(selected.committed_combat.blockers,[{instance_id:239,attacker_ids:[227]}]);assert.deepEqual(cleared.committed_combat.blockers,[]);assert.deepEqual(final.committed_combat.blockers,[{instance_id:248,attacker_ids:[227]},{instance_id:239,attacker_ids:[241]}]);assert(!final.committed_combat.blockers.some(row=>row.instance_id===239&&row.attacker_ids.includes(227)));
});
