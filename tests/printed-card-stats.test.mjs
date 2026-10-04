import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getCardMetadata} from '../src/card-cache.mjs';
test('printed Scryfall stats never inherit later animated land P/T and old polluted cache is refreshed',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mtga-printed-stats-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  await mkdir(join(dataDir,'cards'));
  await writeFile(join(dataDir,'cards','42.json'),JSON.stringify({arena_id:42,name:'Forest',source:'scryfall',power:9,toughness:9}));
  let requests=0;
  const result=await getCardMetadata(42,{dataDir,local:{name:'Forest',power:9,toughness:9},fetchFn:async()=>{requests++;return new Response(JSON.stringify({name:'Forest',type_line:'Basic Land — Forest'}));}});
  assert.equal(result.source,'scryfall');assert.equal(result.power,undefined);assert.equal(result.toughness,undefined);assert.equal(result.cache_schema,2);assert.equal(requests,1);
});
