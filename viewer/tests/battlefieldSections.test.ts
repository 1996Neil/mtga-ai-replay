import test from 'node:test';
import assert from 'node:assert/strict';
import { battlefieldSections, battlefieldSection } from '../src/lib/battlefieldSections.ts';
import { attachmentLayout } from '../src/lib/attachmentLayout.ts';
import { fixtureCard } from '../src/lib/layoutFixtures.ts';
test('all observed noncreature permanent types use the side lane; creature hybrids remain main',()=>{
 const types=[['Planeswalker'],['Artifact'],['Enchantment'],['Battle'],['Artifact','Creature'],['Enchantment','Creature'],['Land','Creature'],['Creature'],[]];
 const cards=types.map((types,i)=>fixtureCard(i+1,1,{cardTypes:types.map(type=>'CardType_'+type)}));
 const before=JSON.stringify(cards),s=battlefieldSections(cards);assert.deepEqual(s.side.map(c=>c.instanceId),[2,3]);
 assert.deepEqual(s.featured.map(c=>c.instanceId),[1,4]);
 assert.deepEqual(s.main.map(c=>c.instanceId),[5,6,7,8,9]);assert.equal(JSON.stringify(cards),before);
 assert.equal(new Set([...s.main,...s.side,...s.featured].map(c=>c.instanceId)).size,cards.length);
});
test('attachments follow hosts across seats, while detached equipment returns beside creatures',()=>{
 const creature=fixtureCard(1,1),equipment=fixtureCard(2,2,{cardTypes:['CardType_Artifact'],attachedTo:1}),aura=fixtureCard(3,1,{cardTypes:['CardType_Enchantment'],attachedTo:1});
 const grouped=attachmentLayout([creature,equipment,aura]),s=battlefieldSections(grouped.roots);assert.equal(s.side.length,0);assert.equal(s.main.length,1);assert.deepEqual(grouped.groups.get(1)?.map(c=>c.instanceId),[2,3]);
 const detached={...equipment,attachedTo:undefined};assert.deepEqual(battlefieldSections(attachmentLayout([creature,detached,aura]).roots).side,[detached]);
});
test('current state type changes move the same instance without changing its game identity',()=>{
 const vehicle=fixtureCard(7,1,{cardTypes:['CardType_Artifact']});assert.equal(battlefieldSections([vehicle]).side[0],vehicle);
 const crewed={...vehicle,cardTypes:['CardType_Artifact','CardType_Creature']};assert.equal(battlefieldSections([crewed]).main[0],crewed);
 assert.equal(crewed.instanceId,vehicle.instanceId);
});

test('sagas have a dedicated lane before lands, except when they are currently creatures',()=>{
 const landSaga=fixtureCard(10,1,{cardTypes:['CardType_Land','CardType_Enchantment'],typeLine:'Enchantment Land — Saga'});
 assert.equal(battlefieldSection(landSaga),'featured');
 assert.equal(battlefieldSection({...landSaga,cardTypes:[...landSaga.cardTypes,'CardType_Creature']}),'main');
 assert.equal(battlefieldSection(fixtureCard(11,1,{cardTypes:['CardType_Enchantment']}),'Enchantment — Saga'),'featured');
 assert.equal(battlefieldSection(fixtureCard(12,1,{cardTypes:['CardType_Artifact']}),'Enchantment — Saga'),'side');
});
