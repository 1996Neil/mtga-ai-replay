import type { CanonicalEvent } from '../types/game.ts';

// Display names never replace canonical English identity or modify replay data.
export type DisplayNameMap = ReadonlyMap<number, string | { display_name_zh?: string; name?: string; arena_id?: number }>;
type DisplayCard = { name?: unknown; arena_id?: unknown; grpId?: unknown; visibility?: unknown; hidden?: unknown };
const hidden = (card: DisplayCard) => card.hidden === true || /hidden|post.?game/i.test(String(card.visibility ?? ''));

export function displayCardName(card?: DisplayCard, names?: DisplayNameMap): string {
  if (!card || hidden(card)) return '未知牌';
  const id = Number(card.arena_id ?? card.grpId);
  const localized = names?.get(id);
  const zh = typeof localized === 'string' ? localized : localized?.display_name_zh;
  if (zh?.trim()) return zh.trim();
  return typeof card.name === 'string' && card.name.trim() ? card.name : '未知牌';
}

export const actorLabelZh = (actor?: string | number): string => actor === 'me' || actor === 1 ? '我'
  : actor === 'opponent' || actor === 2 ? '对手' : actor === 'both' ? '双方' : '未知玩家';

const phaseNames: Record<string, string> = {
  Phase_Begin: '开始阶段', Phase_Beginning: '开始阶段', Phase_Main1: '战斗前主阶段',
  Phase_Combat: '战斗阶段', Phase_Main2: '战斗后主阶段', Phase_End: '结束阶段', Phase_Ending: '结束阶段',
  Phase_Pregame: '起手与调度', Begin: '开始阶段', Beginning: '开始阶段', 'Main 1': '战斗前主阶段',
  Combat: '战斗阶段', 'Main 2': '战斗后主阶段', End: '结束阶段', Ending: '结束阶段', Pregame: '起手与调度',
};
const stepNames: Record<string, string> = {
  Step_Untap: '重置', Step_Upkeep: '维持', Step_Draw: '抓牌', Step_BeginCombat: '战斗开始',
  Step_DeclareAttack: '宣告攻击', Step_DeclareAttackers: '宣告攻击', Step_DeclareBlock: '宣告阻挡',
  Step_DeclareBlockers: '宣告阻挡', Step_FirstStrikeDamage: '先攻伤害', Step_CombatDamage: '战斗伤害',
  Step_EndCombat: '战斗结束', Step_End: '结束步骤', Step_Cleanup: '清除步骤',
  Untap: '重置', Upkeep: '维持', Draw: '抓牌', 'Begin Combat': '战斗开始', 'Declare Attack': '宣告攻击',
  'Declare Block': '宣告阻挡', 'First Strike Damage': '先攻伤害', 'Combat Damage': '战斗伤害',
  'End Combat': '战斗结束', Cleanup: '清除步骤',
};
export function phaseLabelZh(phase?: string): string { return phaseNames[phase ?? ''] ?? (phase && /[\u3400-\u9fff]/.test(phase) ? phase : '未记录阶段'); }
export function stepLabelZh(step?: string): string { return stepNames[step ?? ''] ?? (step && /[\u3400-\u9fff]/.test(step) ? step : ''); }
export function phaseTextZh(phase?: string, step?: string): string {
  const label = phaseLabelZh(phase), detail = stepLabelZh(step);
  return detail ? `${label} · ${detail}` : label;
}
export function translatePhaseText(label: string): string {
  return label.replace(/Turn\s+(\d+)/gi, '第 $1 回合').split(' · ').map(part =>
    phaseNames[part] ?? stepNames[part] ?? part).join(' · ');
}
const zones: Record<string, string> = { Battlefield: '战场', Hand: '手牌', Graveyard: '墓地', Exile: '放逐区', Stack: '堆叠', Library: '牌库', Command: '统帅区' };
const zoneLabel = (value?: string) => zones[(value ?? '').replace(/^ZoneType_/, '')] ?? '其他区域';

export function describeEventZh(event: CanonicalEvent, names?: DisplayNameMap): string {
  const actor = actorLabelZh(event.actor), card = displayCardName(event.card, names);
  const targets = (event.targets ?? []).map(target => target.player ? actorLabelZh(String(target.player)) : displayCardName(target, names)).join('、');
  switch (event.type) {
    case 'draw': return event.actor === 'opponent' ? `对手抓 ${event.amount ?? 1} 张牌` : event.card ? `${actor}抓牌：${card}` : `${actor}抓 ${event.amount ?? 1} 张牌`;
    case 'cast': return `${actor}施放 ${card}${targets ? ` → ${targets}` : ''}`;
    case 'land': case 'land_played': return `${actor}使用地牌 ${card}`;
    case 'enters': case 'entered_battlefield': return `${card}进入战场`;
    case 'attack': return `${card}攻击${targets ? ` → ${targets}` : ''}`;
    case 'block': return `${card}阻挡${targets ? ` ${targets}` : ''}`;
    case 'attack_selection': return `选择 ${card}攻击${targets ? ` → ${targets}` : ''}（待确认）`;
    case 'block_selection': return `选择 ${card}阻挡${targets ? ` ${targets}` : ''}（待确认）`;
    case 'attack_selection_cancelled': return `撤销 ${card}的攻击选择`;
    case 'block_selection_cancelled': return `撤销 ${card}的阻挡选择`;
    case 'target': return `${card}指定目标 → ${targets || '未知目标'}`;
    case 'damage': return `${event.card ? card : actor}对${targets || '未知目标'}造成 ${event.amount ?? '?'} 点${event.step === 'Step_FirstStrikeDamage' ? '先攻' : event.step === 'Step_CombatDamage' ? '战斗' : ''}伤害`;
    case 'life': case 'life_changed': return `生命变化：我 ${event.life?.me ?? '?'} · 对手 ${event.life?.opponent ?? '?'}`;
    case 'destroy': case 'destroyed': return `${card}被消灭`;
    case 'dies': return `${card}死亡`;
    case 'put_into_graveyard': return `${card}${event.details === 'SBA_ZeroLoyalty' ? '因忠诚为零' : event.details === 'SBA_UnattachedAura' ? '因未结附' : ''}置入墓地`;
    case 'exile': return `${card}被放逐`;
    case 'sacrifice': return `${actor}牺牲 ${card}`;
    case 'discard': return `${actor}弃掉 ${card}`;
    case 'resolve': return `${card}结算`;
    case 'return': return `${card}返回${zoneLabel(event.to ?? 'Hand')}`;
    case 'activate': return `${actor}起动 ${card}的异能`;
    case 'trigger': return `${card}的异能触发`;
    case 'ability': return `${card}产生异能`;
    case 'counter': {
      const added = /added/i.test(event.details ?? ''), removed = /removed/i.test(event.details ?? '');
      return `${card}${added ? '增加' : removed ? '移去' : '改变'}${event.amount != null ? ` ${event.amount} 个` : ''}计数器`;
    }
    case 'token': return `${actor}派出${event.amount && event.amount > 1 ? ` ${event.amount} 个` : ''} ${card}衍生物`;
    case 'state': return event.details === 'Hand updated' ? '我的手牌更新' : event.details === 'Visible board / stack updated' ? '战场与堆叠更新' : '局面更新';
    case 'game_over': return '对局结束（终局状态）';
    case 'phase': return phaseTextZh(event.phase, event.step);
    case 'mulligan': return `${actor}进行调度`;
    case 'mulligan_state': return '我的起手牌与调度';
    case 'reveal': return `${actor}展示 ${card}`;
    default: return event.card ? `${actor}操作 ${card}` : '记录局面变化';
  }
}
