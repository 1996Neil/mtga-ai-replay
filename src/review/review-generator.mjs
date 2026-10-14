import { findReviewGame, selectReviewDecisions, reviewDecisionContext, normalizeReplayReview } from './review-model.mjs';

const system = `You are an MTG Arena limited-format replay analysis assistant.
Return ONLY a JSON object, with no code fences.
Analyze strictly from the local player's point of view. Each decision request has ONE BEFORE-state and ONE
action, with NO future outcome, future draws, opponent hidden cards or hypothetical legal-action list.
The supplied action may describe what the player chose, but does not prove that another play was legal.
If the data is insufficient, do not label a misplay as certain. Prefer useful, cautious coaching over blame.
Write explanations in Simplified Chinese. Card names MUST stay in their exact English spelling as observed.
Never translate card names, invent card identities, opponent hand contents, priority or rule text.
The severity choices are critical (strong evidence of game-altering error), major (clear issue), tip
(learning opportunity), positive (good decision). Confidence: high/medium/low.
If there is no evidence of a useful insight, return worth_noting:false.
`;

async function requestJson({ apiKey, model, fetchImpl, systemText, user, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.deepseek.com/chat/completions', {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, thinking: { type: 'disabled' },
        response_format: { type: 'json_object' }, max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemText }, { role: 'user', content: JSON.stringify(user) }] }),
    });
    if (!res.ok) throw new Error(`Review model HTTP ${res.status}; no model output was accepted.`);
    const data = await res.text();
    if (Buffer.byteLength(data) > 160 * 1024) throw new Error('Review model response was too large.');
    const answer = JSON.parse(data);
    if (answer.choices?.length !== 1 || answer.choices[0].finish_reason !== 'stop' ||
      answer.choices[0].message?.tool_calls?.length) throw new Error('Review model response was incomplete.');
    const raw = answer.choices[0].message?.content;
    if (typeof raw !== 'string' || raw.length > 32000) throw new Error('Invalid review model content.');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid review model JSON.');
    return parsed;
  } finally { clearTimeout(timeout); }
}
function shortEvent(step) {
  const e = step.event ?? {}, card = e.card && !e.card.hidden ? e.card.name : null;
  return { anchor: step.anchor, turn: step.turn, type: e.type, actor: e.actor,
    card: card ?? null, amount: e.amount ?? null };
}

/**
 * Opt-in paid integration, deliberately separate from live-coach budget grants.
 * No request occurs until the same-origin user presses Generate. No fallback provider.
 */
export function createReplayReviewGenerator({
  apiKey = process.env.MTGA_REVIEW_DEEPSEEK_API_KEY,
  model = process.env.MTGA_REVIEW_DEEPSEEK_MODEL || 'deepseek-chat',
  fetchImpl = globalThis.fetch, timeoutMs = 60000, decisionLimit = 8,
} = {}) {
  if (!apiKey || /\s/.test(apiKey)) return null;
  if (!/^[a-z0-9._-]{1,80}$/.test(model)) throw new Error('Invalid replay review model.');
  return async function generateReplayReview(replay, { gameNumber }) {
    const game = findReviewGame(replay, gameNumber);
    if (!game) throw new Error('Unknown game.');
    const selected = selectReviewDecisions(game, decisionLimit);
    if (!selected.length) throw new Error('No verified pre-action states; no model request was sent.');
    const notes = [], failures = [];
    // Two requests in parallel: one decision state/request prevents hindsight
    // leakage between different turns, without blocking the UI for a long queue.
    for (let i = 0; i < selected.length; i += 2) {
      const batch = selected.slice(i, i + 2);
      const results = await Promise.allSettled(batch.map(step => {
        const context = reviewDecisionContext(replay, gameNumber, step);
        return requestJson({ apiKey, model, fetchImpl, systemText: system,
          user: { task: 'Evaluate exactly this observed action against its BEFORE state.',
            output_shape: { worth_noting: true, severity: 'tip', confidence: 'low',
              title: '简短标题', observation: '观察', suggestion: '可尝试的行动', rationale: '判断依据',
              cards: ['An English Name Seen In This State'], limitation: '不确定之处' },
            context }, maxTokens: 850, timeoutMs });
      }));
      results.forEach((result, index) => {
        const anchor = batch[index].anchor;
        if (result.status === 'rejected') { failures.push(anchor); return; }
        const n = result.value;
        if (n.worth_noting !== true) return;
        notes.push({ ...n, anchor, boundary: 'before' });
      });
    }
    const timeline = (game.steps ?? []).map(shortEvent);
    const summary = await requestJson({ apiKey, model, fetchImpl,
      systemText: `You are an MTG Arena match-summary coach. Return only JSON.
Write Simplified Chinese explanations, but keep English card names as observed.
Do not invent hidden hands, exact legal alternatives, win-probability numbers, or decisions you did not inspect.
Do not equate losing with making a mistake. The sampled decisions were analyzed WITHOUT future state.
Summarize documented events, outcome, confidence limits and coaching takeaways.
Output object: {"headline":"...","overview":"...","strengths":["..."],"improvements":["..."],"limitations":["..."]}.`,
      user: { result: game.result ?? {}, warnings: [...(replay.warnings ?? []), ...(game.warnings ?? [])],
        inspected_decisions: notes.map(n => ({ anchor: n.anchor, title: n.title, severity: n.severity,
          observation: n.observation, suggestion: n.suggestion })),
        timeline, coverage: { inspected: selected.length, total_actions: timeline.length } },
      maxTokens: 1600, timeoutMs });
    const limitations = Array.isArray(summary.limitations) ? summary.limitations : [];
    limitations.push(`仅抽查 ${selected.length} 个可还原的行动节点，共 ${timeline.length} 个动作；未分析节点不代表操作正确。`);
    if (failures.length) limitations.push(`${failures.length} 个行动节点的 AI 分析未成功，未生成推测性建议。`);
    return normalizeReplayReview(replay, gameNumber, { summary: { ...summary, limitations }, notes },
      { source: `deepseek:${model}` });
  };
}
