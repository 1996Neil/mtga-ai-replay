import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { bundle, harness, reportForSource } from './helpers/cloud-review-fixture.mjs';
import { configureCoachSync, enqueueCoachBundle, syncCoachBundles } from '../src/coach-sync.mjs';
import { fetchCloudReview } from '../src/review/review-sync.mjs';
import { createGitHubReviewWriter } from '../src/review/github-review-writer.mjs';
import { publishCloudReview } from '../src/review/cloud-review-writer.mjs';

const repository = 'fixture-owner/private-coaching';
export async function writerFixture(t) {
  const h = await harness(t), value = await bundle({ richer: true, coachOptions: { multipart: true } });
  await configureCoachSync(repository, h.options); await enqueueCoachBundle(value, h.options); await syncCoachBundles(h.options);
  const { source } = await fetchCloudReview(value.summary.match_id, 1, h.options), report = reportForSource(source);
  const control = { calls: [], visibility: 'private', badIdentity: false, forgedRawIdentity: false, badReceipt: false, extraFile: false, beforeCAS: null, lostCAS: false };
  const execute = (args, { input, env = {} } = {}) => new Promise((yes, no) => {
    const child = execFile('git', ['--git-dir', h.bare, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env }, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => error ? no(Error('Synthetic Git operation failed')) : yes(stdout.trim()));
    child.stdin.on('error', no); child.stdin.end(input);
  });
  const meta = () => ({ id: 17, node_id: 'R_fixture', full_name: repository, private: control.visibility === 'private', visibility: control.visibility, default_branch: 'main' });
  const request = async ({ method, endpoint, body }) => {
    control.calls.push({ method, endpoint, body });
    if (method === 'GET' && endpoint === `repos/${repository}`) return meta();
    if (method === 'GET' && endpoint.includes('/git/commits/')) {
      const oid = endpoint.split('/').at(-1), raw = await execute(['cat-file', 'commit', oid]);
      const [headers, ...message] = raw.split('\n\n');
      const fields = headers.split('\n');
      const person = key => { const match = fields.find(x => x.startsWith(key + ' ')).match(/^[^ ]+ (.+) <([^>]+)>/); return { name: match[1], email: control.badReceipt ? 'different@users.noreply.github.com' : control.forgedRawIdentity ? 'mtga-cloud-review@users.noreply.github.com' : match[2] }; };
      return { sha: oid, tree: { sha: fields.find(x => x.startsWith('tree ')).slice(5) }, parents: fields.filter(x => x.startsWith('parent ')).map(x => ({ sha: x.slice(7) })),
        author: person('author'), committer: person('committer'), message: message.join('\n\n') };
    }
    if (method === 'POST' && endpoint.endsWith('/git/blobs')) return { sha: await execute(['hash-object', '-w', '--stdin'], { input: body.content }) };
    if (method === 'POST' && endpoint.endsWith('/git/trees')) {
      const env = { GIT_INDEX_FILE: join(h.dataDir, 'api-index') };
      await execute(['read-tree', body.base_tree], { env });
      for (const item of body.tree) await execute(['update-index', '--add', '--cacheinfo', `${item.mode},${item.sha},${item.path}`], { env });
      if (control.extraFile) {
        const extra = await execute(['hash-object', '-w', '--stdin'], { input: 'Synthetic unauthorized change\n' });
        await execute(['update-index', '--add', '--cacheinfo', `100644,${extra},README.md`], { env });
      }
      return { sha: await execute(['write-tree'], { env }) };
    }
    if (method === 'POST' && endpoint.endsWith('/git/commits')) {
      const env = { GIT_AUTHOR_NAME: body.author.name, GIT_AUTHOR_EMAIL: body.author.email, GIT_AUTHOR_DATE: body.author.date,
        GIT_COMMITTER_NAME: body.committer.name, GIT_COMMITTER_EMAIL: control.badIdentity ? 'private@example.invalid' : control.forgedRawIdentity ? 'different@users.noreply.github.com' : body.committer.email, GIT_COMMITTER_DATE: body.committer.date };
      return { sha: await execute(['-c', 'commit.gpgsign=false', 'commit-tree', body.tree, ...body.parents.flatMap(oid => ['-p', oid])], { env, input: body.message }) };
    }
    if (method === 'POST' && endpoint === 'graphql') {
      assert.equal(body.variables.input.repositoryId, 'R_fixture');
      const [ref] = body.variables.input.refUpdates;
      assert.equal(ref.force, false); assert.equal(ref.name, 'refs/heads/main');
      await control.beforeCAS?.(ref);
      await execute(['update-ref', ref.name, ref.afterOid, ref.beforeOid]);
      if (control.lostCAS) throw Error('synthetic secret must not escape');
      return { data: { updateRefs: { clientMutationId: null } } };
    }
    throw Error('Unapproved synthetic endpoint');
  };
  const admission = { repository, repositoryId: 17, nodeId: 'R_fixture', branch: 'main', matchId: source.match_id, gameNumber: 1, request, runCommand: h.options.runCommand };
  const input = { repository, branch: 'main', expectedHeadOid: source.revision, expectedBlobOid: null, report, source };
  return { h, source, input, admission, control, execute };
}

test('restricted GitHub adapter verifies explicit identities, one-file tree and true non-force CAS', async t => {
  const { input, admission, control, execute } = await writerFixture(t), before = await execute(['show', 'HEAD:index.json']);
  const result = await publishCloudReview(input, createGitHubReviewWriter(admission));
  assert.equal(await execute(['show', 'HEAD:index.json']), before);
  assert.equal(await execute(['rev-parse', 'HEAD']), result.commitOid);
  const payload = control.calls.find(call => call.endpoint.endsWith('/git/commits') && call.method === 'POST').body;
  assert.equal(payload.author.email, 'mtga-cloud-review@users.noreply.github.com'); assert.deepEqual(payload.author, payload.committer);
  assert.deepEqual(payload.parents, [input.expectedHeadOid]);
  assert.equal(control.calls.filter(call => call.endpoint === 'graphql').length, 1);
});

test('wrong blob, scope, private target or forged plan cannot start a GitHub write', async t => {
  const { input, admission, control } = await writerFixture(t), client = createGitHubReviewWriter(admission);
  await assert.rejects(publishCloudReview({ ...input, expectedBlobOid: 'f'.repeat(40) }, client), /write-conflict/);
  await assert.rejects(client.readTarget({ repository, branch: 'main', path: 'index.json' }), /github-scope/);
  control.visibility = 'public'; await assert.rejects(publishCloudReview(input, client), /write-target-unconfirmed/);
  control.visibility = 'private';
  const { prepareCloudReviewWrite } = await import('../src/review/cloud-review-writer.mjs');
  const plan = prepareCloudReviewWrite(input);
  await assert.rejects(client.compareAndSwapReview({ ...plan, message: 'Unrestricted message' }), /github-plan/);
  assert.equal(control.calls.filter(call => call.method === 'POST').length, 0);
});

test('bad candidate identity, forged commit receipt and extra tree edits fail before CAS', async t => {
  for (const flag of ['badIdentity', 'badReceipt', 'forgedRawIdentity', 'extraFile']) {
    const { input, admission, control, execute } = await writerFixture(t); control[flag] = true;
    await assert.rejects(publishCloudReview(input, createGitHubReviewWriter(admission)), /write-conflict-or-unconfirmed/);
    assert.equal(await execute(['rev-parse', 'HEAD']), input.expectedHeadOid);
    assert.equal(control.calls.filter(call => call.endpoint === 'graphql').length, 0);
  }
});

test('another fetched branch with unsafe history blocks the writer before any API mutation', async t => {
  const { input, admission, control, execute } = await writerFixture(t);
  const tree = await execute(['rev-parse', 'HEAD^{tree}']);
  const oid = await execute(['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', input.expectedHeadOid], { input: 'Synthetic unsafe identity',
    env: { GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'private@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'private@example.invalid' } });
  await execute(['update-ref', 'refs/heads/untrusted-history', oid]);
  await assert.rejects(publishCloudReview(input, createGitHubReviewWriter(admission)), /write-target-unconfirmed/);
  assert.equal(control.calls.filter(call => call.method === 'POST').length, 0);
});

test('a concurrent sibling wins the atomic lease; ambiguous success is never retried or rolled back', async t => {
  const { input, admission, control, execute } = await writerFixture(t);
  control.beforeCAS = async () => {
    const tree = await execute(['rev-parse', 'HEAD^{tree}']);
    const oid = await execute(['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', input.expectedHeadOid], { input: 'Synthetic concurrent writer',
      env: { GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@users.noreply.github.com', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@users.noreply.github.com' } });
    await execute(['update-ref', 'refs/heads/main', oid, input.expectedHeadOid]);
  };
  await assert.rejects(publishCloudReview(input, createGitHubReviewWriter(admission)), /write-conflict-or-unconfirmed/);
  assert.notEqual(await execute(['rev-parse', 'HEAD']), input.expectedHeadOid);
  assert.equal(control.calls.filter(call => call.endpoint === 'graphql').length, 1);
  const next = await writerFixture(t); next.control.lostCAS = true;
  await assert.rejects(publishCloudReview(next.input, createGitHubReviewWriter(next.admission)), /write-conflict-or-unconfirmed/);
  assert.notEqual(await next.execute(['rev-parse', 'HEAD']), next.input.expectedHeadOid);
  assert.equal(next.control.calls.filter(call => call.endpoint === 'graphql').length, 1);
});
