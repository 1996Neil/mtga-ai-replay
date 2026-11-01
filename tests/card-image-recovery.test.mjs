import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCardMetadata, getCardImage, cardImageRetryAfter, cardImageFailure, validImageBytes } from '../src/card-cache.mjs';
import { selectPrintedFace, resolveCatalogIdentity } from '../src/card-image-identity.mjs';
import { getEnglishRuinsImage, verifiedEnglishRuinsImage } from '../src/card-image-fallback.mjs';
const identity={requestedId:100,primaryId:100,faceIndex:0,set:'abc',collector:'1'};
const card={id:'synthetic-print',oracle_id:'synthetic-oracle',lang:'en',arena_id:100,set:'abc',collector_number:'1',name:'Synthetic Card',layout:'normal',image_uris:{normal:'https://cards.scryfall.io/normal/front/synthetic.jpg'}};
async function dir(t){const d=await mkdtemp(join(tmpdir(),'card-image-test-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
test('known primary identity rejects mismatched language, set, number, and Arena ID',async t=>{
 for(const change of [{lang:'ja'},{set:'xyz'},{collector_number:'2'},{arena_id:999}]){
  const dataDir=await dir(t);const result=await getCardMetadata(100,{dataDir,identityResolver:async()=>identity,fetchFn:async()=>Response.json({...card,...change})});assert.equal(result.source,'local');assert.equal(result.image_identity_status,'unverified');
 }
 assert.equal(selectPrintedFace(card,identity).identity.lang,'en');
});
test('secondary adventure keeps its own rules while selecting the shared front image',()=>{
 const result=selectPrintedFace({...card,layout:'adventure',card_faces:[{name:'Main',oracle_text:'main'},{name:'Adventure',oracle_text:'secondary'}]},{...identity,requestedId:101,faceIndex:1});assert.equal(result.face.oracle_text,'secondary');assert.equal(result.image,card.image_uris.normal);assert.equal(result.identity.side,'front');
});
test('failed image respects retry-after and coalesces requests',async t=>{
 const dataDir=await dir(t);let images=0;const fetchFn=async(url,opts)=>{assert.equal(opts.redirect,'error');if(url.startsWith('https://api.'))return Response.json(card);images++;return new Response('',{status:429,headers:{'Retry-After':'120'}});};
 await Promise.all([getCardImage(100,{dataDir,fetchFn}),getCardImage(100,{dataDir,fetchFn})]);assert.equal(images,1);assert.ok(cardImageRetryAfter(100,{dataDir})>Date.now()+110000);assert.equal(await getCardImage(100,{dataDir,fetchFn,refreshImage:true}),null);assert.equal(images,1);
});
test('non-image bytes and empty buffers are refused',()=>{for(const type of ['image/jpeg','image/png','image/webp']){assert.ok(!validImageBytes(Buffer.from('<html>error</html>'),type));assert.ok(!validImageBytes(Buffer.alloc(0),type));}});
test('fallback remains disabled by default and rejects unrelated identity',async()=>{
 let calls=0;assert.equal(await getEnglishRuinsImage(identity,{request:async()=>{calls++;}}),null);assert.equal(calls,0);assert.equal(verifiedEnglishRuinsImage(card,{}),null);
});
const jpeg = byte => Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(40, byte), Buffer.from([255, 217])]);
test('exact printing lookup accepts a missing public Arena ID but rejects an explicit conflicting ID', async t => {
 const dataDir=await dir(t), requests=[];
 const {arena_id,...withoutArena}=card;
 const result=await getCardMetadata(100,{dataDir,identityResolver:async()=>identity,fetchFn:async url=>{
  requests.push(url);return Response.json(withoutArena);
 }});
 assert.deepEqual(requests,['https://api.scryfall.com/cards/abc/1']);
 assert.equal(result.image_identity_status,'verified');
 assert.equal(result.image_identity.collector,'1');
 assert.equal(selectPrintedFace(withoutArena,identity),null);
 assert.equal(selectPrintedFace({...withoutArena,arena_id:999},identity,{allowMissingArenaId:true}),null);
});
test('Arena fallback accepts Scryfall basic-land suffix aliases only with the matching Arena ID', async t => {
 const dataDir=await dir(t), fallback={...card,collector_number:'1a'};
 const requests=[];
 const result=await getCardMetadata(100,{dataDir,identityResolver:async()=>identity,fetchFn:async url=>{
  requests.push(url);
  return url.endsWith('/abc/1') ? new Response('',{status:404}) : Response.json(fallback);
 }});
 assert.deepEqual(requests,['https://api.scryfall.com/cards/abc/1','https://api.scryfall.com/cards/arena/100']);
 assert.equal(result.image_identity_status,'verified');
 assert.equal(selectPrintedFace(fallback,identity),null);
 assert.ok(selectPrintedFace(fallback,identity,{allowArenaIdAlias:true}));
 assert.equal(selectPrintedFace({...fallback,arena_id:999},identity,{allowArenaIdAlias:true}),null);
});
test('Arena ID fallback repairs a same-number Scryfall printing collision', async t => {
 const dataDir=await dir(t), localIdentity={...identity,collector:'9',requestedId:105,primaryId:105};
 const wrong={...card,arena_id:999,name:'Island',collector_number:'9'};
 const fallback={...card,arena_id:105,name:'Forest',collector_number:'9a'};
 const requests=[];
 const result=await getCardMetadata(105,{dataDir,identityResolver:async()=>localIdentity,fetchFn:async url=>{
  requests.push(url);
  return url.endsWith('/abc/9') ? Response.json(wrong) : Response.json(fallback);
 }});
 assert.deepEqual(requests,['https://api.scryfall.com/cards/abc/9','https://api.scryfall.com/cards/arena/105']);
 assert.equal(result.source,'scryfall');
 assert.equal(result.name,'Forest');
 assert.equal(result.image_identity_status,'verified');
});
test('an exact Arena ID can verify an intentionally non-English printing', async t => {
 const dataDir=await dir(t), phyrexian={...card,lang:'ph',name:'Plains'};
 const result=await getCardMetadata(100,{dataDir,identityResolver:async()=>identity,fetchFn:async()=>Response.json(phyrexian)});
 assert.equal(result.image_identity_status,'verified');
 assert.equal(result.image_identity.lang,'ph');
 assert.ok(selectPrintedFace(phyrexian,identity,{allowNonEnglish:true}));
 assert.equal(selectPrintedFace({...phyrexian,arena_id:999},identity,{allowNonEnglish:true}),null);
});
test('a wrong legacy JPEG is replaced lazily, then the verified image is reused offline', async t => {
 const dataDir=await dir(t), root=join(dataDir,'cards');
 await mkdir(root);await writeFile(join(root,'100.json'),JSON.stringify({arena_id:100,name:card.name,
  source:'scryfall',cache_schema:2,rules_schema:1,image_source:'https://cards.scryfall.io/wrong-print.jpg'}));
 await writeFile(join(root,'100.jpg'),jpeg(1));
 const requests=[], correct=jpeg(2), {arena_id,...withoutArena}=card;
 const options={dataDir,identityResolver:async()=>identity,fetchFn:async url=>{
  requests.push(url);return url.startsWith('https://api.')?Response.json(withoutArena):new Response(correct,{headers:{'Content-Type':'image/jpeg'}});
 }};
 // Metadata may refresh before the browser asks for JPEG bytes.
 await getCardMetadata(100,options);
 const result=await getCardImage(100,options);
 assert.ok(result.data.equals(correct));assert.ok((await readFile(join(root,'100.jpg'))).equals(correct));
 assert.deepEqual(requests,['https://api.scryfall.com/cards/abc/1',card.image_uris.normal]);
 const cached=await getCardImage(100,{...options,fetchFn:async()=>assert.fail('verified image should not access network')});
 assert.ok(cached.data.equals(correct));
});
test('an unverified old image is not substituted when exact-print lookup is offline', async t => {
 const dataDir=await dir(t),root=join(dataDir,'cards');
 await mkdir(root);await writeFile(join(root,'100.jpg'),jpeg(1));
 await writeFile(join(root,'100.json'),JSON.stringify({arena_id:100,source:'scryfall',cache_schema:2,rules_schema:1,
  image_source:'https://cards.scryfall.io/wrong-print.jpg'}));
 const result=await getCardImage(100,{dataDir,identityResolver:async()=>identity,fetchFn:async()=>{throw Error('offline');}});
 assert.equal(result,null);
});
test('an adventure face never inherits stale primary JPEG bytes after primary metadata refresh', async t => {
 const dataDir=await dir(t),root=join(dataDir,'cards');await mkdir(root);
 const adventure={...card,layout:'adventure',card_faces:[{name:'Main',oracle_text:'main'},{name:'Adventure',oracle_text:'secondary'}]};
 const primary=selectPrintedFace(adventure,identity);
 await writeFile(join(root,'100.json'),JSON.stringify({arena_id:100,source:'scryfall',cache_schema:2,rules_schema:1,
  scryfall_id:card.id,image_source:card.image_uris.normal,image_identity:primary.identity,identity_schema:1,image_identity_status:'verified'}));
 await writeFile(join(root,'100.jpg'),jpeg(1));
 const correct=jpeg(3);let images=0;
 const result=await getCardImage(101,{dataDir,identityResolver:async()=>({...identity,requestedId:101,faceIndex:1}),
  fetchFn:async url=>url.startsWith('https://api.')?Response.json(adventure):
    (images++,new Response(correct,{headers:{'Content-Type':'image/jpeg'}}))});
 assert.ok(result.data.equals(correct));assert.equal(images,1);
});
test('ordinary image failures cool down for seconds while server Retry-After remains authoritative', async t => {
 for(const [status,retryAfter,minimum,maximum]of [[503,null,2000,4000],[503,'20',19000,21000],[429,null,59000,61000]]){
  const dataDir=await dir(t);
  const result=await getCardImage(100,{dataDir,fetchFn:async url=>url.startsWith('https://api.')?Response.json(card):
   new Response('',{status,headers:retryAfter?{'Retry-After':retryAfter}:{}})});
  assert.equal(result,null);const delay=cardImageRetryAfter(100,{dataDir})-Date.now();
  assert.ok(delay>=minimum&&delay<=maximum,`unexpected cooldown ${delay}`);
 }
});
test('legacy minute-long local failure is refreshed once, and new failures keep their short cooldown', async t => {
 const dataDir=await dir(t),root=join(dataDir,'cards');await mkdir(root);
 await writeFile(join(root,'100.json'),JSON.stringify({arena_id:100,source:'local',retry_after:Date.now()+60000}));
 let calls=0;const fetchFn=async()=>{calls++;throw Error('temporary disconnect');};
 const first=await getCardMetadata(100,{dataDir,fetchFn});
 assert.equal(calls,1);assert.ok(first.retry_after-Date.now()<=3000);
 await getCardMetadata(100,{dataDir,fetchFn});assert.equal(calls,1);
});
test('manual metadata retry bypasses ordinary cooldown while reporting the connection cause safely', async t => {
 const dataDir=await dir(t);let calls=0;
 const fetchFn=async()=>{if(++calls===1){const error=new TypeError('secret-local-path-must-not-leak');error.cause={code:'ECONNRESET'};throw error;}return Response.json(card);};
 const first=await getCardMetadata(100,{dataDir,fetchFn});
 assert.equal(first.load_error.kind,'connection');assert.equal(first.load_error.code,'ECONNRESET');
 assert.doesNotMatch(JSON.stringify(first),/secret-local-path/);
 const second=await getCardMetadata(100,{dataDir,fetchFn,refreshMetadata:true});
 assert.equal(calls,2);assert.equal(second.source,'scryfall');assert.equal(second.load_error,undefined);
});
test('manual image retry bypasses ordinary cooldown, but respects explicit upstream rate limits', async t => {
 for(const status of [503,429]){
  const dataDir=await dir(t);let images=0;
  const fetchFn=async url=>url.startsWith('https://api.')?Response.json(card):
   ++images===1?new Response('',{status,headers:status===429?{'Retry-After':'30'}:{}}):
    new Response(jpeg(7),{headers:{'Content-Type':'image/jpeg'}});
  await getCardImage(100,{dataDir,fetchFn});
  assert.equal(cardImageFailure(100,{dataDir}).kind,status===429?'rate_limited':'http');
  const next=await getCardImage(100,{dataDir,fetchFn,refreshImage:true});
  assert.equal(images,status===429?1:2);
  assert.equal(Boolean(next),status!==429);
 }
});
test('a request timeout is reported distinctly from an HTTP error or absent card printing', async t => {
 const dataDir=await dir(t);
 const timeout=await getCardMetadata(100,{dataDir,fetchFn:async()=>{throw new DOMException('timed out','TimeoutError');}});
 assert.equal(timeout.load_error.kind,'timeout');
 const absent=await getCardMetadata(100,{dataDir,refreshMetadata:true,fetchFn:async()=>new Response('',{status:404})});
 assert.equal(absent.load_error.kind,'not_found');assert.equal(absent.load_error.status,404);
});
test('non-primary Arena token rows resolve to the token sheet and reject regular-card layouts', () => {
 const token = resolveCatalogIdentity({ GrpId:106552, ExpansionCode:'FRA', CollectorNumber:'2', CollectorSuffix:'',
  IsPrimaryCard:0, IsToken:1, IsRebalanced:0, LinkedFaceGrpIds:'' });
 assert.deepEqual(token,{requestedId:106552,primaryId:106552,faceIndex:0,set:'tfra',collector:'2',isToken:true});
 const printing={...card,arena_id:undefined,set:'tfra',collector_number:'2',layout:'token',type_line:'Token Creature — Cat Soldier'};
 assert.ok(selectPrintedFace(printing,token,{allowMissingArenaId:true}));
 assert.equal(selectPrintedFace({...printing,layout:'normal'},token,{allowMissingArenaId:true}),null);
 assert.equal(selectPrintedFace({...printing,set:'fra'},token,{allowMissingArenaId:true}),null);
});
test('same-name regular-card token cache is corrected once without a name search or bulk lookup', async t => {
 const dataDir=await dir(t),root=join(dataDir,'cards');await mkdir(root);
 await writeFile(join(root,'106552.json'),JSON.stringify({arena_id:106552,name:"Ajani's Pridemate",source:'scryfall',
  cache_schema:2,rules_schema:1,scryfall_id:'wrong-regular-card',image_source:'https://cards.scryfall.io/wrong-regular.jpg'}));
 await writeFile(join(root,'106552.jpg'),jpeg(1));
 const token={requestedId:106552,primaryId:106552,faceIndex:0,set:'tfra',collector:'2',isToken:true};
 const printing={...card,arena_id:undefined,id:'right-token',name:"Ajani's Pridemate",set:'tfra',collector_number:'2',
  layout:'token',type_line:'Token Creature — Cat Soldier'};
 const requests=[],correct=jpeg(9),options={dataDir,identityResolver:async()=>token,fetchFn:async url=>{
  requests.push(url);return url.startsWith('https://api.')?Response.json(printing):
   new Response(correct,{headers:{'Content-Type':'image/jpeg'}});
 }};
 const image=await getCardImage(106552,options);
 assert.ok(image.data.equals(correct));
 assert.deepEqual(requests,['https://api.scryfall.com/cards/tfra/2',printing.image_uris.normal]);
 const metadata=await getCardMetadata(106552,{...options,fetchFn:async()=>assert.fail('verified token cache must be local')});
 assert.equal(metadata.type_line,'Token Creature — Cat Soldier');assert.equal(metadata.image_identity.isToken,true);
 assert.ok((await getCardImage(106552,{...options,fetchFn:async()=>assert.fail('cached token image must be local')})).data.equals(correct));
});
test('an unavailable token printing never falls back to guessing by shared name', async t => {
 const dataDir=await dir(t),requests=[],token={...identity,set:'tabc',isToken:true};
 const metadata=await getCardMetadata(100,{dataDir,local:{name:'Beast'},identityResolver:async()=>token,
  fetchFn:async url=>{requests.push(url);return new Response('',{status:404});}});
 assert.equal(metadata.image_source,undefined);
 assert.deepEqual(requests,['https://api.scryfall.com/cards/tabc/1','https://api.scryfall.com/cards/arena/100']);
});
test('linked token faces use reciprocal suffixes even when both Arena rows are non-primary', async t => {
 const front={GrpId:84616,ExpansionCode:'MOM',CollectorNumber:'16',CollectorSuffix:'a',IsPrimaryCard:0,IsToken:1,
  LinkedFaceGrpIds:'84617'},back={...front,GrpId:84617,CollectorSuffix:'b',LinkedFaceGrpIds:'84616'};
 const a=resolveCatalogIdentity(front,back),b=resolveCatalogIdentity(back,front);
 assert.equal(a.set,'tmom');assert.equal(a.collector,'16');assert.equal(a.faceIndex,0);
 assert.equal(b.primaryId,84616);assert.equal(b.collector,'16');assert.equal(b.faceIndex,1);
 const printing={...card,arena_id:undefined,set:'tmom',collector_number:'16',layout:'double_faced_token',
  card_faces:[{name:'Incubator',image_uris:{normal:'https://cards.scryfall.io/front.jpg'}},
   {name:'Phyrexian',image_uris:{normal:'https://cards.scryfall.io/back.jpg'}}]};
 assert.equal(selectPrintedFace(printing,a,{allowMissingArenaId:true}).identity.side,'front');
 assert.equal(selectPrintedFace(printing,b,{allowMissingArenaId:true}).image,'https://cards.scryfall.io/back.jpg');
 const unresolved=resolveCatalogIdentity(back,null),dataDir=await dir(t);
 assert.equal(unresolved.unresolved,true);
 const metadata=await getCardMetadata(84617,{dataDir,local:{name:'Phyrexian'},identityResolver:async()=>unresolved,
  fetchFn:async()=>assert.fail('unresolved token face must not guess a printing')});
 assert.equal(metadata.image_source,undefined);
});
