#!/usr/bin/env node
/**
 * Sync src/card-names/ from the public names-only release.
 *
 * Source of truth: https://github.com/1996Neil/mtga-card-names
 *
 * Usage:
 *   node tools/sync-card-names.mjs --check
 *   node tools/sync-card-names.mjs --apply
 *   node tools/sync-card-names.mjs --input /path/to/cards.jsonl.gz --apply
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const DIR = new URL('../src/card-names/', import.meta.url);
const sha256 = data => createHash('sha256').update(data).digest('hex');

async function releasePin() {
  return JSON.parse(await readFile(new URL('RELEASE.json', DIR), 'utf8'));
}

function chineseRows(gz) {
  const rows = gunzipSync(gz).toString('utf8').split('\n');
  let count = 0;
  for (const line of rows) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (typeof row.zh === 'string' && row.zh) count += 1;
  }
  return count;
}

function verifyLocal(gz, manifestBytes, pin) {
  const problems = [];
  if (sha256(gz) !== pin.cards_jsonl_gz_sha256) problems.push('cards.jsonl.gz sha256 mismatch');
  if (sha256(manifestBytes) !== pin.manifest_sha256) problems.push('manifest.json sha256 mismatch');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema !== 'MTGA_CARD_NAMES_V1') problems.push('unexpected manifest schema');
  if (manifest.data_version !== pin.data_version) problems.push('manifest data_version mismatch');
  const files = manifest.files ?? {};
  if (files['cards.jsonl.gz']?.sha256 !== pin.cards_jsonl_gz_sha256) problems.push('manifest gz sha256 mismatch');
  if (files['cards.jsonl']?.sha256 !== pin.cards_jsonl_sha256) problems.push('manifest jsonl sha256 mismatch');
  const rows = chineseRows(gz);
  if (rows !== pin.rows) problems.push(`Chinese rows ${rows} != ${pin.rows}`);
  if (problems.length) throw new Error(problems.join('; '));
  return { data_version: pin.data_version, rows };
}

async function download(url, expected) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (sha256(data) !== expected) throw new Error(`sha256 mismatch for ${url}`);
      return data;
    } catch (error) {
      last = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw last;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const inputIndex = process.argv.indexOf('--input');
  const manifestIndex = process.argv.indexOf('--manifest');
  const pin = await releasePin();
  const base = `https://github.com/${pin.package}/releases/download/${pin.release}`;

  if (!process.argv.includes('--check') && !apply) {
    throw new Error('pass --check or --apply (and optional --input <cards.jsonl.gz>)');
  }

  let gz, manifestBytes;
  if (inputIndex >= 0) {
    const path = process.argv[inputIndex + 1];
    if (!path) throw new Error('--input requires a path');
    gz = await readFile(path);
    const localManifest = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : null;
    if (manifestIndex >= 0 && !localManifest) throw new Error('--manifest requires a path');
    manifestBytes = localManifest ? await readFile(localManifest) : await readFile(new URL('manifest.json', DIR));
  } else if (apply) {
    manifestBytes = await download(`${base}/manifest.json`, pin.manifest_sha256);
    gz = await download(`${base}/cards.jsonl.gz`, pin.cards_jsonl_gz_sha256);
  } else {
    gz = await readFile(new URL('cards.jsonl.gz', DIR));
    manifestBytes = await readFile(new URL('manifest.json', DIR));
  }

  const result = verifyLocal(gz, manifestBytes, pin);
  if (apply) {
    await writeFile(new URL('manifest.json', DIR), manifestBytes);
    await writeFile(new URL('cards.jsonl.gz', DIR), gz);
  }
  console.log(JSON.stringify({ ...result, release: pin.release, apply }, null, 2));
}

main().catch(error => {
  console.error(`[sync-card-names] ${error.message}`);
  process.exit(1);
});
