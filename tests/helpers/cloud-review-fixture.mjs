import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCoachBundle, serializeCoachJson } from '../../src/coach-bundle.mjs';

const execute = promisify(execFile);
const REPOSITORY = 'fixture-owner/private-coaching';
const REMOTE_URL = `https://github.com/${REPOSITORY}.git`;
const FILES = ['summary.json', 'coach.json', 'cards.json', 'manifest.json'];
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

export async function bundle({ id = 'synthetic-match-one', started = '2026-10-01T12:00:00.000Z', richer = false, generated = '2026-10-02T00:00:00.000Z', coachOptions = {}, onReplay } = {}) {
  const forest = { arena_id: 1, name: 'Forest', instance_id: 101, logical_id: 'C1', visibility: 'public', card_types: ['Land'], counters: [] };
  const player = (name, battlefield = []) => ({ name, life: 20, hand: [], handSize: 0, librarySize: 39, battlefield, graveyard: [], exile: [] });
  const state = number => ({ gameStateId: number, turn: number, phase: 'Phase_Main1', step: 'Step_Main', activePlayer: 'me', priorityPlayer: 'me', players: { me: player('Synthetic Me', [forest]), opponent: player('Synthetic Opponent') }, stack: [], warnings: [] });
  const states = { S1: state(1) };
  const steps = [{ anchor: 'T1-A1', turn: 1, action: 1, state_id: 'S1', event: { type: 'land', actor: 'me', card: forest } }];
  if (richer) {
    states.S2 = state(2);
    steps.push({ anchor: 'T2-A1', turn: 2, action: 1, before_state_id: 'S1', state_id: 'S2', event: { type: 'life', actor: 'me', life: { me: 19, opponent: 20 } } });
  }
  const replay = { schema_version: '1.0', match: { id, started_at: started, event: 'Jump In', is_jump_in: true, result: 'Win', player: 'Synthetic Me', opponent: 'Synthetic Opponent', on_play: true },
    deck: [{ arena_id: 1, name: 'Forest', quantity: 40 }], perspective: { hidden_information: 'omitted' }, warnings: [],
    games: [{ game_number: 1, starting_hand: [], states, steps, turns: [], result: { outcome: 'Win', reason: 'concede', life: { me: 19, opponent: 20 } }, warnings: [] }] };
  onReplay?.(structuredClone(replay));
  return buildCoachBundle(replay,
  { cards: [{ arena_id: 1, name: 'Forest', display_name_zh: '树林', mana_cost: '', type_line: 'Basic Land — Forest', oracle_text: '{T}: Add {G}.', keywords: [], power: null, toughness: null, metadata_complete: true, source: 'scryfall' }], generatedAt: generated, ...coachOptions });
}

const partText = value => typeof value === 'string' ? value : serializeCoachJson(value);

export async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mtga-coach-sync-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'local-data'), bare = join(directory, 'remote.git');
  await execute('git', ['init', '--bare', '-b', 'main', bare], { env });
  const control = { visibility: 'PRIVATE', offline: false, unavailableGh: false, rejectPush: false, losePushResponse: false,
    pushFailure: null, calls: [], visibilityChecks: 0, publicAtCheck: Infinity, gitEnv: {}, beforeGit: null, branch: 'main' };
  const runCommand = async (file, args, { cwd, encoding = 'utf8', env: commandEnv = {}, input, timeout } = {}) => {
    control.calls.push({ file, args: [...args], timeout });
    if (file === 'gh') {
      assert.deepEqual(args.slice(0, 3), ['repo', 'view', REPOSITORY]);
      control.visibilityChecks++;
      if (control.unavailableGh) throw new Error('network error ghp_SyntheticSecretMustNotEscape /Users/synthetic/private.log');
      let defaultBranchRef = null;
      try { await execute('git', ['--git-dir', bare, 'rev-parse', '--verify', 'HEAD'], { env }); defaultBranchRef = { name: control.branch }; } catch { /* Empty remote. */ }
      return JSON.stringify({ nameWithOwner: REPOSITORY, visibility: control.visibilityChecks >= control.publicAtCheck ? 'PUBLIC' : control.visibility, url: `https://github.com/${REPOSITORY}`, defaultBranchRef });
    }
    assert.equal(file, 'git');
    const networkCommand = args.find(value => value === 'fetch' || value === 'push' || value === 'ls-remote');
    await control.beforeGit?.({ cwd, args, networkCommand });
    if (networkCommand === 'push' && control.pushFailure === 'timeout-before') {
      const error = new Error('Command was killed with SIGTERM ghp_SyntheticSecretMustNotEscape'); error.code = null; error.signal = 'SIGTERM'; error.killed = true; throw error;
    }
    if (networkCommand && (control.offline || (control.rejectPush && networkCommand === 'push'))) throw new Error('fatal ghp_SyntheticSecretMustNotEscape https://token@example.invalid /Users/synthetic/private.log');
    if (networkCommand) {
      const remote = await execute('git', ['remote', 'get-url', '--all', ...(networkCommand === 'push' ? ['--push'] : []), 'origin'], { cwd, env });
      if (remote.stdout.trim().split('\n').some(value => value !== REMOTE_URL)) throw new Error('Test harness forbids every noncanonical network destination.');
    }
    // The stored origin stays canonical. Only network commands get a per-command
    // rewrite to a fresh local bare repository; no synthetic data reaches GitHub.
    const routed = networkCommand ? ['-c', `url.${bare}.insteadOf=${REMOTE_URL}`, ...args] : args;
    return new Promise((resolve, reject) => {
      const child = execFile(file, routed, { cwd, encoding, env: { ...process.env, ...env, ...control.gitEnv, ...commandEnv },
        timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(error);
        else if (networkCommand === 'push' && control.pushFailure === 'timeout-after') {
          const timeoutError = new Error('Command was killed with SIGTERM ghp_SyntheticSecretMustNotEscape'); timeoutError.code = null; timeoutError.signal = 'SIGTERM'; timeoutError.killed = true; reject(timeoutError);
        } else if (networkCommand === 'push' && control.losePushResponse) reject(Error('Synthetic lost push acknowledgement'));
        else resolve({ stdout, stderr });
      });
      child.stdin.on('error', reject); child.stdin.end(input);
    });
  };
  const options = { dataDir, runCommand };
  const published = async path => (await execute('git', ['--git-dir', bare, 'show', `HEAD:${path}`], { env })).stdout;
  const commits = async () => {
    try { return Number((await execute('git', ['--git-dir', bare, 'rev-list', '--count', 'HEAD'], { env })).stdout.trim()); } catch { return 0; }
  };
  const checkout = join(dataDir, 'coach-sync', 'repository');
  return { options, control, published, commits, checkout, bare, dataDir };
}

export function filesForBundle(value) {
  const files = new Map([['index.json', serializeCoachJson({ schema: 'MTGA_COACH_INDEX_V1', matches: [{ match_id: value.summary.match_id,
    path: `matches/${value.historyKey}`, history_key: value.historyKey, content_hash: value.contentHash }] })]]);
  for (const name of FILES) files.set(`matches/${value.historyKey}/${name}`, serializeCoachJson(value[name.slice(0, -5)]));
  for (const [path, part] of value.parts ?? []) files.set(path, partText(part));
  return files;
}
export function reportForSource(source, gameNumber = 1) {
  const game = source.replay.games.find((game, i) => (game.game_number ?? i + 1) === gameNumber);
  const step = game.steps[0];
  const point = { anchor: step.anchor, boundary: 'after' };
  return { schema: 'MTGA_AI_REVIEW_V1', match_id: source.match_id, game_number: gameNumber,
    source_content_hash: source.content_hash, policy_version: 'cloud-visible/1', generated_at: '2026-10-15T00:00:00.000Z',
    generator: { name: 'chatgpt-cloud-agent', version: '1.0' },
    provenance: { source_revision: source.revision, evidence: 'published-player-perspective', context_sources: ['本局已发布证据'], summary_may_use_future: true },
    coverage: { scope: 'sampled', actions_total: game.steps.length, states_resolved: Object.keys(game.states).length,
      inspected: [point], limitations: ['仅检查所列节点；未检查动作不代表正确。'] },
    summary: { headline: '合成协议验收', overview: '本报告只用于隔离协议测试。', strengths: [], improvements: [], limitations: ['不是真实模型分析。'] },
    notes: [{ ...point, severity: 'tip', confidence: 'low', title: '检查当前资源', observation: '当前局面有可见地牌。',
      suggestion: '评估下一回合资源。', rationale: '依据当前已观测局面。', limitation: '不推断隐藏手牌或合法行动。', cards: ['Forest'] }] };
}
