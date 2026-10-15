/** Pure bundle validation and canonical serialization. This operation neither
 * accepts nor invokes filesystem, Git, credential or publication operations.
 * The shared validator also defines Git helpers; a Worker is not a sandbox. */
import {createHash} from 'node:crypto';
import {serializeCoachJson,resolveCoachBundle} from './coach-bundle.mjs';
import {validateBundleFiles} from './sync-security.mjs';
import {CoachSyncError} from './coach-sync-error.mjs';
const NAMES=['summary.json','coach.json','cards.json','manifest.json'];
const SHA=/^[a-f0-9]{64}$/;
const HISTORY_KEY=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PART_PATH=/^matches\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/parts\/part-[0-9]{4,6}\.json$/;
const digest=content=>createHash('sha256').update(content).digest('hex');
function fail(code,message){throw new CoachSyncError(code,message);}
export function bundleFiles(bundle) {
  const files = new Map(NAMES.map(name => [name, serializeCoachJson(bundle[name.slice(0, -5)])]));
  if (!HISTORY_KEY.test(bundle.historyKey ?? '') || !SHA.test(bundle.contentHash ?? '') || bundle.manifest.content_hash !== bundle.contentHash || bundle.summary.match_id !== bundle.manifest.match_id) fail('SYNC_BUNDLE', 'Coach bundle identity is invalid.');
  const parts = bundle.parts instanceof Map ? [...bundle.parts] : Object.entries(bundle.parts ?? {});
  for (const [name, value] of parts) {
    if (PART_PATH.exec(name)?.[1] !== bundle.historyKey) fail('SYNC_BUNDLE', 'Coach object part path is invalid.');
    files.set(name, typeof value === 'string' ? value : serializeCoachJson(value));
  }
  validateBundleFiles(new Map([...files].map(([name, content]) => [NAMES.includes(name) ? `latest/${name}` : name, content])));
  // A secret or machine path must also be rejected if it crosses chunk boundaries.
  // Resolve from the supplied in-memory parts only, then scan the full semantics.
  validateBundleFiles(new Map([['latest/coach.json', serializeCoachJson(resolveCoachBundle(bundle.coach, new Map(parts)))]]));
  const hashedNames = [...files.keys()].filter(name => name !== 'manifest.json');
  if (Object.keys(bundle.manifest.files ?? {}).length !== hashedNames.length) fail('SYNC_BUNDLE', 'Coach manifest does not cover every bundle file.');
  for (const name of hashedNames) {
    if (bundle.manifest.files?.[name]?.sha256 !== digest(files.get(name)) || bundle.manifest.files?.[name]?.bytes !== Buffer.byteLength(files.get(name))) fail('SYNC_BUNDLE', 'Coach bundle integrity check failed.');
  }
  if (digest(serializeCoachJson(bundle.manifest.files)) !== bundle.contentHash) fail('SYNC_BUNDLE', 'Coach bundle content hash is invalid.');
  return files;
}
