/** Fully synthetic public fixtures. Every URL is intercepted; no real fetch,
 * account identity, Arena reader or publisher can be called by this benchmark. */
import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,copyFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
const before=resolve(process.argv[2]),after=resolve(process.argv[3]),output=resolve(process.argv[4]);
const base=await mkdtemp(join(tmpdir(),'frozen-public-metadata-'));globalThis.fetch=()=>{throw Error('All real network forbidden');};
const metadata=Object.fromEntries(Array.from({length:7},(_,i)=>[i+1,{name:`Synthetic Card ${i+1}`,mana_cost:'{1}',type_line:'Artifact',oracle_text:'Draw a card.',keywords:[]}]));
metadata[100]={name:'Synthetic Front // Synthetic Back',keywords:[],type_line:'Creature',oracle_text:'Adventure',mana_cost:'{2}',power:'2',toughness:'2',card_faces:[{name:'Synthetic Front',type_line:'Creature',mana_cost:'{2}',oracle_text:'Adventure',power:'2',toughness:'2'},{name:'Synthetic Back',type_line:'Instant',mana_cost:'{1}',oracle_text:'Draw a card.'}]};
const replay={schema_version:'2.0',match:{id:'synthetic-frozen-linked',started_at:'2026-10-01T00:00:00.000Z',result:'Win'},deck:[...Array.from({length:7},(_,i)=>({arena_id:i+1,name:`Synthetic Card ${i+1}`,quantity:1})),{arena_id:101,name:'Synthetic Back',quantity:1}],games:[{game_number:1,states:{},steps:[{anchor:'T1-A1',turn:1,event:{type:'life',life:{me:20,opponent:0}}}],turns:[],starting_hand:[],warnings:[]}],warnings:[]};
const dbPath=join(base,'frozen.mtga'),db=new DatabaseSync(dbPath);db.exec("PRAGMA journal_mode=WAL; CREATE TABLE Cards (GrpId INTEGER,TitleId INTEGER,TypeTextId INTEGER,SubtypeTextId INTEGER,OldSchoolManaText TEXT,Power TEXT,Toughness TEXT,AbilityIds TEXT,LinkedFaceGrpIds TEXT); CREATE TABLE Localizations_enUS (LocId INTEGER,Formatted INTEGER,Loc TEXT); INSERT INTO Cards VALUES (101,1,2,3,'o1','','','','100'),(100,4,5,3,'o2','2','2','','101'); INSERT INTO Localizations_enUS VALUES (1,1,'Synthetic Back'),(2,1,'Instant'),(3,1,''),(4,1,'Synthetic Front'),(5,1,'Creature'); PRAGMA wal_checkpoint(TRUNCATE);");db.close();
const sha=value=>createHash('sha256').update(value).digest('hex'),rows=[];
try{
 for(const scenario of ['cold','hot','partial-missing','network-fault','linked-face'])for(const repeat of [1,2]){
  const outputs=[];
  for(const [version,source]of [['pro',before],['candidate',after]]){
   const dataDir=join(base,`${scenario}-${repeat}-${version}`);await mkdir(join(dataDir,'cards'),{recursive:true});await copyFile(dbPath,join(dataDir,'frozen.mtga'));
   if(scenario==='hot')for(const[id,value]of Object.entries(metadata))await writeFile(join(dataDir,'cards',`${id}.json`),JSON.stringify({...value,arena_id:Number(id),source:'scryfall',cache_schema:2,rules_schema:1}));
   if(scenario==='hot')await writeFile(join(dataDir,'cards','101.json'),JSON.stringify({arena_id:101,name:'Synthetic Back',source:'local',retry_after:4102444800000}));
   const {buildCoachCards}=await import(pathToFileURL(join(source,'src/coach-cards.mjs'))),{buildCoachBundle,serializeCoachJson}=await import(pathToFileURL(join(source,'src/coach-bundle.mjs')));
   let requests=0,active=0,maxActive=0;const starts=[];const durations=[];
   const options={dataDir,cardDb:join(dataDir,'frozen.mtga'),displayNamesZh:new Map(),fetchFn:async url=>{
    requests++;active++;maxActive=Math.max(maxActive,active);starts.push(performance.now());const start=performance.now();try{
     const value=String(url);assert.match(value,/^https:\/\/api\.scryfall\.com\/cards\/(arena\/\d+|named\?exact=)/);await new Promise(r=>setTimeout(r,300));if(scenario==='network-fault')throw Error('Synthetic network failure');
     const id=Number(value.match(/arena\/(\d+)$/)?.[1]);const card=scenario==='partial-missing'&&id===7?undefined:metadata[id];return new Response(JSON.stringify(card??{object:'error'}),{status:card?200:404});
    }finally{active--;durations.push(performance.now()-start);}
   }};
   const lag=monitorEventLoopDelay({resolution:5});lag.enable();await new Promise(r=>setTimeout(r,10));const start=performance.now();const cards=await buildCoachCards(replay,options),elapsed=performance.now()-start;lag.disable();
   const bundle=await buildCoachBundle(replay,{cards,multipart:true,generatedAt:'2026-10-01T00:00:00.000Z'}),files=new Map([['summary.json',serializeCoachJson(bundle.summary)],['coach.json',serializeCoachJson(bundle.coach)],['cards.json',serializeCoachJson(bundle.cards)],['manifest.json',serializeCoachJson(bundle.manifest)],...[...bundle.parts].map(([path,value])=>[path,serializeCoachJson(value)])]);
   for(const[path,record]of Object.entries(bundle.manifest.files)){assert.equal(Buffer.byteLength(files.get(path)),record.bytes);assert.equal(sha(files.get(path)),record.sha256);}
   outputs.push(Object.fromEntries([...files].map(([path,value])=>[path,sha(value)])));
   rows.push({scenario,repeat,version,elapsed_ms:elapsed,requests,max_active:maxActive,start_spacing_ms:starts.slice(1).map((value,i)=>value-starts[i]),request_ms:durations,card_count:cards.length,incomplete:cards.filter(card=>!card.metadata_complete).length,event_loop_max_ms:lag.max/1e6,files:outputs.at(-1)});
  }
  assert.deepEqual(outputs[0],outputs[1],`${scenario}: all bundle bytes must match, including rules and candidate_reasons`);
 }
 const result={schema:'FROZEN_PUBLIC_METADATA_COMPARISON_V1',fixture_hash:sha(JSON.stringify({metadata,replay})),sqlite_sha256:sha(await readFile(dbPath)),wal_state:'checkpointed, no WAL frames, identical DB bytes copied into each run',real_network_calls:0,byte_identical:true,rows};await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,rows:rows.map(({files,...row})=>row)}));
}finally{await rm(base,{recursive:true,force:true});}
