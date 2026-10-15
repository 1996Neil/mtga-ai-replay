/** CPU isolation benchmark; structured synthetic boards, no filesystem account
 * reads, network, Git or gameplay interaction. */
import {buildCoachBundle,serializeCoachJson} from '../src/coach-bundle.mjs';import {createComputePool} from '../src/compute-pool.mjs';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';import {createHash} from 'node:crypto';import {writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const args=Object.fromEntries(process.argv.slice(2).map(v=>v.slice(2).split('='))),size=Number(args.states??1200),jobs=4;
const cards=Array.from({length:12},(_,i)=>({arena_id:i+1,name:`Synthetic Card ${i+1}`,mana_cost:'{1}',type_line:'Artifact',oracle_text:'Draw a card.',keywords:[],metadata_complete:true}));
const states={},steps=[];
for(let i=0;i<size;i++){
 const board={turn:Math.floor(i/10)+1,players:{me:{life:20,battlefield:cards.map(card=>({...card,instance_id:card.arena_id+100,visibility:'player_known',is_tapped:i%2===0})),hand:[]},opponent:{life:20,battlefield:[],hand_count:3}},stack:[]};
 states[`S${i}`]=board;steps.push({anchor:`T${Math.floor(i/10)+1}-A${i+1}`,turn:Math.floor(i/10)+1,state_ref:`S${i}`,state_before_ref:`S${Math.max(0,i-1)}`,event:{type:'life',life:{me:20,opponent:20}}});
}
const replay={schema_version:'2.0',match:{id:'synthetic-cpu-isolation',started_at:'2026-10-01T00:00:00.000Z',result:'Win'},deck:cards.map(card=>({...card,quantity:1})),games:[{game_number:1,states,steps,turns:[],starting_hand:[],warnings:[]}],warnings:[]},options={cards,multipart:true,generatedAt:'2026-10-01T00:00:00.000Z'};
const digest=bundle=>createHash('sha256').update(serializeCoachJson({summary:bundle.summary,coach:bundle.coach,cards:bundle.cards,manifest:bundle.manifest,parts:[...bundle.parts]})).digest('hex');
const rows=[];let expected;
if(!args.child){
 for(const repeat of [1,2])for(const workers of [0,2,4]){
  const {stdout}=await promisify(execFile)(process.execPath,[new URL(import.meta.url).pathname,`--states=${size}`,`--child=${workers}`],{maxBuffer:1024*1024});
  const row=JSON.parse(stdout).rows[0];row.repeat=repeat;expected??=row.output_hash;assert.equal(row.output_hash,expected);rows.push(row);
 }
}else for(const repeat of [1])for(const workers of [Number(args.child)]){
 const pool=workers?createComputePool({size:workers}):null,lag=monitorEventLoopDelay({resolution:5});lag.enable();await new Promise(r=>setTimeout(r,10));let peak=process.memoryUsage().rss;const sample=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),5),cpu=process.cpuUsage(),start=performance.now();
 try{
  const bundles=[];
  if(pool)bundles.push(...await Promise.all(Array.from({length:jobs},()=>pool.run('bundle',{replay,options}))));
  else for(let i=0;i<jobs;i++)bundles.push(await buildCoachBundle(replay,options));
  const elapsed=performance.now()-start,usage=process.cpuUsage(cpu);await new Promise(r=>setTimeout(r,10));lag.disable();clearInterval(sample);peak=Math.max(peak,process.memoryUsage().rss);
  for(const bundle of bundles){expected??=digest(bundle);assert.equal(digest(bundle),expected);assert.equal(bundle.summary.states,size);assert.equal(bundle.summary.actions,size);}
  rows.push({repeat,workers,jobs,states_per_job:size,elapsed_ms:elapsed,event_loop_max_ms:lag.max/1e6,cpu_ms:(usage.user+usage.system)/1000,peak_rss:peak,output_hash:expected});
 }finally{clearInterval(sample);await pool?.close();}
}
const result={schema:'CPU_WORKER_FROZEN_COMPARISON_V1',real_external_calls:0,byte_identical:true,memory_method:'fresh child process per measured row, peak RSS samples include worker startup and structured clones',rows};if(args.output)await writeFile(args.output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
