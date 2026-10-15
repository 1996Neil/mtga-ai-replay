import { createHash } from 'node:crypto';

const get = (object, keys) => {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) if (object[key] != null) return object[key];
  return undefined;
};
const entries = value => Array.isArray(value) ? value : [];
const cardId = value => {
  const raw = value && typeof value === 'object' ? get(value, ['CardId','cardId','GrpId','grpId','Id','id']) : value;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
const ids = value => entries(value).map(cardId).filter(Boolean);
const isoTime = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const runId = (eventId, courseId) => hash(eventId + '\0' + courseId);

function walk(object, visit, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 10) return;
  visit(object);
  for (const value of Object.values(object)) if (value && typeof value === 'object') walk(value, visit, depth + 1);
}
function field(object, names) {
  let found;
  walk(object, node => { if (found == null) found = get(node, names); });
  return found;
}
function payloads(record) {
  const result = [];
  walk(record, node => {
    const hasPack = (node.DraftPack != null && node.DraftStatus === 'PickNext') || node.PackCards != null;
    const hasPick = node.CardId != null || node.cardId != null || node.GrpId != null || node.grpId != null || node.PickGrpId != null;
    if (hasPack || hasPick) result.push(node);
  });
  return result;
}

/** Consume only explicit Arena draft packet/pick payloads; never infer a pick from final Course.CardPool. */
export function buildDraftPickIndex(records, { cardNames = new Map() } = {}) {
  const courseRun = new Map();
  for (const record of records) {
    const courses = [...entries(record.Courses), ...(record.Course ? [record.Course] : [])];
    for (const course of courses) {
      if (course?.CourseId == null || typeof course.InternalEventName !== 'string') continue;
      courseRun.set(String(course.CourseId), runId(course.InternalEventName, String(course.CourseId)));
    }
  }
  const byKey = new Map();
  for (const record of records) for (const node of payloads(record)) {
    const explicitCourse = field(node, ['CourseId','courseId']);
    const course = explicitCourse == null ? null : String(explicitCourse);
    const linkedRun = course ? courseRun.get(course) : null;
    // A DraftId alone cannot safely associate picks with a Course or archived match.
    if (!linkedRun) continue;
    const packRaw = get(node, ['SelfPack','Pack','PackNumber']);
    const pickRaw = get(node, ['SelfPick','Pick','PickNumber']);
    const botPayload = node.PackNumber != null || node.PickNumber != null;
    const pack = Number(packRaw), pick = Number(pickRaw);
    const packNumber = Number.isSafeInteger(pack) ? pack + (botPayload ? 1 : 0) : null;
    const pickNumber = Number.isSafeInteger(pick) ? pick + (botPayload ? 1 : 0) : null;
    const candidateRaw = node.DraftPack ?? node.PackCards;
    const candidateIds = Array.isArray(candidateRaw) ? ids(candidateRaw) : [];
    const selected = cardId(get(node, ['CardId','cardId','GrpId','grpId','PickGrpId']));
    if (!candidateIds.length && !selected) continue;
    if (!packNumber || !pickNumber) continue;
    const key = `${linkedRun}:${packNumber}:${pickNumber}`;
    const item = byKey.get(key) ?? { run_id: linkedRun, pack_number: packNumber, pick_number: pickNumber,
      candidate_ids: [], selected_id: null, picked_at: null };
    if (candidateIds.length) item.candidate_ids = [...new Set(candidateIds)];
    if (selected) item.selected_id = selected;
    item.picked_at = item.picked_at ?? isoTime(field(node, ['Timestamp','timestamp','EventTime','eventTime','time']));
    byKey.set(key, item);
  }
  const byRun = new Map();
  for (const item of byKey.values()) {
    const values = byRun.get(item.run_id) ?? [];
    values.push(item); byRun.set(item.run_id, values);
  }
  const output = [];
  for (const values of byRun.values()) {
    values.sort((a,b) => a.pack_number-b.pack_number || a.pick_number-b.pick_number);
    const pool = [];
    let previous = null;
    for (const item of values) {
      const first = !previous;
      const contiguous = first ? item.pack_number === 1 && item.pick_number === 1 :
        (item.pack_number === previous.pack_number && item.pick_number === previous.pick_number + 1) ||
        (item.pack_number === previous.pack_number + 1 && item.pick_number === 1);
      const before = [...pool];
      if (item.selected_id) pool.push(item.selected_id);
      const complete = contiguous && item.candidate_ids.length > 0 && item.selected_id != null &&
        item.candidate_ids.includes(item.selected_id) && item.picked_at != null;
      output.push({ ...item,
        candidates: item.candidate_ids.map(id => ({ arena_id: id, name: cardNames.get(id) ?? `Arena card ${id}` })),
        selected: item.selected_id == null ? null : { arena_id: item.selected_id, name: cardNames.get(item.selected_id) ?? `Arena card ${item.selected_id}` },
        pool_before: before.map(id => ({ arena_id: id, name: cardNames.get(id) ?? `Arena card ${id}` })),
        pool_after: pool.map(id => ({ arena_id: id, name: cardNames.get(id) ?? `Arena card ${id}` })),
        complete, missing: [
          ...(!contiguous ? ['prior_pick'] : []), ...(!item.candidate_ids.length ? ['candidate_pack'] : []),
          ...(item.selected_id == null ? ['selected_card'] : []),
          ...(item.selected_id != null && !item.candidate_ids.includes(item.selected_id) ? ['selection_not_in_pack'] : []),
          ...(!item.picked_at ? ['timestamp'] : []),
        ],
      });
      previous = item;
    }
  }
  return output.sort((a,b) => a.run_id.localeCompare(b.run_id) || a.pack_number-b.pack_number || a.pick_number-b.pick_number);
}
