import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPValue, jointSmoothDiagnostics } from '../src/fitSummaryHelpers.js';
test('summary probabilities have truthful thresholds and reject unavailable or invalid values', () => {
  for (const value of [null, undefined, NaN, Infinity, '0.04', -0.01, 1.01]) assert.equal(formatPValue(value), null);
  assert.equal(formatPValue(0), '<0.001');
  assert.equal(formatPValue(0.0007), '<0.001');
  assert.equal(formatPValue(0.001), '0.001');
  assert.equal(formatPValue(0.0546), '0.055');
  assert.equal(formatPValue(1), '1.000');
});
test('permutation zero uses the actual simulation resolution and retains nonzero discrete probabilities', () => {
  assert.equal(formatPValue(0, { permutations: 400 }), '<0.0025');
  assert.equal(formatPValue(0, { permutations: 1000 }), '<0.001');
  assert.equal(formatPValue(1 / 400, { permutations: 400 }), '0.0025');
  assert.equal(formatPValue(null, { permutations: 400 }), null);
});
test('the joint smooth matches its own basis check, without mixing unrelated terms', () => {
  const other = { term: 's(z)', pValue: 0.7 };
  const smooth = { term: 'te(Year,Age_Mid)', pValue: 0.0003 };
  const basis = { term: smooth.term, pValue: 0.2 };
  assert.deepEqual(jointSmoothDiagnostics({ smoothTests: [other, smooth], basisChecks: [{ term: other.term }, basis] }), { smooth, basis });
  assert.deepEqual(jointSmoothDiagnostics({ smoothTests: [other, { term: 's(w)' }], basisChecks: [basis] }), { smooth: null, basis: null });
  assert.deepEqual(jointSmoothDiagnostics(), { smooth: null, basis: null });
});
