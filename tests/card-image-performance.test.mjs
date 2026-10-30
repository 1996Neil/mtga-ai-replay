import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getCardMetadata, getCardImage } from '../src/card-cache.mjs';

const jpeg = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(40, 1), Buffer.from([255, 217])]);
async function fixture(t, ids, cached = []) {
  const dataDir = await mkdtemp(join(tmpdir(), 'card-image-performance-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'cards'));
  for (const id of ids) {
    const image_source = `https://cards.scryfall.io/normal/front/fixture-${id}.jpg`;
    await writeFile(join(dataDir, 'cards', `${id}.json`), JSON.stringify({
      arena_id: id, source: 'scryfall', cache_schema: 2, rules_schema: 1, name: `Fixture ${id}`,
      image_source, image_cached_source: image_source,
    }));
    if (cached.includes(id)) await writeFile(join(dataDir, 'cards', `${id}.jpg`), jpeg);
  }
  return dataDir;
}
async function beforeDeadline(work, milliseconds = 500) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Cached work waited for network queue')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('cached metadata bypasses four stalled public queries', async t => {
  const dataDir = await fixture(t, [100]);
  let release, started = 0, allStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const active = new Promise(resolve => { allStarted = resolve; });
  const fetchFn = async () => {
    if (++started === 4) allStarted();
    await gate;
    return Response.json({ name: 'Fixture' });
  };
  const slow = [200, 201, 202, 203].map(id => getCardMetadata(id, { dataDir, fetchFn }));
  try {
    await beforeDeadline(active, 2000);
    const metadata = await beforeDeadline(getCardMetadata(100, { dataDir, fetchFn }));
    assert.equal(metadata.arena_id, 100);
    assert.equal(started, 4);
  } finally { release(); await Promise.all(slow); }
});

test('six new images download concurrently while cache hits bypass the full pool', async t => {
  const dataDir = await fixture(t, [100, 200, 201, 202, 203, 204, 205, 206], [100]);
  let release, started = 0, active = 0, peak = 0, allStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const downloadsStarted = new Promise(resolve => { allStarted = resolve; });
  const fetchFn = async url => {
    assert.ok(url.startsWith('https://cards.scryfall.io/'));
    active++; peak = Math.max(peak, active);
    if (++started === 6) allStarted();
    await gate;
    active--;
    return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
  };
  const slow = [200, 201, 202, 203, 204, 205, 206].map(id => getCardImage(id, { dataDir, fetchFn }));
  try {
    await beforeDeadline(downloadsStarted, 2000);
    const image = await beforeDeadline(getCardImage(100, { dataDir, fetchFn }));
    assert.ok(image.data.equals(jpeg));
    assert.equal(started, 6, 'seventh new image stays queued while cached image completes');
  } finally { release(); await Promise.all(slow); }
  assert.equal(started, 7);
  assert.equal(peak, 6);
});
