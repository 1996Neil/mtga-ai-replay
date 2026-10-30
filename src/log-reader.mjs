import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const isReplayRecord = (obj, text) => Boolean(obj.greToClientEvent || obj.matchGameRoomStateChangedEvent ||
  text.includes('CourseDeckSummary') || text.includes('EventSetDeckV2') ||
  text.includes('\"DraftPack\"') || text.includes('\"PackCards\"') ||
  text.includes('\"PickedCards\"') ||
  ((text.includes('\"PackNumber\"') || text.includes('\"SelfPack\"')) &&
   (text.includes('\"PickNumber\"') || text.includes('\"SelfPick\"')) &&
   (text.includes('\"CardId\"') || text.includes('\"GrpId\"'))));

// Shared framing only; semantic state remains the canonical PerspectiveState.
// An unfinished event stays here between reads and never crosses a file reset.
export function createRecordFramer({ acceptRecord = isReplayRecord, maxRecordCharacters = 16 * 1024 * 1024, snapshot } = {}) {
  if (!Number.isSafeInteger(maxRecordCharacters) || maxRecordCharacters < 2) throw new Error('Invalid JSON framing limit.');
  let buffer = '', depth = 0, quoted = false, escaped = false, markerTail = '', detailed = false, discarding = false, integrityLossCount = 0;
  if (snapshot) {
    ({ buffer, depth, quoted, escaped, markerTail, detailed, discarding, integrityLossCount } = snapshot);
    if (typeof buffer !== 'string' || buffer.length > maxRecordCharacters || !Number.isSafeInteger(depth) || depth < 0)
      throw Error('Invalid framing checkpoint');
  }
  const framer = {
    snapshot: () => ({ buffer, depth, quoted, escaped, markerTail, detailed, discarding, integrityLossCount }),
    get detailed() { return detailed; },
    get pending() { return depth > 0; },
    get bufferedCharacters() { return buffer.length; },
    get integrityLossCount() { return integrityLossCount; },
    reset() { buffer = ''; depth = 0; quoted = false; escaped = false; markerTail = ''; detailed = false; discarding = false; integrityLossCount = 0; },
    // Ordered loss events let a live consumer invalidate old state before it
    // handles a later Diff. The batch feed() API below remains compatible.
    feedEvents(text) {
      const events = [], marker = markerTail + text;
      if (marker.includes('DETAILED LOGS: ENABLED')) detailed = true;
      markerTail = marker.slice(-32);
      for (const c of text) {
        if (depth === 0) {
          if (c !== '{') continue;
          buffer = '{'; depth = 1; continue;
        }
        if (!discarding) buffer += c;
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') depth--;
        if (!discarding && buffer.length > maxRecordCharacters) {
          // Keep only the structural cursor until this oversized outer record
          // ends. Nested fragments must never masquerade as new complete GRE.
          buffer = ''; discarding = true; integrityLossCount++;
          events.push({ type: 'integrity_loss', reason: 'record_limit_exceeded', count: integrityLossCount });
        }
        if (depth === 0) {
          if (!discarding) try {
            const obj = JSON.parse(buffer);
            if (acceptRecord(obj, buffer)) events.push({ type: 'record', record: obj });
          } catch { /* ordinary Unity text may contain braces */ }
          buffer = ''; quoted = false; escaped = false; discarding = false;
        }
      }
      return events;
    },
    feed(text) { return framer.feedEvents(text).filter(event => event.type === 'record').map(event => event.record); },
  };
  return framer;
}

/** Existing batch API, including cross-file deduplication and incomplete tails. */
export async function readRecords(paths) {
  const records = [], seen = new Set(); let detailed = false;
  for (const path of paths) {
    const framer = createRecordFramer(), decoder = new StringDecoder('utf8');
    const collect = values => {
      for (const obj of values) {
        const fingerprint = createHash('sha256').update(JSON.stringify(obj)).digest('hex');
        if (!seen.has(fingerprint)) { seen.add(fingerprint); records.push(obj); }
      }
    };
    for await (const chunk of createReadStream(path)) collect(framer.feed(decoder.write(chunk)));
    collect(framer.feed(decoder.end()));
    detailed ||= framer.detailed;
  }
  return { records, detailed };
}
