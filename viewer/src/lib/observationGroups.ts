import type { ReplayStep } from '../types/game.ts';

/** One GRE observation can describe several simultaneous effects, not intermediate boards. */
export function observationGroup(steps: readonly ReplayStep[], index: number) {
  let start = index, end = index;
  const id = steps[index]?.stateId;
  if (id) {
    while (start > 0 && steps[start - 1].stateId === id) start--;
    while (end + 1 < steps.length && steps[end + 1].stateId === id) end++;
  }
  return { start, end, steps: steps.slice(start, end + 1) };
}

export function observationGroups(steps: readonly ReplayStep[]) {
  const groups: ReturnType<typeof observationGroup>[] = [];
  for (let i = 0; i < steps.length;) {
    const group = observationGroup(steps, i);
    groups.push(group); i = group.end + 1;
  }
  return groups;
}
