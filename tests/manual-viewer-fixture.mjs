// Run only for browser acceptance. All data is synthetic and stays in /tmp;
// this UI fixture has no GitHub publisher or external card/image requests.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveReplays } from '../src/history.mjs';
import { startReplayServer } from '../src/server.mjs';

const dataDir = await mkdtemp(join(tmpdir(), 'mtga-viewer-ui-'));
function replay(id, minute) {
  const card = (n, owner, type = 'Creature') => ({ arena_id: 900000 + n, instance_id: n, name: `Synthetic ${type} ${n}`, owner, controller: owner,
    visibility: owner === 'me' ? 'player_known' : 'public', card_types: [type], power: type === 'Creature' ? 2 : undefined,
    toughness: type === 'Creature' ? 3 : undefined, is_tapped: n % 3 === 0 });
  const player = (owner, life, base) => ({ name: `Synthetic ${owner} with a long player name`, life, librarySize: 20, handSize: owner === 'me' ? 14 : 7,
    hand: owner === 'me' ? Array.from({ length: 14 }, (_, i) => card(base + i, owner)) : [],
    battlefield: [...Array.from({ length: 10 }, (_, i) => card(base + 20 + i, owner)), ...Array.from({ length: 6 }, (_, i) => card(base + 40 + i, owner, 'Land'))],
    graveyard: [], exile: [] });
  const state = { turn: 5, phase: 'Phase_Main1', activePlayer: 'me', players: { me: player('me', 13, 100), opponent: player('opponent', 17, 200) }, stack: [card(300, 'opponent')] };
  return { schema_version: '2.0', perspective: { hidden_information: 'omitted' }, warnings: [], deck: [],
    match: { id, started_at: `2026-10-01T12:${String(minute).padStart(2, '0')}:00Z`, event: 'Jump In', is_jump_in: true, result: 'Win' },
    games: [{ game_number: 1, states: { S1: state }, starting_hand: [], turns: [], result: { outcome: 'Win' },
      steps: [{ anchor: 'T5-A1', turn: 5, state_id: 'S1', event: { type: 'cast', actor: 'opponent', card: state.stack[0] } }], warnings: [] }] };
}
await archiveReplays([replay('synthetic-viewing', 0)], { dataDir });
let calls = 0;
const running = await startReplayServer({ dataDir, displayNamesZh: new Map(), fetchFn: async () => { throw new Error('Synthetic fixture offline'); },
  syncWorkflow: async ({ onProgress }) => {
    calls++; onProgress({ phase: 'scanning' }); await new Promise(resolve => setTimeout(resolve, 1200));
    const added = calls === 2 ? 2 : calls === 3 ? 1 : 0;
    if (added) {
      onProgress({ phase: 'generating', completed: 1, total: added });
      await archiveReplays(calls === 2 ? [replay('synthetic-new-B', 1), replay('synthetic-new-C', 2)] : [replay('synthetic-new-D', 3)], { dataDir });
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    return { status: calls === 3 ? 'partial' : 'succeeded', local_matches: calls < 2 ? 1 : calls < 3 ? 3 : 4, already_published: calls < 2 ? 1 : calls < 3 ? 1 : 3,
      missing: added + (calls === 3 ? 1 : 0), published: added, failed: calls === 3 ? 1 : 0, skipped: 0, github_matches: calls < 2 ? 1 : calls < 3 ? 3 : 4,
      new_matches: added, error: calls === 3 ? '部分回放未完成同步，请查看详情。' : null, latest: null,
      failures: calls === 3 ? [{ match_id: 'synthetic-failed', started_at: '2026-10-01T12:04:00Z', reason: 'Synthetic replay has no steps.' }] : [] };
  } });
console.log(JSON.stringify({ url: running.url, dataDir }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await running.close(); await rm(dataDir, { recursive: true, force: true }); process.exit(0); });
