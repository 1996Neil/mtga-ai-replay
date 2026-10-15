const value = item => typeof item === 'string' && item.trim() ? item.trim() : null;
const token = item => item?.replace(/[ _-]/g, '').toLowerCase();
const formats = { standard: '标准', alchemy: '炼金', historic: '史迹', explorer: 'Explorer', pioneer: 'Pioneer', timeless: 'Timeless' };

/** Only explicit event/queue identifiers establish a mode. Ladder alone does not
 * establish a format. Missing metadata must never imply Jump In. */
export function describeMatchMode(metadata = {}) {
  const eventId = value(metadata.event_id), event = value(metadata.event), queueId = value(metadata.queue_id);
  const raw = eventId ?? queueId ?? event;
  const normalized = token(raw);
  if (/^jumpin(?:[0-9].*)?$/.test(normalized ?? '') || (!raw && metadata.is_jump_in === true)) {
    return { event_id: eventId, event: 'Jump In', format: null, is_jump_in: true, is_ranked: false, mode_key: 'jump_in' };
  }
  // A queue may add format evidence to a generic Ladder event. It cannot
  // convert an unrelated or missing event into an invented format.
  const ranked = id => /^(?:traditional)?(?:ladder|ranked)$/.test(token(id) ?? '') ||
    /^(?:traditional)?(?:(?:standard|alchemy|historic|explorer|pioneer|timeless)(?:ladder|ranked)|(?:ladder|ranked)(?:standard|alchemy|historic|explorer|pioneer|timeless))$/.test(token(id) ?? '');
  if (ranked(raw)) {
    const candidates = [raw, ...(ranked(queueId) ? [queueId] : [])];
    const format = candidates.map(id => token(id)?.match(/standard|alchemy|historic|explorer|pioneer|timeless/)?.[0]).find(Boolean) ?? null;
    const traditional = candidates.some(id => token(id)?.startsWith('traditional'));
    return { event_id: eventId, event: `${traditional ? '传统' : ''}${format ? formats[format] : ''}排位${format ? '' : '（赛制未知）'}`,
      format, is_jump_in: false, is_ranked: true, mode_key: 'ranked' };
  }
  return { event_id: eventId, event: raw ?? '未知模式', format: null,
    is_jump_in: raw ? false : null, is_ranked: raw ? false : null, mode_key: raw ? 'other' : 'unknown' };
}
