import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ageGroupOptions, readoutCoordinateChoices, containingAgeGroup,
  formattedAgeLabel, ageGroupSelectState,
} from '../src/readoutCoordinates.js';
import { nearestResultPoint } from '../src/resultHelpers.js';

const bands = [
  { value: 30.5, label: '30–30', lower: 30, upper: 30 },
  { value: 36, label: '31–40', lower: 31, upper: 40 },
  { value: 43.5, label: '41–45', lower: 41, upper: 45 },
];

test('uses actual non-five-year bands, deduplicates and sorts without inferring widths', () => {
  const provenance = { ageGroups: [
    { lower: 41, upper: 45, midpoint: 43.5 },
    { lower: 30, upper: 30, midpoint: 30.5 },
    { lower: 31, upper: 40, midpoint: 36 },
    { lower: 31, upper: 40, midpoint: 36 },
  ] };
  const original = structuredClone(provenance);
  assert.deepEqual(ageGroupOptions({ provenance }), bands);
  assert.deepEqual(provenance, original);
});

test('filters provenance and fallback rows to the actual selected sex', () => {
  const result = { meta: { sex: 'Male' }, provenance: { sex: 'Female', ageGroups: [
    { lower: 30, upper: 34, midpoint: 32.5, sex: 'Male' },
    { lower: 30, upper: 39, midpoint: 35, sex: 'Female' },
  ] } };
  assert.deepEqual(ageGroupOptions(result), [{ value: 32.5, label: '30–34', lower: 30, upper: 34 }]);
  assert.deepEqual(ageGroupOptions(result, [], 'Female'), [{ value: 35, label: '30–39', lower: 30, upper: 39 }]);
  const rows = [
    { Sex: 'Male', Age_Group: '30-34 years', Age_Mid: 32.5 },
    { Sex: 'Female', Age_Group: '30–39岁', Age_Mid: 35 },
    { Age_Group: '31–40', Age_Mid: 36 },
  ];
  assert.deepEqual(ageGroupOptions({ meta: { sex: 'Female' } }, rows), [{ value: 35, label: '30–39', lower: 30, upper: 39 }]);
  assert.deepEqual(ageGroupOptions(null, rows), [bands[1]]);
});

test('falls back to supplied row labels and never invents legacy numeric bounds', () => {
  const rows = [{ Age_Mid: 32.5 }, { Age_Mid: 37.5 }, { Age_Mid: 42.5 }];
  assert.deepEqual(ageGroupOptions({ grid: { ages: [32.5, 37.5, 42.5] } }, rows), []);
  assert.equal(formattedAgeLabel(32.5, []), '32.5');
  assert.deepEqual(ageGroupOptions(null, [
    { Age_Group: '41-45 years', Age_Mid: 43.5 },
    { Age_Group: '31–40 岁', Age_Mid: 36 },
    { Age_Group: '30–30', Age_Mid: 30.5 },
  ]), bands);
});

test('ignores unusable bounds or inconsistent row midpoint rather than repairing input', () => {
  assert.deepEqual(ageGroupOptions({ provenance: { ageGroups: [
    { lower: -1, upper: 4, midpoint: 2 },
    { lower: 30.5, upper: 34, midpoint: 32.75 },
    { lower: 30, upper: 34, midpoint: 33 },
    { lower: 35, upper: 30, midpoint: 33 },
  ] } }, [{ Age_Group: '30–34', Age_Mid: 33 }]), []);
});

test('range containment uses inclusive lower and exclusive upper-plus-one endpoints', () => {
  assert.equal(containingAgeGroup(29.9999, bands), null);
  assert.equal(containingAgeGroup(30, bands), bands[0]);
  assert.equal(containingAgeGroup(30.9999, bands), bands[0]);
  assert.equal(containingAgeGroup(31, bands), bands[1]);
  assert.equal(containingAgeGroup(40.9999, bands), bands[1]);
  assert.equal(containingAgeGroup(41, bands), bands[2]);
  assert.equal(containingAgeGroup(46, bands), null);
  assert.equal(containingAgeGroup(NaN, bands), null);
  assert.equal(containingAgeGroup(40, [bands[0], bands[2]]), null);
});

test('continuous chart coordinates keep their exact value while displaying a containing band', () => {
  const age = 38.18181818181818;
  const state = ageGroupSelectState(age, bands);
  assert.deepEqual(state, {
    value: age, label: '31–40', continuous: true,
    currentOption: { value: age, label: '31–40' },
  });
  const result = {
    grid: { years: [2000], ages: [36, age, 43.5] },
    points: [{ year: 2000, age: 36 }, { year: 2000, age }, { year: 2000, age: 43.5 }],
  };
  assert.equal(nearestResultPoint(result, 2000, state.value).age, age);
  assert.equal(nearestResultPoint(result, 2000, bands[1].value).age, 36);
  assert.equal(ageGroupSelectState(36, bands).continuous, false);
  assert.equal(ageGroupSelectState(46, bands).label, '46');
});

test('trend labels use ranges only for exact midpoints, never continuous values', () => {
  assert.equal(formattedAgeLabel(36, bands), '31–40');
  assert.equal(formattedAgeLabel(36.00000001, bands, 8), '36.00000001');
  assert.equal(formattedAgeLabel(38.18181818181818, bands), '38.182');
  assert.equal(formattedAgeLabel(43.5, bands), '41–45');
  assert.equal(formattedAgeLabel(Infinity, bands), '—');
});

test('retained Both derivation metadata is preserved alongside age choices', () => {
  const derivedBoth = { sex: 'Both', sourceSexes: ['Male', 'Female'], method: 'SUM_MATCHED_COUNTS_AND_EXPOSURE' };
  const result = { meta: { sex: 'Both', derivedBoth }, provenance: { ageGroups: [
    { lower: 30, upper: 34, midpoint: 32.5 },
  ] } };
  const original = structuredClone(result);
  const choices = readoutCoordinateChoices(result);
  assert.equal(choices.derivedBoth, derivedBoth);
  assert.deepEqual(choices.ageOptions, [{ value: 32.5, label: '30–34', lower: 30, upper: 34 }]);
  assert.deepEqual(result, original);
});
