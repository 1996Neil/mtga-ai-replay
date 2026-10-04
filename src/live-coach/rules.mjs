import { createHash } from 'node:crypto';

// Audited descriptors feed shared primitives. Oracle text is matched exactly;
// an LLM never compiles new text into executable rules. This is a small subset,
// not an assertion that an Arena snapshot proves all active rules/priority.
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const TEXT = {
  gnaw: "Target creature you control gets +1/+0 until end of turn. Then it deals damage equal to its power to target creature you don't control.",
  bite: "Target creature you control deals damage equal to its power to target creature you don't control.",
  shot: "Target creature you control gets +1/+1 until end of turn. It deals damage equal to its power to target creature you don't control.",
  frilled: 'Reach, menace This creature enters with a +1/+1 counter on it if an opponent lost life this turn.',
  recruiter: "Trample When this creature enters, choose target creature. If that creature's power is 2 or less or if you control another Lizard, gain control of that creature until end of turn, untap it, and it gains haste until end of turn.",
  hare: 'When this creature enters, create a number of 1/1 white Rabbit creature tokens equal to the number of other creatures you control named Hare Apparent. A deck can have any number of cards named Hare Apparent.',
  crusader: "Crusader of Odric's power and toughness are each equal to the number of creatures you control.",
  warden: 'At the beginning of your end step, put a +1/+1 counter on this creature. Whenever another nontoken creature you control enters, it endures X, where X is the number of counters on this creature. (Put X +1/+1 counters on the creature that entered or create an X/X white Spirit creature token.)',
  veteran: 'Whenever this creature attacks, creatures you control get +1/+1 until end of turn.',
  gecko: 'When this creature enters, if an opponent lost life this turn, add {B}{R}. {1}{R}, Discard a card: Draw a card.',
  mentor: 'Vigilance, haste Valiant — Whenever this creature becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.',
  players: 'Whenever this creature attacks, untap target nonland permanent.',
  swordmaster: 'Offspring {2} (You may pay an additional {2} as you cast this spell. If you do, when this creature enters, create a 1/1 token copy of it.) Valiant — Whenever this creature becomes the target of a spell or ability you control for the first time each turn, Mice you control get +1/+0 until end of turn.',
  cragflame: 'Equipped creature gets +1/+1 and has vigilance, trample, and haste. Equip {2}',
  mabel: 'Other Mice you control get +1/+1. When Mabel enters, create Cragflame, a legendary colorless Equipment artifact token with "Equipped creature gets +1/+1 and has vigilance, trample, and haste" and equip {2}.',
};
export const EFFECT_MAPPINGS = Object.freeze([
  { name: 'Rabid Gnaw', text: TEXT.gnaw, primitive: 'one_way_power_damage', power_bonus: 1, toughness_bonus: 0 },
  { name: 'Rabid Bite', text: TEXT.bite, primitive: 'one_way_power_damage', power_bonus: 0, toughness_bonus: 0 },
  { name: 'Clear Shot', text: TEXT.shot, primitive: 'one_way_power_damage', power_bonus: 1, toughness_bonus: 1 },
  { name: 'Frilled Sparkshooter', text: TEXT.frilled, primitive: 'conditional_etb_counter', condition: 'opponent_lost_life_this_turn' },
  { name: 'Reptilian Recruiter', text: TEXT.recruiter, primitive: 'conditional_etb_control', condition: 'target_power_lte_2_or_another_lizard' },
  { name: 'Hare Apparent', text: TEXT.hare, primitive: 'etb_named_creature_tokens', token_power: 1, token_toughness: 1 },
  { name: 'Crusader of Odric', text: TEXT.crusader, primitive: 'current_creature_count_stats' },
]);
export const SUPPORTED_PRIMITIVES = Object.freeze(['one_way_power_damage', 'conditional_etb_counter', 'conditional_etb_control', 'etb_named_creature_tokens', 'current_creature_count_stats', 'basic_mana_payment', 'ordinary_combat_with_first_strike_trample']);
const audited = new Map([
  ['Hare Apparent', TEXT.hare], ['Warden of the Grove', TEXT.warden], ['Dauntless Veteran', TEXT.veteran],
  ['Frilled Sparkshooter', TEXT.frilled], ['Reptilian Recruiter', TEXT.recruiter], ['Flamecache Gecko', TEXT.gecko],
  ['Seedglaive Mentor', TEXT.mentor], ['Thistledown Players', TEXT.players], ['Flowerfoot Swordmaster', TEXT.swordmaster],
  ['Cragflame', TEXT.cragflame], ['Mabel, Heir to Cragflame', TEXT.mabel], ['Crusader of Odric', TEXT.crusader],
]);
const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const creature = card => list(card?.card_types).includes('Creature');
const rulesFor = (state, card) => list(state.rules).find(rule => rule.arena_id === card.arena_id);
const textFor = rule => normalize(rule?.oracle_text);
const complete = rule => Boolean(rule && typeof rule.oracle_text === 'string' && rule.metadata_complete === true && !list(rule.missing_fields).length);
const mappingFor = rule => complete(rule) && EFFECT_MAPPINGS.find(m => m.name === rule.name && normalize(m.text) === textFor(rule));
const allBattlefield = state => ['me', 'opponent'].flatMap(role => list(state.board?.players?.[role]?.battlefield));
const currentWindow = state => ({ turn: state.turn, phase: state.phase, step: state.step, active_player: state.active_player });
const ownMain = state => state.active_player === 'me' && /^Phase_Main[12]$/.test(state.phase ?? '') && !list(state.board?.stack).length;
const dynamicAbilitiesComplete = state => state.coverage?.dynamic_abilities === 'observed_complete';
const canCommand = state => dynamicAbilitiesComplete(state) && ownMain(state) && state.priority?.player === 'me' && state.priority?.fresh === true && state.priority.observed_seq === state.seq;
const identity = card => ({ instance_id: card.instance_id, arena_id: card.arena_id, controller: card.controller });
const subtitle = card => `${card.name}（${card.display_name_zh || card.name}）#${card.instance_id}`;
const spoken = (card, state) => {
  const name=card.display_name_zh || card.name;
  const duplicates=['me','opponent'].flatMap(role=>['hand','battlefield'].flatMap(zone=>list(state?.board?.players?.[role]?.[zone]))).filter(c=>c.name===card.name);
  return duplicates.length>1?`字幕编号${card.instance_id}的${name}`:name;
};
const factHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const ref = rule => ({ arena_id: rule.arena_id, name: rule.name, source: rule.source, oracle_text: rule.oracle_text });
const ruleStamp = rules => [...new Map(rules.filter(Boolean).map(rule => [rule.arena_id, ref(rule)])).values()].sort((a, b) => a.arena_id - b.arena_id);

function basicRule(rule) { return complete(rule) && /^Basic Land — (Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(rule.type_line ?? ''); }
const basicColors = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G', Wastes: 'C' };
const colorCode = color => ({ White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G', Colorless: 'C' }[color] ?? color);
function supportedManaChoices(rule) {
  if (basicRule(rule)) return [basicColors[rule.type_line.split(' — ')[1]]];
  if (complete(rule) && rule.name === 'Wind-Scarred Crag' && textFor(rule) === normalize('This land enters tapped. When this land enters, you gain 1 life. {T}: Add {R} or {W}.')) return ['R', 'W'];
  return null;
}

/** Payment uses distinct untapped supported lands and current observed pool.
 * Hybrid, X, Phyrexian, restrictions, extra costs, attached mana effects and
 * stale nonempty pools are not silently treated as spendable generic mana. */
export function checkBasicManaCost(state, manaCost) {
  const tokens = [...String(manaCost ?? '').matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
  if (!tokens.length || tokens.map(t => `{${t}}`).join('') !== manaCost || tokens.some(t => !/^(\d+|[WUBRGC])$/.test(t))) return { payable: false, status: 'unknown', reasons: ['unsupported_mana_cost'] };
  const required = {}, sources = [], usedRules = [];
  let generic = 0;
  for (const token of tokens) if (/^\d+$/.test(token)) generic += Number(token); else required[token] = (required[token] ?? 0) + 1;
  for (const card of list(state.board?.players?.me?.battlefield)) {
    if (card.controller !== 'me' || card.is_tapped !== false || card.is_copy || list(card.attachments).length) continue;
    const rule = rulesFor(state, card), choices = supportedManaChoices(rule);
    if (choices) { sources.push({ instance_id: card.instance_id, choices }); usedRules.push(rule); }
  }
  const me = state.board?.players?.me;
  const pool = list(me?.mana_pool);
  const freshPool = me?.mana_pool_source === 'current_observed' || state.mana_pool_fresh === true;
  if (freshPool) for (const entry of pool) {
    const color = colorCode(entry.color);
    if (!/^[WUBRGC]$/.test(color ?? '') || !Number.isSafeInteger(entry.amount) || entry.amount < 0 || entry.amount > 100) return { payable: false, status: 'unknown', reasons: ['unknown_mana_pool'] };
    for (let i = 0; i < entry.amount; i++) sources.push({ pool: true, choices: [color] });
  }
  const colors = Object.entries(required).flatMap(([color, count]) => Array(count).fill(color));
  const search = (index, available, payment) => {
    if (index === colors.length) return available.length >= generic ? [...payment, ...available.slice(0, generic).map(source => ({ ...source, pays: 'generic' }))] : null;
    for (let i = 0; i < available.length; i++) if (available[i].choices.includes(colors[index])) {
      const result = search(index + 1, available.filter((_, n) => n !== i), [...payment, { ...available[i], pays: colors[index] }]);
      if (result) return result;
    }
    return null;
  };
  const payment = search(0, sources, []);
  return { payable: Boolean(payment), status: payment ? 'supported_subset_checked' : 'insufficient_supported_mana', payment: payment ?? [], rule_refs: ruleStamp(usedRules), ignored_stale_pool: !freshPool && pool.length > 0, reasons: payment ? [] : ['no_supported_payment'] };
}

function ruleKnownForDamage(rule) {
  if (!complete(rule)) return false;
  if (basicRule(rule) || supportedManaChoices(rule)) return true;
  if (textFor(rule) === '') return true;
  return audited.has(rule.name) && normalize(audited.get(rule.name)) === textFor(rule)
    && !['Mabel, Heir to Cragflame', 'Cragflame', 'Crusader of Odric', 'Seedglaive Mentor', 'Flowerfoot Swordmaster'].includes(rule.name);
}
function damageCoverage(state) {
  const cards = allBattlefield(state), rules = cards.map(card => rulesFor(state, card));
  const missing = cards.filter((_, i) => !ruleKnownForDamage(rules[i]));
  return { supported: state.coverage?.state_complete === true && !list(state.board?.stack).length && !missing.length,
    reasons: missing.map(card => `uncovered_board_rule:${card.instance_id}`), rules: rules.filter(Boolean) };
}
function candidate(state, data) {
  const facts = data.immutable_facts;
  return { session_id: state.session_id, match_id: state.match_id, game_id: state.game_id, seq: state.seq,
    tactical_confidence: 'conditional_rules_checked', strategic_confidence: 'not_evaluated', intensity: 0.3,
    emotion: 'calm', premises: [{ type: 'window', ...currentWindow(state) }], ...data,
    action_id: data.action_id, certificate: { window: currentWindow(state), facts_hash: factHash(facts), rules_hash: factHash(data.rule_refs), kind: data.kind, legality_status: data.legality_status } };
}
function damageCandidates(state) {
  if (!ownMain(state)) return [];
  const coverage = damageCoverage(state); if (!coverage.supported) return [];
  const result = [], me = state.board.players.me;
  for (const spell of list(me.hand)) {
    const rule = rulesFor(state, spell), effect = mappingFor(rule);
    if (effect?.primitive !== 'one_way_power_damage') continue;
    const payment = checkBasicManaCost(state, rule.mana_cost); if (!payment.payable) continue;
    for (const source of list(me.battlefield).filter(creature)) for (const target of list(state.board.players.opponent?.battlefield).filter(creature)) {
      if (source.controller !== 'me' || target.controller === 'me' || !finite(source.power) || !finite(target.toughness) || !finite(target.damage_marked)
        || list(source.current_keywords).some(k=>/deathtouch|lifelink|infect|wither/i.test(k)) || list(target.current_keywords).some(k=>/protection|hexproof|shroud|ward|indestructible/i.test(k))
        || source.is_copy || target.is_copy || list(source.attachments).length || list(target.attachments).length) continue;
      const damage = Math.max(0, source.power + effect.power_bonus), lethal = damage + target.damage_marked >= target.toughness;
      if (!lethal || damage <= 0) continue;
      const command = canCommand(state);
      const facts = { spell: identity(spell), source: { ...identity(source), power: source.power }, target: { ...identity(target), toughness: target.toughness, damage_marked: target.damage_marked }, power_bonus: effect.power_bonus, damage, lethal: true, mana_cost: rule.mana_cost, one_way: true, requires_attack: false };
      result.push(candidate(state, { action_id: `power-damage:${spell.instance_id}:${source.instance_id}:${target.instance_id}`, effect: effect.primitive,
        kind: command ? 'tactic' : 'explanation', targets: [source.instance_id, target.instance_id], spell_instance_id: spell.instance_id,
        legality_status: dynamicAbilitiesComplete(state) ? 'supported_subset_checked' : 'unknown', score: 90 + target.power,
        immutable_facts: facts, rule_refs: ruleStamp([rule, ...coverage.rules]),
        premises: [{ type: 'window', ...currentWindow(state) }, { type: 'no_extra_response_or_uncovered_effect' }, { type: 'dynamic_abilities', observed_complete: dynamicAbilitiesComplete(state) }, { type: 'payable', mana_cost: rule.mana_cost }],
        speech_core: `${command ? '' : '按当前数值、没有额外响应或临时保护的话，'}${spoken(spell,state)}能解${spoken(target,state)}，不用攻击。`,
        speech_followup: `让${spoken(source,state)}单向打${damage}点，它不会反打。`,
        subtitle: `${subtitle(spell)} → ${subtitle(source)} → ${subtitle(target)}；${source.power}+${effect.power_bonus}=${damage}，单向伤害。`, emotion: 'excited', intensity: 0.45 }));
    }
  }
  return result;
}
function etbCandidates(state) {
  if (!ownMain(state)) return [];
  const result = [], me = state.board.players.me;
  for (const card of list(me.hand)) {
    const rule = rulesFor(state, card), effect = mappingFor(rule); if (!effect) continue;
    const payment = checkBasicManaCost(state, rule.mana_cost); if (!payment.payable) continue;
    const command = canCommand(state) && damageCoverage(state).supported;
    if (effect.primitive === 'conditional_etb_counter') {
      const lost = state.life_lost_this_turn?.opponent;
      const clause = lost === true ? '对手本回合已经失血，进场可带一个加一加一指示物。' : lost === false ? '如果先让对手失血，再让它进场，才会带加一加一指示物；别假定攻击一定能打中。' : '它要在对手本回合失血后进场才有加一加一；现在失血条件还没核实。';
      result.push(candidate(state, { action_id: `etb-counter:${card.instance_id}`, kind: command && lost === true ? 'tactic' : 'explanation', effect: effect.primitive, targets: [card.instance_id],
        legality_status: !dynamicAbilitiesComplete(state) || lost === null || lost === undefined ? 'unknown' : 'supported_subset_checked', score: 55, immutable_facts: { card: identity(card), opponent_lost_life: lost ?? null, counter_bonus: 1, mana_cost: rule.mana_cost },
        rule_refs: [ref(rule)], speech_core: `${spoken(card,state)}：${clause}`, speech_followup: '', subtitle: `${subtitle(card)}；失血条件=${String(lost ?? 'unknown')}。` }));
    }
    if (effect.primitive === 'conditional_etb_control') {
      // Recruiter is in hand; its own instance is never the "another Lizard".
      const another = list(me.battlefield).filter(c => creature(c) && c.instance_id !== card.instance_id && complete(rulesFor(state,c)) && /(?:—|\s)Lizard(?:\s|$)/.test(rulesFor(state, c)?.type_line ?? ''));
      for (const target of list(state.board.players.opponent?.battlefield).filter(creature)) {
        if (!finite(target.power)) continue;
        const enabled = target.power <= 2 || another.length > 0;
        result.push(candidate(state, { action_id: `etb-control:${card.instance_id}:${target.instance_id}`, kind: 'explanation', effect: effect.primitive,
          targets: [target.instance_id], legality_status: dynamicAbilitiesComplete(state) && damageCoverage(state).supported ? 'supported_subset_checked' : 'unknown', score: enabled ? 60 : 30,
          immutable_facts: { card: identity(card), target: { ...identity(target), power: target.power }, other_lizard_ids: another.map(c => c.instance_id).sort((a,b) => a-b), condition_satisfied: enabled, mana_cost: rule.mana_cost },
          rule_refs: ruleStamp([rule, ...another.map(c => rulesFor(state,c))]), speech_core: enabled ? `${spoken(card,state)}的进场条件满足，可以暂借${spoken(target,state)}；仍要确认目标保护和响应。` : `${spoken(card,state)}不能靠自己满足“另一只蜥蜴”；${spoken(target,state)}力量超过二，当前条件不满足。`,
          speech_followup: '', subtitle: `${subtitle(card)} → ${subtitle(target)}；另一只蜥蜴=${another.map(c=>c.instance_id).join(',') || '无'}。` }));
      }
    }
  }
  for (const card of list(me.battlefield)) {
    const rule = rulesFor(state, card), effect = mappingFor(rule);
    if (effect?.primitive !== 'conditional_etb_counter' || !finite(card.power) || !finite(card.toughness) || !list(card.counters).some(c => c.name === '+1/+1' && c.count > 0)) continue;
    result.push(candidate(state, { action_id: `current-stats:${card.instance_id}`, effect: 'current_observed_stats', kind: 'explanation', targets: [card.instance_id], legality_status: 'supported_subset_checked', score: 50,
      immutable_facts: { card: identity(card), power: card.power, toughness: card.toughness, counters: card.counters, summoning_sickness: card.has_summoning_sickness }, rule_refs: [ref(rule)],
      speech_core: `${spoken(card,state)}当前已经是${card.power}/${card.toughness}，指示物已算进去了。`, speech_followup: card.has_summoning_sickness ? '召唤失调限制攻击和横置费用，不妨碍普通阻挡。' : '', subtitle: `${subtitle(card)}；当前 ${card.power}/${card.toughness}，不重复加指示物。` }));
  }
  const options = list(me.hand).filter(c => ['etb_named_creature_tokens','current_creature_count_stats'].includes(mappingFor(rulesFor(state,c))?.primitive));
  for (const card of options) {
    const rule = rulesFor(state, card), payment = checkBasicManaCost(state, rule.mana_cost); if (!payment.payable) continue;
    const own = list(me.battlefield).filter(creature), hare = rule.name === 'Hare Apparent', tokens = own.filter(c => c.name === 'Hare Apparent').length;
    const stats = hare ? { adds_creatures: 1 + tokens, token_count: tokens } : { predicted_power: own.length + 1, predicted_toughness: own.length + 1 };
    result.push(candidate(state, { action_id: `develop:${card.instance_id}`, kind: 'explanation', effect: hare ? 'etb_named_creature_tokens' : 'current_creature_count_stats', targets: [card.instance_id], legality_status: 'supported_subset_checked', score: 45,
      immutable_facts: { card: identity(card), own_creature_ids: own.map(c => c.instance_id).sort((a,b)=>a-b), ...stats, mana_cost: rule.mana_cost }, rule_refs: [ref(rule)],
      speech_core: hare ? `${spoken(card,state)}进场会多一只本体和${tokens}只一一兔子。` : `按当前生物数量，${spoken(card,state)}进场后是${own.length + 1}/${own.length + 1}。`,
      speech_followup: '横铺和大怪都有取舍，不能只凭最后输赢判这步错。', subtitle: `${subtitle(card)}；${JSON.stringify(stats)}；战略优劣未裁定。`, strategy_disputed: options.length > 1 }));
  }
  return result;
}

const combatKeywords = new Set(['Flying','Reach','First strike','Trample','Vigilance','Haste']);
function combatProfile(state, card) {
  const rule = rulesFor(state, card); if (list(card.current_keywords).some(k=>!combatKeywords.has(k)) || !complete(rule) || !finite(card.power) || !finite(card.toughness) || !finite(card.damage_marked)) return null;
  let keywords = list(rule.keywords), conditional = false;
  const onlyKeywords = String(rule.oracle_text).split(/,\s*|\s*\n\s*/).map(normalize).every(k => combatKeywords.has(k));
  const known = audited.get(rule.name);
  if (textFor(rule) && !onlyKeywords && (!known || normalize(known) !== textFor(rule))) return null;
  if (!onlyKeywords && textFor(rule)) {
    if (rule.name === 'Crusader of Odric' || rule.name === 'Mabel, Heir to Cragflame') conditional = true;
    // These audited triggers do not fire merely from declaring a block.
    keywords = keywords.filter(k => combatKeywords.has(k));
    if (rule.name === 'Frilled Sparkshooter' && card.is_attacking) return null; // Menace is outside blocking subset.
  }
  for (const id of list(card.attachments)) {
    const attachment = allBattlefield(state).find(c => c.instance_id === id), attachmentRule = attachment && rulesFor(state, attachment);
    if (!attachmentRule || attachmentRule.name !== 'Cragflame' || textFor(attachmentRule) !== normalize(TEXT.cragflame) || !complete(attachmentRule)) return null;
    keywords = [...keywords, 'Trample','Vigilance','Haste']; conditional = true; // observed stats include equipment, never add again
  }
  return { ...card, keywords: [...new Set(keywords)], conditional };
}
const has = (card, keyword) => card.keywords.includes(keyword);
const legalBlock = (attacker, blocker) => !has(attacker,'Flying') || has(blocker,'Flying') || has(blocker,'Reach');
function permutations(items) { if (items.length <= 1) return [items]; return items.flatMap((item, i) => permutations(items.filter((_, j)=>i!==j)).map(rest=>[item,...rest])); }
function simulateOne(attacker, blockers, order) {
  const a = { ...attacker, damage: attacker.damage_marked, alive: true }, bs = blockers.map(b=>({ ...b, damage:b.damage_marked, alive:true }));
  let lifeDamage = 0;
  for (const first of [true,false]) {
    const attackersStrike = a.alive && has(a,'First strike') === first;
    const hits = bs.filter(b => b.alive && has(b,'First strike') === first);
    const damageToAttacker = hits.reduce((sum,b)=>sum+Math.max(0,b.power),0);
    if (attackersStrike) {
      let remaining = Math.max(0,a.power);
      const alive = order.map(id=>bs.find(b=>b.instance_id===id)).filter(b=>b.alive);
      for (const blocker of alive) { const damage = Math.min(remaining,Math.max(0,blocker.toughness-blocker.damage));blocker.damage+=damage;remaining-=damage; }
      if (!blockers.length || has(a,'Trample')) lifeDamage += remaining;
    }
    a.damage += damageToAttacker;
    if (a.damage >= a.toughness) a.alive=false;
    for (const b of bs) if (b.damage >= b.toughness) b.alive=false;
  }
  return { life_damage: lifeDamage, attacker_dies: !a.alive, blocker_deaths: bs.filter(b=>!b.alive).map(b=>b.instance_id) };
}
/** Pure combat arithmetic over the audited subset. Reports worst damage across
 * damage orders; unknown protection/prevention/deathtouch/double strike or
 * restrictions return unsupported. Summoning sickness never rejects a block. */
export function evaluateCombat(state, assignments) {
  const attackers = list(state.committed_combat?.attackers).map(id=>allBattlefield(state).find(c=>c.instance_id===id));
  const profiles = attackers.map(c=>c && combatProfile(state,c));
  const boardCovered = allBattlefield(state).every(card => { const r=rulesFor(state,card); return complete(r) && (basicRule(r)||supportedManaChoices(r)||textFor(r)===''||(audited.has(r.name)&&normalize(audited.get(r.name))===textFor(r))||combatProfile(state,card)); });
  if (new Set(list(state.committed_combat?.attackers)).size !== profiles.length || !boardCovered || !profiles.length || profiles.some(c=>!c) || state.committed_combat?.source === 'tentative' || list(state.board?.stack).length || state.coverage?.state_complete !== true) return { supported:false,reasons:['unknown_combat_rules_or_state'] };
  const seen = new Set(), results=[];
  for (const attacker of profiles) {
    const ids = list(assignments).filter(row=>list(row.attacker_ids).includes(attacker.instance_id)).map(row=>row.instance_id);
    const blockers = ids.map(id=>allBattlefield(state).find(c=>c.instance_id===id)).map(c=>c && combatProfile(state,c));
    for (const [i,b] of blockers.entries()) {
      if (!b || b.controller === attacker.controller || b.is_tapped !== false || !creature(b) || seen.has(ids[i]) || !legalBlock(attacker,b)) return { supported:false,reasons:['illegal_or_unknown_block'] };
      seen.add(ids[i]);
    }
    if (ids.length > 6) return {supported:false,reasons:['damage_order_limit']};
    const sims=permutations(ids).map(order=>simulateOne(attacker,blockers,order));
    results.push({ attacker_id:attacker.instance_id,blocker_ids:ids,life_damage:Math.max(...sims.map(s=>s.life_damage)),attacker_dies:sims.every(s=>s.attacker_dies),conditional:attacker.conditional||blockers.some(b=>b.conditional) });
  }
  if (list(assignments).some(row => list(row.attacker_ids).length !== 1 || !profiles.some(a=>a.instance_id===row.attacker_ids[0]))) return {supported:false,reasons:['unsupported_multi_attacker_block']};
  return {supported:true,conditional:results.some(r=>r.conditional),life_damage:results.reduce((sum,r)=>sum+r.life_damage,0),results};
}
function combatCandidates(state) {
  if (state.active_player !== 'opponent' || state.phase !== 'Phase_Combat' || !['Step_DeclareAttack','Step_DeclareBlock'].includes(state.step)) return [];
  const attackers=list(state.committed_combat?.attackers); if (!attackers.length || attackers.length>4) return [];
  // Every public permanent must have full rules; complex global effects force
  // a conditional arithmetic explanation, never a definite blocking command.
  const cards=allBattlefield(state), rules=cards.map(c=>rulesFor(state,c));if(rules.some(r=>!complete(r)))return [];
  const blockers=list(state.board?.players?.me?.battlefield).filter(c=>creature(c)&&c.is_tapped===false&&combatProfile(state,c));
  if (!blockers.length || blockers.length>8) return [];
  const profiles=attackers.map(id=>combatProfile(state,cards.find(c=>c.instance_id===id)));if(profiles.some(p=>!p))return [];
  const groups = profiles.map(attacker => {
    const options=[];
    for(let mask=0;mask<(1<<blockers.length);mask++) {
      const rows=blockers.filter((_,i)=>mask&(1<<i)).map(b=>({instance_id:b.instance_id,attacker_ids:[attacker.instance_id]}));
      const projected={...state,board:{...state.board,stack:[]},committed_combat:{...state.committed_combat,attackers:[attacker.instance_id]}};
      const result=evaluateCombat(projected,rows);
      if(result.supported)options.push({mask,rows,result,kills:Number(result.results[0].attacker_dies)});
    }
    return options;
  });
  const memo=new Map();
  const solve=(index,used)=>{
    if(index===groups.length)return{rows:[],result:{supported:true,conditional:false,life_damage:0,results:[]},kills:0};
    const key=`${index}:${used}`;if(memo.has(key))return memo.get(key);
    let best=null;
    for(const option of groups[index]) {
      if(option.mask&used)continue;
      const next=solve(index+1,used|option.mask);if(!next)continue;
      const value={rows:[...option.rows,...next.rows],result:{supported:true,conditional:option.result.conditional||next.result.conditional,life_damage:option.result.life_damage+next.result.life_damage,results:[...option.result.results,...next.result.results]},kills:option.kills+next.kills};
      if(!best||value.result.life_damage<best.result.life_damage||(value.result.life_damage===best.result.life_damage&&value.kills>best.kills))best=value;
    }
    memo.set(key,best);return best;
  };
  const best=solve(0,0);
  if(!best||!best.rows.length||!finite(state.board.players.me.life))return [];
  const unresolvedStack=list(state.board.stack).length>0;
  const remaining=state.board.players.me.life-best.result.life_damage;
  const key=`combat:${attackers.join(',')}:${factHash(best.rows)}`;
  return [candidate(state,{action_id:key,kind:'explanation',effect:'ordinary_combat',targets:best.rows.map(r=>r.instance_id),legality_status:!dynamicAbilitiesComplete(state)||best.result.conditional||unresolvedStack?'unknown':'supported_subset_checked',score:remaining>0?80:35,
    immutable_facts:{attackers:profiles.map(c=>({...identity(c),power:c.power,toughness:c.toughness,damage_marked:c.damage_marked,keywords:c.keywords})),blockers:blockers.map(c=>({...identity(c),power:c.power,toughness:c.toughness,damage_marked:c.damage_marked,is_tapped:c.is_tapped})),assignments:best.rows,unresolved_stack_ids:list(state.board.stack).map(c=>c.instance_id),life:state.board.players.me.life,life_damage:best.result.life_damage,remaining_life:remaining},rule_refs:ruleStamp(rules),
    speech_core:remaining>0?`${unresolvedStack?'堆叠还没结算；如果结算后数值不变，':'只按当前数值、没有额外变化，'}这组阻挡最多漏${best.result.life_damage}点，可以留${remaining}血。`:`${unresolvedStack?'堆叠还没结算；如果结算后数值不变，':'只按当前数值，'}这组阻挡仍会漏${best.result.life_damage}点；还需要别的解法。`,speech_followup:'这是存活算术，不能保证赢；复杂持续效果和对手响应仍未核验。',subtitle:`阻挡实例：${best.rows.map(r=>`#${r.instance_id} → #${r.attacker_ids[0]}`).join('；')}；剩余生命=${remaining}；策略与胜负未知。`,combat_assignment:best.rows,conditional:true})];
}

export function generateCandidates(state) {
  if (!state || state.terminal || state.coverage?.state_complete !== true || !state.board?.players?.me || !state.board?.players?.opponent) return [];
  return [...damageCandidates(state),...etbCandidates(state),...combatCandidates(state)].sort((a,b)=>b.score-a.score||a.action_id.localeCompare(b.action_id));
}
/** Recompute only the candidate's semantic prerequisites. Seq/state_id changes
 * alone do not invalidate it. A new session/game, completed turn/window,
 * changed target/number/rule/payment or lost fresh priority does. */
export function verifyCandidate(value,state) {
  const reasons=[];
  for(const field of ['session_id','match_id','game_id'])if(value?.[field]!==state?.[field])reasons.push(`${field}_changed`);
  if(state?.terminal)reasons.push('terminal');
  if(!value?.certificate||!value.action_id)reasons.push('missing_certificate');
  if(reasons.length)return{valid:false,reasons};
  const current=generateCandidates(state).find(c=>c.action_id===value.action_id);
  if(!current)return{valid:false,reasons:['candidate_no_longer_supported']};
  if(JSON.stringify(value.certificate.window)!==JSON.stringify(current.certificate.window))reasons.push('window_changed');
  if(value.certificate.facts_hash!==current.certificate.facts_hash)reasons.push('relevant_facts_changed');
  if(value.certificate.rules_hash!==current.certificate.rules_hash)reasons.push('rule_coverage_changed');
  if(value.kind==='tactic'&&current.kind!=='tactic')reasons.push('priority_no_longer_fresh');
  if(value.certificate.facts_hash!==factHash(value.immutable_facts))reasons.push('candidate_facts_tampered');
  if(value.certificate.rules_hash!==factHash(value.rule_refs))reasons.push('candidate_rules_tampered');
  if(value.speech_core!==current.speech_core||value.speech_followup!==current.speech_followup||value.subtitle!==current.subtitle)reasons.push('candidate_speech_tampered');
  return {valid:reasons.length===0,reasons};
}
export function candidateToAdvice(value,state) {
  const check=verifyCandidate(value,state);if(!check.valid)throw new Error(`Candidate is invalid: ${check.reasons.join(', ')}`);
  return { advice_id:`advice:${state.session_id}:${state.game_id}:${value.action_id}:${value.certificate.facts_hash}`,session_id:state.session_id,match_id:state.match_id,game_id:state.game_id,seq:state.seq,
    kind:value.kind,action_id:value.action_id,targets:[...value.targets],legality_status:value.legality_status,premises:structuredClone(value.premises),rule_refs:structuredClone(value.rule_refs),
    invalidation_conditions:['new_session_match_or_game','terminal','relevant_instance_or_rules_changed','payment_no_longer_supported','window_passed','mute'], deadline:null,
    tactical_confidence:value.tactical_confidence,strategic_confidence:value.strategic_confidence,immutable_facts:structuredClone(value.immutable_facts),
    speech_core:value.speech_core,speech_followup:value.speech_followup,subtitle:value.subtitle,emotion:value.emotion,intensity:value.intensity,
    candidate:structuredClone(value) };
}
