import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCardMetadata, getCardImage, cardImageRetryAfter, validImageBytes } from '../src/card-cache.mjs';
import { selectPrintedFace } from '../src/card-image-identity.mjs';
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
