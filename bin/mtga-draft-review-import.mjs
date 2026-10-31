#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { defaultDataDir } from '../src/history.mjs';
import { listCapturedDraftRuns } from '../src/draft-capture.mjs';
import { draftReviewFingerprint, bindDraftReview, MAX_DRAFT_REVIEW_BYTES } from '../src/review/draft-review.mjs';

const { values } = parseArgs({ options: {
  report: { type: 'string' }, evidence: { type: 'string' }, 'data-dir': { type: 'string' },
} });
if (!values.report || !values.evidence) throw Error('Use --report <analysis.json> --evidence <original-sequence.json>');
async function json(path, max) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw Error('Invalid input file');
  return JSON.parse(await readFile(path, 'utf8'));
}
const legacy = await json(values.report, 2 * 1024 * 1024);
const evidence = await json(values.evidence, 4 * 1024 * 1024);
if (!Array.isArray(legacy.notes) || !Array.isArray(evidence.picks) ||
    !Array.isArray(evidence.observed_segments) || !Array.isArray(evidence.observed_accounts) ||
    evidence.observed_segments.some(id => !/^[a-f0-9]{32}$/.test(id)) ||
    evidence.observed_accounts.some(id => !/^[a-f0-9]{64}$/.test(id))) throw Error('Incomplete original evidence');
const signature = createHash('sha256').update(JSON.stringify(evidence.picks.map(pick => ({
  pack: pick.pack_number, pick: pick.pick_number,
  candidates: pick.candidates.map(card => card.arena_id), selected: pick.selected_ids,
})))).digest('hex');
if (signature !== evidence.sequence_id || legacy.sequence_id !== signature ||
    legacy.event_id !== evidence.event_id) throw Error('Original sequence identity differs');
const dataDir = values['data-dir'] ?? defaultDataDir();
const sourceRun = { event_id: evidence.event_id, picks: evidence.picks };
const fingerprint = draftReviewFingerprint(sourceRun);
const runs = (await listCapturedDraftRuns({ dataDir })).filter(run =>
  evidence.observed_segments.includes(run.run_id) && evidence.observed_accounts.includes(run.account_key));
if (!runs.length || runs.some(run => draftReviewFingerprint(run) !== fingerprint)) throw Error('Current captures differ from reviewed sequence');
for (const run of runs) {
  const report = {
    schema: 'MTGA_DRAFT_AI_REVIEW_V1', run_id: run.run_id, account_key: run.account_key,
    event_id: run.event_id, source_fingerprint: fingerprint, generated_at: new Date().toISOString(),
    summary: { headline: legacy.title, overview: legacy.overview,
      limitations: ['仅抽查关键抓位，未评论不表示选择正确。', '评论绑定选牌证据，不代表已核实该分段与某场对战的赛事关联。'] },
    notes: legacy.notes.map(note => ({
      pack_number: note.pack_number, pick_number: note.pick_number,
      importance: note.assessment === '保留' ? 'normal' : note.assessment === '可能问题' ? 'major' : 'normal',
      assessment: ({ 保留: 'positive', 建议比较: 'suggestion', 可能问题: 'possible_error' })[note.assessment],
      confidence: 'medium',
      title: note.title ?? `${note.assessment === '保留' ? '值得保留' : note.assessment === '可能问题' ? '这一手建议核查' : '这一手的取舍'}：${note.selected?.name}`,
      observation: `本手实际选择 ${note.selected?.name}；同包可比较 ${note.alternative?.name}。`,
      suggestion: note.suggestion ?? note.rationale,
      rationale: note.rationale,
      limitation: note.limitation, selected: note.selected, alternative: note.alternative,
    })),
  };
  if (bindDraftReview(report, run, run.account_key).status !== 'ready') throw Error('Import binding failed');
  const text = JSON.stringify(report, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_DRAFT_REVIEW_BYTES) throw Error('Report too large');
  const root = join(dataDir, 'draft-reviews'), directory = join(root, run.account_key);
  for (const path of [root, directory]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Report directory is not a regular directory');
  }
  const path = join(directory, `${run.run_id}.json`);
  const temporary = join(directory, `.import-${randomUUID()}.tmp`);
  let handle, created = false;
  try {
    handle = await open(temporary, 'wx', 0o600); created = true;
    await handle.writeFile(text);
    await handle.sync(); await handle.close(); handle = undefined;
    try { await link(temporary, path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await json(path, MAX_DRAFT_REVIEW_BYTES);
      const { generated_at: ignoredOld, ...oldBody } = existing;
      const { generated_at: ignoredNew, ...newBody } = report;
      if (JSON.stringify(oldBody) !== JSON.stringify(newBody)) throw Error('Existing report differs; preserve it for review');
    }
  } finally { await handle?.close(); if (created) await unlink(temporary); }
  console.log(JSON.stringify({ run_id: run.run_id, notes: report.notes.length, status: 'ready' }));
}
