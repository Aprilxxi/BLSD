import test from 'node:test';
import assert from 'node:assert/strict';
import { availableGroupSelection, minimumGroupSummary, clampGroupSettings, assertGroupFitResponse, groupCurveCoordinates, groupCurveOptions, defaultSectionYears } from '../src/groupHelpers.js';
import { normalizedModelSettings } from '../src/resultHelpers.js';

const settings = { method: 'nb-reml', draws: 1000, seed: 123, kAge: 10, kYear: 10, threshold: .005 };
const axis = (count, start = 0) => Array.from({ length: count }, (_, index) => start + index);
const group = (sex, ages, years) => ({ sex, summary: { ages, years, count: ages.length * years.length } });

function fitted(sex, fitId, analysisId = 'analysis-1') {
  return { schemaVersion: '1', fitId, analysisId, meta: { fitted: true, sex, fitId, analysisId },
    grid: { years: [2000], ages: [32.5] },
    input: [{ Year: 2000, Age_Mid: 32.5, Deaths: 1, Pop: 1000, ...(sex === null ? {} : { Sex: sex }) }],
    points: [{ year: 2000, age: 32.5, surface: 3, annual: -1, acceleration: 0, gradient: .1, shift: .1,
      intervals: { surface: [2, 4], annual: [-2, 0], acceleration: [-.1, .1], gradient: [.05, .15], shift: [.05, .15] } }] };
}
const fulfilled = (sex, id) => ({ sex, status: 'fulfilled', fitId: id, result: fitted(sex, id) });
const rejected = sex => ({ sex, status: 'rejected', error: { code: 'INVALID_DATA' } });
const batch = results => ({ schemaVersion: '1', analysisId: 'analysis-1', results });

test('group selection preserves no-Sex, single-label, and arbitrary multiple labels without inventing Both', () => {
  assert.deepEqual(availableGroupSelection([{ Year: 2000 }, { Year: 2001 }]), [null]);
  assert.deepEqual(availableGroupSelection([{ Sex: 'Only' }, { Sex: 'Only' }]), ['Only']);
  assert.deepEqual(availableGroupSelection([{ Sex: '女性' }, { Sex: 'Cohort / B' }, { Sex: '女性' }]), ['女性', 'Cohort / B']);
  assert.deepEqual(availableGroupSelection([group(null, [], []), group('Both', [], [])]), [null, 'Both']);
  assert.deepEqual(availableGroupSelection({ groups: [group('Female', [], []), group('Male', [], [])] }), ['Female', 'Male']);
  assert.deepEqual(availableGroupSelection([]), []);
});

test('shared bases respect the smallest valid domains independently and permit partial failures', () => {
  const groups = [group('wide', axis(13, 30), axis(34, 1990)), group('few ages', axis(5, 60), axis(20, 2000)),
    group('few years', axis(8, 45), axis(7, 2010)), group('invalid', axis(3), axis(3))];
  const summary = minimumGroupSummary(groups);
  assert.deepEqual(summary.ages, axis(5, 60));
  assert.deepEqual(summary.years, axis(7, 2010));
  const clamped = clampGroupSettings(settings, groups);
  assert.equal(clamped.kAge, 4);
  assert.equal(clamped.kYear, 6);
  assert.deepEqual(normalizedModelSettings(clamped, summary), { ...settings, kAge: 4, kYear: 6 });
  assert.equal(settings.kAge, 10, 'Clamping must not mutate the draft.');
  const duplicate = minimumGroupSummary([group('duplicates', [1, 1, 2, 3, 4, 5, NaN], axis(5))]);
  assert.deepEqual(duplicate.ages, [1, 2, 3, 4, 5]);
});

test('all invalid group domains reach per-group API validation and do not become an unrelated settings error', () => {
  const groups = [group(null, axis(3), axis(2)), group('insufficient', axis(2), axis(4))];
  const summary = minimumGroupSummary(groups);
  assert.equal(summary.ages.length, 5);
  assert.equal(summary.years.length, 5);
  const clamped = clampGroupSettings(settings, groups);
  assert.deepEqual(normalizedModelSettings(clamped, summary), { ...settings, kAge: 4, kYear: 4 });
});

test('basis clamping preserves empty and malformed drafts while bounding complete integer values', () => {
  const groups = [group('A', axis(50), axis(50))];
  assert.deepEqual(clampGroupSettings({ ...settings, kAge: '60', kYear: 1 }, groups), { ...settings, kAge: 40, kYear: 4 });
  for (const value of ['', ' ', null, undefined, true, '2e', '1x', Infinity, NaN, 4.5]) {
    const result = clampGroupSettings({ ...settings, kAge: value, kYear: value }, groups);
    assert.equal(result.kAge, value);
    assert.equal(result.kYear, value);
  }
});

test('valid responses retain selected order, independent results, partial failure, and unlabeled identity', () => {
  const success = batch([fulfilled('Group / B', 'fit-B'), rejected('Invalid'), fulfilled('女性', 'fit-F')]);
  assert.equal(assertGroupFitResponse(success, ['Group / B', 'Invalid', '女性']), success);
  assert.notEqual(success.results[0].result, success.results[2].result);
  const unlabeled = batch([fulfilled(null, 'fit-null')]);
  assert.equal(assertGroupFitResponse(unlabeled, [null]), unlabeled);
  const failures = batch([rejected('Male'), rejected('Female')]);
  assert.equal(assertGroupFitResponse(failures, ['Male', 'Female']), failures);
});

test('a wrong group, duplicate fit, malformed fit, or mismatched analysis invalidates the entire response', () => {
  const modifications = [
    payload => { payload.schemaVersion = '2'; },
    payload => { payload.analysisId = ''; },
    payload => { payload.results.reverse(); },
    payload => { payload.results.pop(); },
    payload => { payload.results[1].sex = 'Both'; },
    payload => { payload.results[0].result.meta.sex = 'Female'; },
    payload => { payload.results[0].result.meta.fitId = 'wrong'; },
    payload => { payload.results[0].result.fitId = 'wrong'; },
    payload => { payload.results[0].result.analysisId = 'wrong'; },
    payload => { payload.results[0].result.meta.analysisId = 'wrong'; },
    payload => { payload.results[0].result.input[0].Sex = 'Female'; },
    payload => { payload.results[0].result.points[0].surface = Infinity; },
    payload => { payload.results[1] = fulfilled('Female', 'fit-M'); },
    payload => { payload.results[1] = { sex: 'Female', status: 'rejected', error: {} }; },
    payload => { payload.results[1].status = 'pending'; },
  ];
  for (const modify of modifications) {
    const payload = batch([fulfilled('Male', 'fit-M'), fulfilled('Female', 'fit-F')]);
    modify(payload);
    assert.throws(() => assertGroupFitResponse(payload, ['Male', 'Female']), error => error.code === 'INVALID_GROUP_FIT_RESPONSE');
  }
  assert.throws(() => assertGroupFitResponse(batch([fulfilled(null, 'fit-null')]), ['Both']), /INVALID_GROUP_FIT_RESPONSE/);
  assert.throws(() => assertGroupFitResponse(batch([]), []), /INVALID_GROUP_FIT_RESPONSE/);
  assert.throws(() => assertGroupFitResponse(batch([rejected('A'), rejected('A')]), ['A', 'A']), /INVALID_GROUP_FIT_RESPONSE/);
});

test('all section defaults use the actual five-year sequence while age defaults follow each group alone', () => {
  const result = { grid: { years: [1990, 1991, 2005, 2023], ages: [32.5, 42.5, 52.5, 62.5, 82.5, 92.5] },
    defaults: { sectionYears: [1991], trendAges: [42.5] } };
  assert.deepEqual(groupCurveCoordinates(result, false), { sectionYears: [1990, 2005], trendAges: [32.5, 42.5, 52.5, 62.5, 82.5, 92.5] });
  assert.deepEqual(groupCurveCoordinates(result, true), { sectionYears: [1990, 2005], trendAges: result.grid.ages });
  const unrelated = { grid: { years: [2001, 2002], ages: [7.5, 12.5] }, defaults: { sectionYears: [1990, 2002, 2002], trendAges: [42.5, 12.5] } };
  assert.deepEqual(groupCurveCoordinates(unrelated, true), { sectionYears: [2001], trendAges: [7.5, 12.5] });
  assert.deepEqual(groupCurveCoordinates(unrelated, false), { sectionYears: [2001], trendAges: [7.5, 12.5] });
});

test('curve defaults discard illegal coordinates and retain every permitted age without a count cap', () => {
  const result = { grid: { years: axis(20, 1990), ages: axis(20, 2.5) },
    defaults: { sectionYears: [...axis(20, 1990), 2050], trendAges: [...axis(20, 2.5), NaN] } };
  assert.deepEqual(groupCurveCoordinates(result, true), { sectionYears: [1990, 1995, 2000, 2005], trendAges: axis(20, 2.5) });
  const fallback = { grid: { years: [2005, 2000], ages: [42.5, 32.5] }, ageSections: { years: [2005] }, timeTrends: { ages: [42.5] } };
  assert.deepEqual(groupCurveCoordinates(fallback, true), { sectionYears: [2000, 2005], trendAges: [32.5, 42.5] });
  assert.deepEqual(groupCurveCoordinates({ ...fallback, defaults: { sectionYears: [], trendAges: [Infinity, '32.5'] } }, true),
    { sectionYears: [2000, 2005], trendAges: [32.5, 42.5] });
  assert.deepEqual(groupCurveCoordinates(null, true), { sectionYears: [], trendAges: [] });
});

test('time trends default to all observed groups, exclude dense interpolation ages, and ignore old subset presets', () => {
  const observedAges = Array.from({ length: 20 }, (_, index) => 2.5 + index * 5);
  const result = { grid: { years: [2000], ages: [...observedAges, 3.1, 3.7], observedAges },
    defaults: { trendAges: [2.5, 47.5, 97.5] } };
  for (const example of [false, true]) assert.deepEqual(groupCurveCoordinates(result, example).trendAges, observedAges);
  const legacy = { grid: { years: [2000], ages: [7.5, 10, 12.5] },
    input: [{ Age_Mid: 12.5 }, { Age_Mid: 7.5 }, { Age_Mid: 7.5 }] };
  assert.deepEqual(groupCurveCoordinates(legacy).trendAges, [7.5, 12.5]);
});

test('five-year defaults use elapsed calendar years, preserve gaps and reject display-only interpolated years', () => {
  assert.deepEqual(defaultSectionYears(axis(34, 1990)), [1990, 1995, 2000, 2005, 2010, 2015, 2020]);
  assert.deepEqual(defaultSectionYears([2016, 2001, 2002, 2008, 2011, 2016, NaN, '2006']), [2001, 2011, 2016]);
  assert.deepEqual(defaultSectionYears([]), []);
  const result = { grid: { years: axis(81, 1900), observedYears: axis(81, 1900), ages: [32.5] } };
  assert.equal(groupCurveCoordinates(result, true).sectionYears.length, 17, 'Default curves must also have no twelve-curve cap.');
  const observed = { grid: { years: [2000, 2001, 2005, 2010, 2015], observedYears: [2001, 2010, 2015], ages: [32.5] } };
  assert.deepEqual(groupCurveCoordinates(observed, true).sectionYears, [2001]);
});

test('curve options retain every observed coordinate on a full grid without a twelve-curve cap', () => {
  const observedYears = axis(34, 1990), observedAges = axis(20, 2.5);
  const result = { grid: { years: [...observedYears, 1990.5], ages: [...observedAges, 3.1, 3.7], observedYears, observedAges } };
  assert.deepEqual(groupCurveOptions(result), { sectionYears: observedYears, trendAges: observedAges });
});

test('reduced-grid curve options exclude observations without retained predictions and interpolation-only coordinates', () => {
  const observedAges = Array.from({ length: 201 }, (_, index) => index / 10);
  const result = { grid: {
    years: [2000, 2001.5, 2005, 2010], observedYears: [2000, 2001, 2005, 2010],
    ages: [0, 0.20202020202020202, 4, 8, 12, 16, 20], observedAges,
  } };
  const original = structuredClone(result);
  const options = groupCurveOptions(result);
  assert.deepEqual(options, { sectionYears: [2000, 2005, 2010], trendAges: [0, 4, 8, 12, 16, 20] });
  assert.equal(options.trendAges.includes(0.1), false, 'The previously selectable age has no retained fitted curve.');
  const selected = groupCurveCoordinates(result);
  for (const key of ['sectionYears', 'trendAges']) {
    assert.ok(selected[key].every(value => options[key].includes(value)), 'Existing defaults remain available.');
  }
  assert.deepEqual(result, original, 'Offering curve choices must not change retained results.');
});

test('curve options follow each group independently and support legacy results', () => {
  const male = { grid: { years: [2000, 2005], ages: [32.5, 35, 37.5] },
    input: [{ Year: 2000, Age_Mid: 32.5 }, { Year: 2005, Age_Mid: 37.5 }] };
  const female = { grid: { years: [2010, 2015], ages: [42.5, 45, 47.5],
    observedYears: [2010, 2015], observedAges: [42.5, 47.5] } };
  assert.deepEqual(groupCurveOptions(male), { sectionYears: [2000, 2005], trendAges: [32.5, 37.5] });
  assert.deepEqual(groupCurveOptions(female), { sectionYears: [2010, 2015], trendAges: [42.5, 47.5] });
  assert.deepEqual(groupCurveOptions({ grid: { years: [2005, 2000], ages: [37.5, 32.5] } }),
    { sectionYears: [2000, 2005], trendAges: [32.5, 37.5] });
  assert.deepEqual(groupCurveOptions(null), { sectionYears: [], trendAges: [] });
});
