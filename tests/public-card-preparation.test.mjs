import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {archiveReplays} from '../src/history.mjs';import {preparePublicCards} from '../scripts/prepare-public-cards.mjs';import {getCardMetadata} from '../src/card-cache.mjs';
async function directory(t){const dataDir=await mkdtemp(join(tmpdir(),'synthetic-public-prep-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));return dataDir;}
test('explicit public preparation refuses implicit network, caches archive identities and reuses complete warm cache',async t=>{
 const dataDir=await directory(t);let calls=0;const options={dataDir,cardDb:null,displayNamesZh:new Map(),fetchFn:async()=>{calls++;return new Response(JSON.stringify({arena_id:42,name:'Synthetic Public',oracle_text:'Draw a card.',type_line:'Artifact',mana_cost:'{1}',keywords:[]}));}};
 await assert.rejects(preparePublicCards(options),/opt-in/);assert.equal(calls,0);
 await archiveReplays([{match:{id:'synthetic-prep',started_at:'2026-10-01T00:00:00Z'},deck:[{arena_id:42,name:'Synthetic Public',quantity:1}],games:[]}],{dataDir});
 const cold=await preparePublicCards({...options,allowNetwork:true});assert.equal(cold.unique_cards,1);assert.equal(cold.http_requests,1);assert.equal(cold.incomplete_occurrences,0);
 const hot=await preparePublicCards({...options,allowNetwork:true});assert.equal(hot.http_requests,0);assert.equal(calls,1);
});
test('cache rejects an explicit different Arena identity; same-name fallback records uncertain printing identity',async t=>{
 const dataDir=await directory(t);await mkdir(join(dataDir,'cards'));await writeFile(join(dataDir,'cards','43.json'),JSON.stringify({arena_id:99,source:'scryfall',cache_schema:2,rules_schema:1,name:'Wrong'}));let calls=0;
 const card=await getCardMetadata(43,{dataDir,local:{name:'Synthetic Exact'},fetchFn:async url=>{calls++;return String(url).includes('/arena/')?new Response('{}',{status:404}):new Response(JSON.stringify({arena_id:99,name:'Synthetic Exact',oracle_text:'Draw a card.'}));}});
 assert.equal(calls,2);assert.equal(card.arena_id,43);assert.equal(card.identity_verified,false);assert.equal(card.name,'Synthetic Exact');
});
