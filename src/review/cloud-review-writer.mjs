import { createHash } from 'node:crypto';
import { validateCloudReviewBinding, reviewPath } from './cloud-review.mjs';
import { reviewReject } from './cloud-review-contract.mjs';
import { validateBundleFiles } from '../sync-security.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
/** Capability-limited Agent boundary. There is no default network writer.
 * The adapter must atomically compare expectedHeadOid and create exactly this
 * one-file commit, using a GitHub noreply author AND committer identity. */
export function prepareCloudReviewWrite({ repository, branch, expectedHeadOid, expectedBlobOid = null, report, source }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/.test(branch ?? '') || branch.includes('..') || branch.endsWith('/') ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedHeadOid ?? '') || source?.revision !== expectedHeadOid ||
      (expectedBlobOid !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedBlobOid))) reviewReject('write-target');
  const verified = validateCloudReviewBinding(report, source);
  if (verified.status !== 'ready' || report.provenance.source_revision !== expectedHeadOid) reviewReject('write-source-stale');
  const path = reviewPath(report.match_id, report.game_number), contents = `${JSON.stringify(report, null, 2)}\n`;
  validateBundleFiles(new Map([[path, contents]]));
  return Object.freeze({ repository, branch, expectedHeadOid, expectedBlobOid, path, contents,
    review_hash: hash(contents), source_content_hash: report.source_content_hash,
    identity: Object.freeze({ name: 'mtga-cloud-review', email: 'mtga-cloud-review@users.noreply.github.com' }),
    message: `Add cloud review ${report.match_id} game ${report.game_number}` });
}

export async function publishCloudReview(input, client) {
  const plan = prepareCloudReviewWrite(input);
  const readTarget = async () => {
    try { return await client.readTarget({ repository: plan.repository, branch: plan.branch, path: plan.path }); }
    catch { reviewReject('write-target-unconfirmed'); }
  };
  const target = await readTarget();
  if (target.repository !== plan.repository || target.visibility !== 'PRIVATE' || target.headOid !== plan.expectedHeadOid ||
      (target.blobOid ?? null) !== plan.expectedBlobOid) reviewReject('write-conflict');
  // A sibling commit based on an older head must be rejected, never rebased or
  // force-pushed automatically. Retrying requires rereading/validating evidence.
  let result;
  try { result = await client.compareAndSwapReview(plan); }
  catch { reviewReject('write-conflict-or-unconfirmed'); }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result?.commitOid ?? '')) reviewReject('write-unconfirmed');
  const receipt = await readTarget();
  if (receipt.visibility !== 'PRIVATE' || receipt.repository !== plan.repository || receipt.headOid !== result.commitOid ||
      typeof receipt.contents !== 'string' || hash(receipt.contents) !== plan.review_hash) reviewReject('write-unconfirmed');
  return { commitOid: result.commitOid, path: plan.path, review_hash: plan.review_hash };
}
