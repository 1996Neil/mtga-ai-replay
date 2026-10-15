import test from 'node:test';
import assert from 'node:assert/strict';
import { integrityMessages } from '../src/lib/integrity.ts';
test('integrity warnings have Chinese text, deduplicate, and keep unknown originals inspectable', () => {
  const known='Priority is the last observed GRE value; unrecorded priority windows are unknown.';
  const messages=integrityMessages([known, known, 'future-parser-warning', '中文限制']);
  assert.equal(messages.length,3);assert.ok(messages[0].chinese.includes('优先权'));
  assert.equal(messages[1].translated,false);assert.equal(messages[1].original,'future-parser-warning');
  assert.equal(messages[2].chinese,'中文限制');
});
