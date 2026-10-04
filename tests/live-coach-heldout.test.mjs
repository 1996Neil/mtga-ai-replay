import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ReplaySource, LOCKED_REPLAY_REF } from '../src/live-coach/sources.mjs';
import { generateCandidates, verifyCandidate } from '../src/live-coach/rules.mjs';

// Selected by fixed index percentiles from another real match AFTER rules were
// frozen. No tuning, model judgment, sound or tactical success is graded here.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/live-coach-heldout-windows.json',import.meta.url),'utf8'));
if (process.env.MTGA_PRIVATE_HELDOUT_FIXTURE) fixture.source_integrity = JSON.parse(readFileSync(process.env.MTGA_PRIVATE_HELDOUT_FIXTURE, 'utf8')).source_integrity;
const repoDir = process.env.MTGA_PRIVATE_CORPUS_DIR ?? fileURLToPath(new URL('../../..',import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const blob = path => execFileSync('git',['show',`${LOCKED_REPLAY_REF}:${path}`],{cwd:repoDir,encoding:'buffer',maxBuffer:64*1024*1024});

test('heldout selection is four fixed percentiles from the first non-regression locked-index match', { skip: (!process.env.MTGA_PRIVATE_CORPUS_DIR || !process.env.MTGA_PRIVATE_HELDOUT_FIXTURE) ? 'Private locked corpus is excluded from this source export' : false },()=>{
  const index=JSON.parse(blob('index.json'));
  const entry=index.matches.find(item=>!fixture.excluded_match_ids.includes(item.match_id));
  assert.equal(fixture.data_ref,LOCKED_REPLAY_REF);assert.equal(fixture.selected_match_id,entry.match_id);
  assert.equal(fixture.windows.length,4);assert.equal(new Set(fixture.windows.map(w=>w.source.state_id)).size,4);
  assert.deepEqual(fixture.windows.map(w=>w.source.percentile),[0.2,0.4,0.6,0.8]);
  for(const w of fixture.windows)assert.equal(w.source.frame_index_zero_based,Math.floor((w.source.total_frames-1)*w.source.percentile));
  assert.equal(fixture.heldout_from_rules_tuning,true);assert.equal(fixture.model_strategy_accuracy_test,false);assert.equal(fixture.real_audio_test,false);
  assert.equal(hash(readFileSync(new URL('../src/live-coach/rules.mjs',import.meta.url))),fixture.rules_implementation_sha256_at_freeze);
});

test('heldout manifests, all parts and selected canonical frames retain exact source integrity', { skip: (!process.env.MTGA_PRIVATE_CORPUS_DIR || !process.env.MTGA_PRIVATE_HELDOUT_FIXTURE) ? 'Private locked corpus is excluded from this source export' : false },async()=>{
  assert.equal(hash(blob('index.json')),fixture.source_integrity.index_sha256);
  assert.equal(hash(blob(fixture.source_integrity.manifest_path)),fixture.source_integrity.manifest_sha256);
  const manifest=JSON.parse(blob(fixture.source_integrity.manifest_path));assert.deepEqual(manifest.files,fixture.source_integrity.files);assert.equal(manifest.content_hash,fixture.source_integrity.manifest_content_hash);
  // ReplaySource validates the manifest hash, every bytes/SHA-256 entry and
  // resolves all parts before exposing any frame.
  const source=await ReplaySource.open({repoDir,matchId:fixture.selected_match_id,sessionId:'heldout-fixed-selection'});
  const frames=[];for await(const frame of source.frames())frames.push(frame);
  for(const w of fixture.windows){const current=structuredClone(frames[w.source.frame_index_zero_based]);current.observed_at_monotonic=0;assert.equal(frames.length,w.source.total_frames);assert.equal(current.state_id,w.source.state_id);assert.equal(jsonHash(current),w.source.current_state_sha256);assert.deepEqual(current,w.state);}
});

test('heldout inputs preserve current perspective and candidate verification without grading strategy or speech',context=>{
  const totals={window_count:fixture.windows.length,generated_candidates:0,supported_candidates:0,explanation_candidates:0,tactic_candidates:0,silent_windows:0};
  for(const {source,state}of fixture.windows){
    assert.equal(state.match_id,fixture.selected_match_id);assert.equal(state.state_id,source.state_id);assert.equal(state.source_mode,'replay');
    assert.deepEqual(state.board.players.opponent.hand,[]);assert.equal(state.board.players.opponent.name,'Opponent');assert.equal(state.board.players.me.name,'Me');assert.equal(state.coverage.dynamic_abilities,'unknown');assert.equal(state.priority.fresh,false);
    for(const forbidden of ['coachNotes','known_opponent_information','final_life','result','winner','future_actions'])assert.equal(Object.hasOwn(state,forbidden),false);
    const visible=new Set(['me','opponent'].flatMap(role=>['hand','battlefield','graveyard','exile'].flatMap(zone=>state.board.players[role][zone].filter(c=>!c.hidden).map(c=>c.instance_id))).concat(state.board.stack.filter(c=>!c.hidden).map(c=>c.instance_id)));
    const candidates=generateCandidates(state);assert(candidates.every(c=>verifyCandidate(c,state).valid));assert(candidates.every(c=>c.kind!=='tactic'));assert(candidates.every(c=>c.targets.every(id=>visible.has(id))));
    totals.generated_candidates+=candidates.length;totals.supported_candidates+=candidates.filter(c=>c.legality_status==='supported_subset_checked').length;totals.explanation_candidates+=candidates.filter(c=>c.kind==='explanation').length;totals.tactic_candidates+=candidates.filter(c=>c.kind==='tactic').length;totals.silent_windows+=Number(candidates.length===0);
  }
  assert.deepEqual(totals,fixture.evidence_summary);
  context.diagnostic(`Heldout evidence only: ${JSON.stringify(totals)}; no model/real API/audio/strategy scoring.`);
});
