import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { publicCountResult, completeResultCsv, completeResultZip } from '../server/results-download.mjs';
import { readableResultTables, readableResultCsv, readableResultZip } from '../server/readable-results.mjs';

function unzip(bytes) {
  const files = {}; let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString('utf8');
    const start = offset + 30 + length + extra;
    files[name] = inflateRawSync(bytes.subarray(start, start + size)); offset = start + size;
  }
  return files;
}

function fixture(sex = 'Female') {
  const point = { year: 2000, age: 32.5, rate: 12.345678901234567, surface: 2.513306115209698,
    annual: -0.1234567890123456, acceleration: null, gradient: 1.234567890123456, shift: null,
    intervals: { rate: [10.11111111111111, 14.99999999999999], surface: [2.3, 2.8], annual: [-1.1, 0.9],
      acceleration: null, gradient: [-0.1, 2.8], shift: null },
    raw: { rate: 12.345678901234567, surface: 2.513306115209698, annual: -0.1234567890123456,
      acceleration: 0, gradient: 1.234567890123456, shift: 10.987654321098765 },
    rawIntervals: { rate: [10.11111111111111, 14.99999999999999], surface: [2.3, 2.8], annual: [-1.1, 0.9],
      acceleration: [0, 0], gradient: [-0.1, 2.8], shift: [-90.12345678901234, 88.12345678901234] },
    metricMasks: { rate: false, surface: false, annual: false, acceleration: true, gradient: false, shift: true },
    metricMaskReasons: { acceleration: 'NATURAL_SPLINE_BOUNDARY', shift: 'UNSTABLE_AGE_GRADIENT' },
    metricValidFractions: { rate: 1, surface: 1, annual: 1, acceleration: 1, gradient: 1, shift: 1 },
    masked: true, maskReason: 'UNSTABLE_AGE_GRADIENT', validFraction: 1,
    rawDerivatives: { logAnnual: -0.001235330123456789, logGradient: 0.01227009432109876, logAcceleration: 0,
      intervals: { logAnnual: [-0.011, 0.009], logGradient: [-0.001, 0.028], logAcceleration: [0, 0] } } };
  const observation = { year: 2000, age: 32.5, count: 1.2345678901234567, pop: 10000.111111111111,
    cohort: 1967.5, observedRate: 12.34554174188234, fittedRate: 12.345678901234569,
    fittedCount: 1.234581607544458, logRate: 2.513306115209698,
    intervals: { rate: [10.111111111111112, 14.999999999999991], logRate: [2.3, 2.8] },
    devianceResidual: -0.000012345678901234567, pearsonResidual: -0.000023456789012345678 };
  return { schemaVersion: '1', fitId: 'female-fit', analysisId: 'paired-analysis', points: [point],
    input: [{ Year: 2000, Age_Mid: 32.5, Age_Group: '30-34', Count: observation.count, Pop: observation.pop,
      ...(sex === null ? {} : { Sex: sex }) }], residuals: [observation],
    cohortSmooth: [{ cohort: 1967.5, value: null }, { cohort: 1968, value: 0.1234567890123456 }],
    contours: { surface: [{ level: 2.5, points: [[2000, 32.5], [2001, 33.5]] },
      { level: 2.5, points: [[2000, 35], [2001, 36]] }], annual: [{ level: 0, points: [[2000, 32.5], [2001, 34]] }] },
    ageSections: { years: 2000, points: [{ year: 2000, age: 32.5, rate: point.rate }], observed: [observation] },
    timeTrends: { ages: [32.5], points: [{ year: 2000, age: 32.5, rate: point.rate }], observed: [observation] },
    grid: { years: [2000, 2001], ages: [32.5, 35], observedYears: [2000], observedAges: [32.5] },
    defaults: { sectionYears: 2000, trendAges: 32.5 },
    settings: { method: 'nb-reml', draws: 1000, seed: 123, kAge: 4, kYear: 4, threshold: 0.005 },
    parameters: { formula: "Count ~ te(Year, Age_Mid) + offset(log(Pop))", coefficients: [0.12345678901234567],
      covarianceSource: 'Vc', draws: 1000, seed: 123 },
    diagnostics: { n: 1, converged: true, edf: 3.1234567890123457,
      smoothTests: [{ term: 'te(Year,Age_Mid)', pValue: 0.00012345678901234567 }],
      basisChecks: [{ term: 'te(Year,Age_Mid)', kIndex: 0.9876543210987654, pValue: 0.7654321098765432 }] },
    provenance: { source: 'COUNT_EXPOSURE_CSV', filename: 'fractional.csv',
      ageGroups: [{ midpoint: 32.5, lower: 30, upper: 34 }] },
    meta: { sex, fitId: 'female-fit', analysisId: 'paired-analysis', covarianceSource: 'Vc', rateScale: 100000,
      coefficientDrawAlgorithm: 'JOINT_GAUSSIAN_SYMMETRIC_EIGEN_DECOMPOSITION',
      intervalScope: 'POINTWISE_GAUSSIAN_COEFFICIENT', units: { rate: 'per 100000', surface: 'ln(rate per 100000)',
        annual: '%/year', acceleration: 'log-rate/year^2', gradient: '%/age-year', shift: 'age-years/year',
        logAnnual: 'log-rate/year', logGradient: 'log-rate/age-year' } },
    unexpectedRetainedField: { keepThis: [1.2345678901234567, null, '=literal'] } };
}

const byKey = (result, key, locale) => readableResultTables(result, locale).find(table => table.key === key);

test('catalog has stable fixed schemas, localized labels, primitive typed cells and no source mutation', () => {
  const result = fixture(), original = structuredClone(result);
  const english = readableResultTables(result, 'en'), chinese = readableResultTables(result, 'zh');
  assert.deepEqual(english.map(table => table.key),
    ['input', 'predictions', 'derivatives', 'observations', 'cohort_smooth', 'contours', 'analysis_summary', 'field_dictionary']);
  for (let index = 0; index < english.length; index++) {
    const table = english[index], localized = chinese[index];
    assert.deepEqual(table.columns.map(column => column.key), localized.columns.map(column => column.key));
    assert.notEqual(table.name, localized.name);
    assert.ok(table.name.length <= 31 && localized.name.length <= 31);
    for (const row of table.rows) {
      assert.deepEqual(Object.keys(row), table.columns.map(column => column.key));
      assert.ok(Object.values(row).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value)));
    }
    assert.ok(table.columns.every(column => ['number', 'integer', 'percent', 'text'].includes(column.format)));
  }
  assert.equal(byKey(result, 'predictions').columns.length, 14);
  assert.equal(byKey(result, 'input', 'zh').columns.find(column => column.key === 'count').label, '计数');
  assert.deepEqual(result, original);
});

test('six prediction metrics preserve full precision, independent masks, raw values and raw intervals', () => {
  const result = fixture(), rows = byKey(result, 'predictions').rows;
  assert.deepEqual(rows.map(row => row.metric), ['rate', 'surface', 'annual', 'acceleration', 'gradient', 'shift']);
  const rate = rows.find(row => row.metric === 'rate');
  assert.equal(rate.estimate, result.points[0].rate);
  assert.equal(rate.lower95, result.points[0].intervals.rate[0]);
  assert.equal(rate.masked, false, 'A top-level shift mask must not hide rate.');
  assert.equal(rate.mask_reason, null);
  const acceleration = rows.find(row => row.metric === 'acceleration');
  assert.equal(acceleration.estimate, null); assert.equal(acceleration.lower95, null);
  assert.equal(acceleration.raw_estimate, 0); assert.equal(acceleration.raw_lower95, 0); assert.equal(acceleration.raw_upper95, 0);
  assert.equal(acceleration.masked, true); assert.equal(acceleration.mask_reason, 'NATURAL_SPLINE_BOUNDARY');
  const shift = rows.find(row => row.metric === 'shift');
  assert.equal(shift.raw_estimate, result.points[0].raw.shift);
  assert.equal(shift.raw_lower95, result.points[0].rawIntervals.shift[0]);
  assert.equal(shift.valid_draw_fraction, 1); assert.equal(shift.mask_reason, 'UNSTABLE_AGE_GRADIENT');
  assert.equal(byKey(result, 'predictions').columns.find(column => column.key === 'valid_draw_fraction').format, 'percent');
  assert.equal(rows.find(row => row.metric === 'annual').estimate, -0.1234567890123456, 'Percent values must not be divided or rounded.');
});

test('raw derivatives and independently evaluated observations retain their original centres and UI', () => {
  const result = fixture(), derivatives = byKey(result, 'derivatives').rows;
  assert.deepEqual(derivatives.map(row => row.metric), ['logAnnual', 'logGradient', 'logAcceleration']);
  for (const row of derivatives) {
    assert.equal(row.estimate, result.points[0].rawDerivatives[row.metric]);
    assert.deepEqual([row.lower95, row.upper95], result.points[0].rawDerivatives.intervals[row.metric]);
  }
  const row = byKey(result, 'observations').rows[0];
  assert.equal(row.fitted_rate, result.residuals[0].fittedRate);
  assert.notEqual(row.fitted_rate, result.points[0].rate);
  assert.equal(row.rate_lower95, result.residuals[0].intervals.rate[0]);
  assert.equal(row.fitted_count, result.residuals[0].fittedCount);
  assert.equal(row.pearson_residual, result.residuals[0].pearsonResidual);
  const input = byKey(result, 'input').rows[0];
  assert.equal(input.count, result.input[0].Count); assert.equal(input.pop, result.input[0].Pop);
  assert.deepEqual([input.age_lower, input.age_upper], [30, 34]);
  assert.equal(byKey(result, 'cohort_smooth').rows[0].value, null);
});

test('contour paths retain separate equal-level segments, vertex order and log-scale levels', () => {
  const result = fixture(), rows = byKey(result, 'contours').rows;
  assert.deepEqual(rows.map(row => [row.metric, row.path_id, row.point_order, row.level, row.year, row.age]), [
    ['surface', 1, 1, 2.5, 2000, 32.5], ['surface', 1, 2, 2.5, 2001, 33.5],
    ['surface', 2, 1, 2.5, 2000, 35], ['surface', 2, 2, 2.5, 2001, 36],
    ['annual', 3, 1, 0, 2000, 32.5], ['annual', 3, 2, 0, 2001, 34],
  ]);
  assert.equal(rows[0].unit, 'ln(rate per 100000)');
});

test('missing age bounds and sex stay null; metadata bounds are used only when actually supplied', () => {
  const result = fixture(null);
  delete result.input[0].Age_Group; delete result.provenance.ageGroups;
  let row = byKey(result, 'input').rows[0];
  assert.deepEqual([row.sex, row.age_group, row.age_lower, row.age_upper], [null, null, null, null]);
  assert.ok(byKey(result, 'predictions').rows.every(row => row.sex === null));
  result.provenance.ageGroups = [{ midpoint: 32.5, lower: 30, upper: 34 }];
  row = byKey(result, 'input').rows[0];
  assert.deepEqual([row.age_group, row.age_lower, row.age_upper], ['30–34', 30, 34]);
  result.points[0].metricMaskReasons = [];
  assert.equal(byKey(result, 'predictions').rows.find(row => row.metric === 'rate').mask_reason, null);
  assert.equal(byKey(result, 'predictions').rows.find(row => row.metric === 'shift').mask_reason, 'UNSTABLE_AGE_GRADIENT');
  for (const key of ['raw', 'rawIntervals', 'intervals', 'metricMasks', 'metricValidFractions']) result.points[0][key] = [];
  const rows = byKey(result, 'predictions').rows;
  assert.ok(rows.every(row => Object.values(row).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value))));
  assert.equal(rows.find(row => row.metric === 'shift').raw_estimate, null);
  assert.equal(rows.find(row => row.metric === 'shift').raw_lower95, null);
});

test('ZIP uses focused folders and bilingual guidance while preserving complete JSON, metadata and RDS bytes', () => {
  const result = fixture('Both');
  result.provenance.derivedBoth = { method: 'SUM_MATCHED_COUNTS_AND_EXPOSURE', sourceSexes: ['Male', 'Female'], rows: 1 };
  result.meta.derivedBoth = structuredClone(result.provenance.derivedBoth);
  const original = structuredClone(result), rds = Buffer.from([0, 255, 13, 10, 82, 68, 83]), originalRds = Buffer.from(rds);
  const files = unzip(readableResultZip(result, rds, 'zh'));
  assert.equal(Object.keys(files).length, 13);
  assert.ok(Object.keys(files).every(name => name.startsWith('01_tables/') || name.startsWith('02_analysis/') ||
    name.startsWith('03_reproducibility/') || ['README_zh.txt', 'README_en.txt'].includes(name)));
  assert.deepEqual(JSON.parse(files['03_reproducibility/results.json']), publicCountResult(result));
  assert.deepEqual(files['03_reproducibility/fit.rds'], originalRds); assert.deepEqual(rds, originalRds);
  const metadata = JSON.parse(files['02_analysis/metadata.json']);
  assert.equal(metadata.exportLayout, 'readable-v1'); assert.equal(metadata.locale, 'zh');
  assert.equal(metadata.meta.sex, 'Both'); assert.deepEqual(metadata.provenance.derivedBoth, result.provenance.derivedBoth);
  assert.deepEqual(metadata.parameters, result.parameters); assert.deepEqual(metadata.diagnostics, result.diagnostics);
  assert.deepEqual(metadata.availableCurves, { sectionYears: [2000], trendAges: [32.5] });
  assert.equal(metadata.defaults.sectionYears, 2000, 'Do not rewrite the retained schema.');
  assert.ok(files['README_zh.txt'].toString().includes('95% UI'));
  assert.ok(files['README_en.txt'].toString().includes('future-observation'));
  assert.match(files['README_zh.txt'].toString(), /^BLSD Tool 完整分析归档/);
  assert.match(files['README_en.txt'].toString(), /^BLSD Tool complete analysis archive/);
  assert.ok(files['01_tables/input.csv'].toString().startsWith('\uFEFF性别,时期,年龄组,年龄,'));
  assert.ok(!Object.keys(files).some(name => /age_sections|time_trends/.test(name)));
  const summary = byKey(result, 'analysis_summary').rows;
  assert.equal(summary.find(row => row.item === 'defaultSectionYears').value, '[2000]');
  assert.equal(summary.find(row => row.item === 'smoothTests[1].pValue').value, result.diagnostics.smoothTests[0].pValue);
  assert.ok(summary.some(row => row.item === 'workbook' && row.value.includes('every available coordinate')));
  assert.deepEqual(result, original);
});

test('readable CSV is one homogeneous localized table; empty tables keep headers and strings remain inert', () => {
  const result = fixture();
  const csv = readableResultCsv(result, 'en');
  assert.ok(csv.startsWith('\uFEFFSex,Period,Age,Metric,Estimate,95% UI lower,'));
  assert.equal(csv.split('\r\n').length, 7);
  assert.equal(csv.split('\r\n')[0].split(',').length, 14);
  assert.ok(csv.includes(String(result.points[0].rate)));
  const dangerous = fixture('=2+3'); dangerous.provenance.filename = '=literal.csv';
  const files = unzip(readableResultZip(dangerous, Buffer.from('snapshot')));
  assert.ok(files['01_tables/input.csv'].toString().includes("'=2+3"));
  assert.equal(JSON.parse(files['03_reproducibility/results.json']).meta.sex, '=2+3');
  assert.equal(JSON.parse(files['02_analysis/metadata.json']).provenance.filename, '=literal.csv');
  const empty = unzip(readableResultZip({}, Buffer.from('snapshot')));
  assert.equal(empty['01_tables/predictions.csv'].toString().split('\r\n')[0].split(',').length, 14);
  assert.equal(empty['01_tables/contours.csv'].toString().split('\r\n')[0].split(',').length, 8);
  assert.equal(empty['01_tables/input.csv'].toString().split('\r\n').length, 2);
});

test('readable export leaves legacy serialization byte-compatible and accepts legacy count aliases', () => {
  const result = fixture(), legacy = structuredClone(result);
  legacy.input[0].Deaths = legacy.input[0].Count; delete legacy.input[0].Count;
  legacy.residuals[0].deaths = legacy.residuals[0].count; delete legacy.residuals[0].count;
  legacy.residuals[0].fittedDeaths = legacy.residuals[0].fittedCount; delete legacy.residuals[0].fittedCount;
  const rds = Buffer.from('same retained snapshot');
  const oldCsv = completeResultCsv(legacy), oldZip = completeResultZip(legacy, rds), original = structuredClone(legacy);
  readableResultCsv(legacy, 'zh'); readableResultZip(legacy, rds, 'zh');
  assert.equal(completeResultCsv(legacy), oldCsv); assert.deepEqual(completeResultZip(legacy, rds), oldZip);
  assert.deepEqual(legacy, original);
  assert.equal(byKey(legacy, 'input').rows[0].count, result.input[0].Count);
  assert.equal(byKey(legacy, 'observations').rows[0].fitted_count, result.residuals[0].fittedCount);
});

test('available curve coordinates use observed UI choices with scalar, input and sparse-grid fallbacks', () => {
  const result = fixture();
  result.grid = { years: [2004, 2000, 2002, 2002], ages: [52.5, 32.5, 42.5],
    observedYears: 2000, observedAges: 32.5 };
  const metadataOf = () => JSON.parse(unzip(readableResultZip(result, Buffer.from('snapshot')))['02_analysis/metadata.json']);
  assert.deepEqual(metadataOf().availableCurves, { sectionYears: [2000], trendAges: [32.5] });
  delete result.grid.observedYears; delete result.grid.observedAges;
  result.input = [
    { Year: 2004, Age_Mid: 52.5, Count: 1.25, Pop: 100, Sex: 'Female' },
    { Year: 2001, Age_Mid: 37.5, Count: 2.5, Pop: 100, Sex: 'Female' },
    { Year: 2000, Age_Mid: 32.5, Count: 3.75, Pop: 100, Sex: 'Female' },
    { Year: 2004, Age_Mid: 52.5, Count: 5.125, Pop: 100, Sex: 'Female' },
  ];
  const expected = { sectionYears: [2000, 2004], trendAges: [32.5, 52.5] };
  assert.deepEqual(metadataOf().availableCurves, expected, 'An observed coordinate missing from a sparse grid is not a selectable curve.');
  const summary = byKey(result, 'analysis_summary').rows;
  assert.deepEqual(JSON.parse(summary.find(row => row.item === 'availableSectionYears').value), expected.sectionYears);
  assert.deepEqual(JSON.parse(summary.find(row => row.item === 'availableTrendAges').value), expected.trendAges);
  result.input = [];
  assert.deepEqual(metadataOf().availableCurves, { sectionYears: [2000, 2002, 2004], trendAges: [32.5, 42.5, 52.5] });
  assert.equal(byKey(result, 'input', 'zh').columns.find(column => column.key === 'pop').label, '人口或暴露量');
  assert.ok(byKey(result, 'observations', 'en').columns.find(column => column.key === 'fitted_rate').label.includes('per 100,000'));
  assert.ok(byKey(result, 'observations', 'zh').columns.find(column => column.key === 'observed_rate').label.includes('每10万人'));
  assert.ok(byKey(result, 'analysis_summary', 'zh').rows.some(row => row.item === 'annual: 年变化率'));
});
