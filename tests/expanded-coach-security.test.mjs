import test from 'node:test';import assert from 'node:assert/strict';
import {validateExpandedCoach,validateBundleFiles} from '../src/sync-security.mjs';
import {serializeCoachJson} from '../src/coach-bundle.mjs';
import {bundle} from './helpers/cloud-review-fixture.mjs';
const wrap=value=>({schema:'MTGA_FULL_COACH_V1',payload:value});
const accepts=fn=>{try{fn();return true;}catch(error){assert.equal(error.code,'MTGA_SYNC_SECURITY');return false;}};
const old=value=>validateBundleFiles(new Map([['latest/coach.json',serializeCoachJson(value)]]));
const strings=['safe','Forest','Bearer of the Heavens','ghp_SYNTHETIC_SECRET','github_pat_SYNTHETIC_SECRET','Bearer short','API_KEY=synthetic','Authorization: synthetic',
 '/Users/Synthetic/Player.log','/custom-machine-root/private','C:\\Users\\Synthetic\\file','\\\\SyntheticServer\\Share','file:///synthetic/path','synthetic@example.invalid',
 'https://synthetic:secret@example.invalid','-----BEGIN '+'PRIVATE KEY-----','data:image/png;synthetic','<svg>','\\u0067hp_SYNTHETIC_SECRET','/\\u0055sers/Synthetic/private',
 'Whenever you say "account_id": draw a card.','"/custom-machine-root/private"','a\u0000b','Bearer\nshort'];
const keys=['safe','toJSON','note Authorization','note Cookie','note access_token','note Password','note client_secret','password','machine_id','account_id','greToClientEvent','image_uris','token','tokens','is_token','/custom-machine-root/private','\\u0067hp_SYNTHETIC_SECRET'];

test('continuous coach validation preserves canonical byte-validator decisions for semantic keys, strings and encoded key-colon context',()=>{
  for(const key of keys)for(const text of strings)for(const value of [text,[text],{message:text},false,0,null]){
    const object=wrap({[key]:value});assert.equal(accepts(()=>validateExpandedCoach(object)),accepts(()=>old(object)),JSON.stringify([key,value]));
  }
  for(const key of ['note Authorization','note Cookie','note access_token'])assert.throws(()=>validateExpandedCoach(wrap({[key]:'harmless'})),e=>e.rule==='credential-text');
});

test('deterministic nested plain JSON differential corpus includes arrays, aliases, holes, escapes and nonfinite numbers',()=>{
  let seed=314159;const rand=n=>{seed=(1664525*seed+1013904223)>>>0;return seed%n;};
  const leaf=()=>[strings[rand(strings.length)],rand(100),false,true,null,undefined,NaN,Infinity][rand(8)];
  const tree=depth=>{if(!depth||rand(3)===0)return leaf();if(rand(2))return Array.from({length:rand(5)},()=>tree(depth-1));const o={};for(let i=0;i<rand(5);i++)o[keys[rand(keys.length)]]=tree(depth-1);return o;};
  for(let i=0;i<3000;i++){const value=wrap(tree(4));assert.equal(accepts(()=>validateExpandedCoach(value)),accepts(()=>old(value)),`deterministic case ${i}`);}
  const shared={card:'Forest'},value=wrap([shared,shared,new Array(3)]);assert.equal(accepts(()=>validateExpandedCoach(value)),true);
});

test('only inert coach values are accepted; accessors, toJSON, prototypes and cycles fail without invoking code',()=>{
  let calls=0;const getter=wrap({});Object.defineProperty(getter.payload,'hidden',{get(){calls++;return 'safe';},enumerable:true});
  const toJSON=wrap({toJSON(){calls++;return {password:'synthetic'};}});
  const cyclic=wrap({});cyclic.payload.self=cyclic;
  for(const value of [getter,toJSON,cyclic,wrap(new Date()),wrap(new Map()),{schema:'MTGA_AI_REVIEW_V2'},wrap(1n),wrap(()=>{})])assert.throws(()=>validateExpandedCoach(value),e=>e.code==='MTGA_SYNC_SECURITY');
  assert.equal(calls,0);
});

test('summary mutation does not change freshly built coach or canonical inputs',async()=>{
  let replay;const value=await bundle({richer:true,onReplay:r=>replay=r});const before=serializeCoachJson(value.coach),raw=structuredClone(replay);
  value.summary.source_coverage.actions=-1;value.summary.final_life.me=-99;
  assert.equal(serializeCoachJson(value.coach),before);assert.deepEqual(replay,raw);
});

test('sparse arrays reject inherited numeric values and getters without reading them',()=>{
  let calls=0;
  for(const proto of [Array.prototype,Object.prototype])for(const getter of [false,true]){
    // A distant index avoids affecting the validator's own small work arrays.
    const index='20000',previous=Object.getOwnPropertyDescriptor(proto,index);
    const value=wrap(new Array(20001));
    try{
      Object.defineProperty(proto,index,getter?{configurable:true,get(){calls++;return 'ghp_SYNTHETIC_SECRET';}}:{configurable:true,writable:true,value:'ghp_SYNTHETIC_SECRET'});
      assert.throws(()=>validateExpandedCoach(value),e=>e.code==='MTGA_SYNC_SECURITY');
    }finally{
      if(previous)Object.defineProperty(proto,index,previous);else delete proto[index];
    }
  }
  assert.equal(calls,0);
});
