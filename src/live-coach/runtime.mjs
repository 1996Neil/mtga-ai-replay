import { randomUUID } from 'node:crypto';
import { CoachController } from './controller.mjs';
import { ReplaySource, LiveSource } from './sources.mjs';

export class LiveCoachRuntime {
  constructor({ repoDir, controller, sourceMode = 'replay', logPath, logDir, names, rules, livePractice = false } = {}) {
    Object.assign(this, { repoDir, sourceMode }); this.controller = controller ?? new CoachController();
    this.sources = new Map(); this.viewerSeq = 0; this.seekSession = randomUUID(); this.previous = null; this.previousView = null;
    if (sourceMode === 'live') {
      if (!livePractice) throw new Error('真实日志主动建议尚未获单独可控练习授权。默认仅回放。');
      this.live = new LiveSource({ logPath, logDir, names, rules,
        onState: state => this.controller.observe(state), onReset: reason => this.controller.reset(reason?.reason ?? String(reason)) });
    }
  }
  async source(matchId) {
    if (!this.sources.has(matchId)) this.sources.set(matchId, ReplaySource.open({ repoDir: this.repoDir, matchId }));
    return this.sources.get(matchId);
  }
  async replayProvider() {
    const entries = await ReplaySource.catalog({ repoDir: this.repoDir }), ids = new Set(entries.map(entry => entry.id));
    const get = async id => ids.has(id) ? (await this.source(id)).viewerReplay() : null;
    return { list: async () => entries, get, latest: async () => entries.length ? get(entries[0].id) : null };
  }
  async start() { this.controller.start(); if (this.live) await this.live.start(); }
  async stop() { this.controller.stop(); if (this.live) await this.live.stop(); }
  invalidateView(viewSeq) {
    if (this.sourceMode !== 'replay' || !Number.isSafeInteger(viewSeq) || viewSeq <= this.viewerSeq) return;
    this.viewerSeq = viewSeq; this.seekSession = randomUUID();
    this.previous = null; this.previousView = null;
    this.controller.reset('replay_view_loading');
  }
  async observeView({ match_id, game_number = 1, anchor, boundary = 'after', view_seq }) {
    if (this.sourceMode !== 'replay') return;
    if (!Number.isSafeInteger(view_seq) || view_seq <= this.viewerSeq) return;
    this.viewerSeq = view_seq;
    const oldView = this.previousView;
    const cursor = value => value ? value.anchor.match(/^T(\d+)-A(\d+)$/)?.slice(1).map(Number) : null;
    const oldCursor = cursor(oldView), newCursor = cursor({ anchor });
    const backwards = oldCursor && newCursor && (newCursor[0] < oldCursor[0] ||
      (newCursor[0] === oldCursor[0] && (newCursor[1] < oldCursor[1] ||
        (newCursor[1] === oldCursor[1] && oldView.boundary === 'after' && boundary === 'before'))));
    if (oldView && (match_id !== oldView.match_id || game_number !== oldView.game_number || backwards)) {
      this.seekSession = randomUUID(); this.controller.reset('replay_game_changed'); this.previous = null;
    }
    this.previousView = { match_id, game_number, anchor, boundary };
    let state;
    try {
      const source = await this.source(match_id);
      state = await source.stateForAnchor(anchor, { gameNumber: game_number, boundary });
    } catch (error) {
      if (view_seq === this.viewerSeq) { this.controller.reset('replay_source_failed'); this.previous = null; }
      throw error;
    }
    if (view_seq !== this.viewerSeq) return;
    if (!state) { this.controller.reset('unknown_view'); return; }
    if (this.previous && (state.seq < this.previous.seq || state.match_id !== this.previous.match_id || state.game_id !== this.previous.game_id)) {
      this.seekSession = randomUUID(); this.controller.reset('replay_seek');
    }
    this.previous = state;
    this.controller.observe({ ...state, session_id: this.seekSession });
  }
  snapshot() { return { ...this.controller.snapshot(), source_mode: this.sourceMode }; }
}
