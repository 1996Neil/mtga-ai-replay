import schema from '../../schemas/MTGA_AI_REVIEW_V1.schema.json' with { type: 'json' };
import schemaV2 from '../../schemas/MTGA_AI_REVIEW_V2.schema.json' with { type: 'json' };

export const CLOUD_REVIEW_POLICY = 'cloud-visible/1';
export const MAX_REVIEW_BYTES = 128 * 1024;
const REVIEW_PATH = /^reviews\/([A-Za-z0-9][A-Za-z0-9_-]{0,119})\/game-([1-9][0-9]{0,2})\.json$/;
export const isReviewSyncPath = path => typeof path === 'string' && REVIEW_PATH.test(path);
export function reviewPath(matchId, gameNumber) {
  const path = `reviews/${matchId}/game-${gameNumber}.json`;
  if (!isReviewSyncPath(path)) reviewReject('identity');
  return path;
}
export function reviewReject(rule) {
  const error = new Error(`Cloud review rejected: ${rule}`);
  error.code = 'MTGA_CLOUD_REVIEW'; error.rule = rule; throw error;
}

// The checked-in Schema is the single structural contract. No remote $ref or
// general schema execution: only this contract's explicit vocabulary is used.
function check(value, rule, depth = 0) {
  if (depth > 16) reviewReject('schema-depth');
  if ('const' in rule && value !== rule.const) reviewReject('schema-const');
  if (rule.enum && !rule.enum.includes(value)) reviewReject('schema-enum');
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reviewReject('schema-object');
    if (rule.required.some(key => !Object.hasOwn(value, key))) reviewReject('schema-required');
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(rule.properties, key)) reviewReject('schema-property');
      check(child, rule.properties[key], depth + 1);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length > rule.maxItems) reviewReject('schema-array');
    if (rule.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) reviewReject('schema-duplicate');
    for (const item of value) check(item, rule.items, depth + 1);
  } else if (rule.type === 'string') {
    if (typeof value !== 'string' || [...value].length < rule.minLength || [...value].length > rule.maxLength || (rule.pattern && !new RegExp(rule.pattern, 'u').test(value))) reviewReject('schema-string');
  } else if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum)) reviewReject('schema-integer');
}

export function validateCloudReviewShape(value, { path } = {}) {
  // Reject unbounded objects before any stringify (including circular values).
  const queue = [[value, 0]]; let nodes = 0, chars = 0;
  while (queue.length) {
    const [item, depth] = queue.pop();
    if (++nodes > 10000 || depth > 16) reviewReject('object-limit');
    if (typeof item === 'string') { chars += item.length; if (chars > MAX_REVIEW_BYTES) reviewReject('size-limit'); }
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { chars += key.length; queue.push([child, depth + 1]); }
  }
  check(value, value?.schema === 'MTGA_AI_REVIEW_V2' ? schemaV2 : schema);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_REVIEW_BYTES) reviewReject('size-limit');
  if (!Number.isFinite(Date.parse(value.generated_at)) || new Date(value.generated_at).toISOString() !== value.generated_at) reviewReject('generated-at');
  if (path && reviewPath(value.match_id, value.game_number) !== path) reviewReject('path-identity');
  return value;
}

// Parse exact UTF-8 bytes. Duplicate members are rejected rather than allowing
// JSON.parse to hide discarded data from structural and credential validation.
export function parseCloudReview(content, options) {
  let text;
  if (typeof content === 'string') text = content;
  else {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); }
    catch { reviewReject('utf8'); }
  }
  if (Buffer.byteLength(text) > MAX_REVIEW_BYTES) reviewReject('size-limit');
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      let next = i + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        let key; try { key = JSON.parse(text.slice(start, i + 1)); } catch { reviewReject('json'); }
        const keys = stack.at(-1);
        if (!(keys instanceof Set) || keys.has(key)) reviewReject('duplicate-key');
        keys.add(key);
      }

    } else if (char === '{') { stack.push(new Set()); }
    else if (char === '[') { stack.push(null); }
    else if (char === '}' || char === ']') { stack.pop(); }
    if (stack.length > 16) reviewReject('schema-depth');
  }
  let value; try { value = JSON.parse(text); } catch { reviewReject('json'); }
  return validateCloudReviewShape(value, options);
}
