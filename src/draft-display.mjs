import { validAccountKey } from './account-scope.mjs';
import { createHash } from 'node:crypto';

const poolKey = pool => JSON.stringify([...pool.reduce((counts, card) =>
  counts.set(card.arena_id, (counts.get(card.arena_id) ?? 0) + 1), new Map())].sort(([a], [b]) => a - b));
function withMatches(run, matches) {
  const wins = matches.filter(match => match.result === 'Win').length;
  const losses = matches.filter(match => match.result === 'Loss').length;
  const verified = matches.length > 0 && matches.every(match => ['Win', 'Loss', 'Draw'].includes(match.result))
    && run.course_wins === wins && run.course_losses === losses;
  return { ...run, matches, replay_wins: wins, replay_losses: losses, score_verified: verified,
    status: !verified ? 'incomplete' : /complete|finish|claim|reward|end/i.test(run.current_module ?? '')
      ? 'completed' : /draft|play|match|active/i.test(run.current_module ?? '') ? 'in_progress' : 'incomplete' };
}

/** Preserve verified published relationships, then add only independently
 * verified local members. Presentation never grants capture/account ownership. */
export function mergeDraftDisplayRuns(courses, captures, ownership) {
  const byCourse = new Map(courses.map(course => [course.run_id, course]));
  const mergedCaptures = captures.map(capture => {
    if (capture.binding !== 'matched_pool' || capture.binding_account_status !== 'matched'
      || !validAccountKey(capture.account_key)) return capture;
    const course = byCourse.get(capture.bound_run_id);
    if (!course || course.event_id !== capture.event_id || course.account_key !== capture.account_key
      || !course.card_pool.length || poolKey(course.card_pool) !== poolKey(capture.card_pool)) return capture;
    const added = course.matches.filter(match => match.binding_evidence === 'course_context_and_main_deck'
      && match.account_key === capture.account_key && ownership.get(match.id) === capture.account_key
      && !capture.matches.some(previous => previous.id === match.id));
    if (!added.length) return capture;
    const matches = [...capture.matches, ...added].sort((a, b) =>
      Date.parse(a.started_at) - Date.parse(b.started_at) || a.id.localeCompare(b.id));
    return withMatches({ ...capture, current_module: course.current_module ?? capture.current_module,
      course_wins: course.course_wins ?? capture.course_wins,
      course_losses: course.course_losses ?? capture.course_losses }, matches);
  });
  const represented = new Set(mergedCaptures.filter(capture => capture.binding === 'matched_pool'
    && capture.binding_account_status === 'matched' && validAccountKey(capture.account_key))
    .flatMap(capture => capture.matches.filter(match => ownership.get(match.id) === capture.account_key)
      .map(match => `${capture.account_key}:${match.id}`)));
  const remainder = courses.flatMap(course => {
    // Split display-only course groups by actual ownership; never expose mixed
    // members under "unassigned" or overwrite an observed capture's account.
    const groups = new Map();
    for (const match of course.matches) {
      const account = ownership.get(match.id);
      const key = validAccountKey(account) ? account : null;
      if (represented.has(`${key}:${match.id}`)) continue;
      const matches = groups.get(key) ?? []; matches.push(match); groups.set(key, matches);
    }
    return [...groups].map(([account_key, matches]) => withMatches({
      ...course, account_key, picks: course.picks ?? [],
      ...(groups.size > 1 ? { run_id: createHash('sha256').update(`draft-display/1\0${course.run_id}\0${account_key ?? 'unassigned'}`).digest('hex').slice(0, 32) } : {}),
    }, matches));
  });
  return [...remainder, ...mergedCaptures];
}
