import test from 'node:test';import assert from 'node:assert/strict';
import {createComputePool} from '../src/compute-pool.mjs';import {buildCoachBundle} from '../src/coach-bundle.mjs';
for(const size of [2,4])test(`CPU pool ${size} workers preserves full bundle and rejects unsafe input`,async t=>{
 const pool=createComputePool({size});t.after(()=>pool.close());const replay={match:{id:'synthetic-worker',started_at:'2026-10-10T00:00:00Z'},deck:[],games:[]},options={multipart:true,generatedAt:'2026-10-10T00:00:00Z'};
 assert.deepEqual(await pool.run('bundle',{replay,options}),await buildCoachBundle(replay,options));await assert.rejects(pool.run('validate',{path:'latest/summary.json',content:'{"accountId":"synthetic"}'}),{code:'MTGA_SYNC_SECURITY'});
 await assert.rejects(pool.run('arbitrary-command',{}),/Unsupported/);await pool.close();await assert.rejects(pool.run('bundle',{replay,options}),/closed/);
});

test('bounded queue rejects excess work, transfer failures leave healthy workers reusable, explicit close settles pending work',async()=>{
 const pool=createComputePool({size:2,maxQueue:1});
 const replay={match:{id:'synthetic-cancel',started_at:'2026-10-10T00:00:00Z'},deck:[],games:[]},options={multipart:true,generatedAt:'2026-10-10T00:00:00Z'};
 await assert.rejects(pool.run('bundle',{replay,options,uncloneable:()=>{}}),/transfer failed/);
 assert.deepEqual(await pool.run('bundle',{replay,options}),await buildCoachBundle(replay,options));
 const pending=Array.from({length:3},()=>pool.run('bundle',{replay,options}).then(()=> 'done',error=>error.message));
 await assert.rejects(pool.run('bundle',{replay,options}),/queue full/);
 await pool.close();assert.deepEqual(await Promise.all(pending),Array(3).fill('CPU pool closed'));
});
