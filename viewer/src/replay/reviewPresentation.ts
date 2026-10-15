export type Importance = 'critical' | 'major' | 'normal';
export type Assessment = 'suggestion' | 'possible_error' | 'positive';
export type Severity = 'critical' | 'major' | 'tip' | 'positive';
export const importanceLabel = { critical: '关键决策', major: '重要决策', normal: '一般建议' };
export const assessmentLabel = { suggestion: '策略建议', possible_error: '建议核查', positive: '值得保留' };
export const confidenceLabel = { high: '较高', medium: '中等', low: '较低' };
export function reviewPresentation(note: { importance?: Importance; assessment?: Assessment; severity: Severity; confidence: keyof typeof confidenceLabel }) {
  const importance = note.importance ?? (['critical', 'major'].includes(note.severity) ? note.severity as 'critical' | 'major' : 'normal');
  const assessment = note.assessment ?? (note.severity === 'positive' ? 'positive' : ['critical', 'major'].includes(note.severity) ? 'possible_error' : 'suggestion');
  const tone: Severity = assessment === 'positive' ? 'positive' : importance === 'normal' ? 'tip' : importance;
  return { importance, assessment, tone, rank: ({ critical: 0, major: 1, normal: 2 })[importance],
    label: importanceLabel[importance], judgment: assessmentLabel[assessment], confidence: confidenceLabel[note.confidence],
    symbol: assessment === 'positive' ? '✓' : importance === 'normal' ? 'i' : '◆',
    accessible: `${importanceLabel[importance]}，AI 判断：${assessmentLabel[assessment]}，置信度${confidenceLabel[note.confidence]}` };
}
