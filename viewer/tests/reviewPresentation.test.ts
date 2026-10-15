import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPresentation } from '../src/replay/reviewPresentation.ts';

test('critical low-confidence suggestion retains importance without asserting a certain error', () => {
  const value = reviewPresentation({ importance: 'critical', assessment: 'possible_error', severity: 'tip', confidence: 'low' });
  assert.equal(value.tone, 'critical'); assert.equal(value.label, '关键决策');
  assert.equal(value.confidence, '较低'); assert.equal(value.judgment, '建议核查');
  assert.ok(!/错误|已证实/.test(value.accessible));
  const high = reviewPresentation({ importance: 'critical', assessment: 'possible_error', severity: 'tip', confidence: 'high' });
  assert.equal(high.tone, value.tone); assert.equal(high.rank, value.rank); assert.equal(high.judgment, value.judgment);
});
test('V1 labels are conservatively adapted and positive judgment does not erase importance', () => {
  assert.equal(reviewPresentation({ severity: 'critical', confidence: 'medium' }).judgment, '建议核查');
  const value = reviewPresentation({ importance: 'critical', assessment: 'positive', severity: 'positive', confidence: 'low' });
  assert.equal(value.rank, 0); assert.equal(value.label, '关键决策'); assert.equal(value.judgment, '值得保留');
});
