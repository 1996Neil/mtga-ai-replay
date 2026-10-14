const known: Record<string, string> = {
  'Turns use global Arena numbering (each player turn increments it).': '回合采用 Arena 全局编号；每位玩家开始新回合时，编号都会递增。',
  'Legal alternatives/priority windows are not reconstructed; ability text and counter names may be incomplete.': '未还原所有合法行动和优先权窗口；异能文字及指示物名称可能不完整。',
  'Priority is the last observed GRE value; unrecorded priority windows are unknown.': '优先权为日志最后一次观测值；未记录的优先权窗口无法确认。',
  'Kept starting hand unavailable in this log.': '日志缺少最终保留的起手牌，无法完整还原调度过程。',
  'Terminal GRE state unavailable; final life and trailing operations may be incomplete.': '日志缺少终局状态；最终生命值及末尾行动可能不完整。',
};
export function integrityMessages(values: string[]) {
  return [...new Set(values)].map(original => ({ original,
    chinese: known[original] ?? (/\p{Script=Han}/u.test(original) ? original : '存在尚未归类的数据完整性限制，请展开查看日志说明原文。'),
    translated: Boolean(known[original]) || /\p{Script=Han}/u.test(original) }));
}
