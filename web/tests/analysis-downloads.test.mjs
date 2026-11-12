import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { publicCountResult, zipFiles } from '../server/results-download.mjs';
import { readableResultFiles, readableResultZip } from '../server/readable-results.mjs';
import { analysisGroupPath, analysisWorkbookZip, analysisResultZip, MAX_ANALYSIS_EXPORT_BYTES } from '../server/analysis-downloads.mjs';

function unzip(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString('utf8');
    const start = offset + 30 + length + extra;
    assert.ok(!files.has(name), `Duplicate ZIP path: ${name}`);
    files.set(name, inflateRawSync(bytes.subarray(start, start + size))); offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  return files;
}

function entry(sex, index) {
  const fitId = `fit-${index}`, analysisId = 'one-analysis', method = 'nb-reml';
  const rate = index === 1 ? 1.2345678901234567 : 9.876543210987654;
  const result = {
    schemaVersion: '1', fitId, analysisId, meta: { sex, fitId, analysisId, fitted: true },
    settings: { method, seed: 123, draws: 1000, kAge: 4, kYear: 4, threshold: 0.005 },
    input: [{ Year: 2000, Age_Mid: 32.5, Age_Group: '30–34', Count: index + 0.125, Pop: 100.25,
      ...(sex == null ? {} : { Sex: sex }) }],
    grid: { years: [2000], ages: [32.5], observedYears: [2000], observedAges: [32.5] },
    defaults: { sectionYears: 2000, trendAges: 32.5 },
    points: [{ year: 2000, age: 32.5, rate, surface: index + 0.012345678901234567,
      annual: -index / 10, acceleration: null, gradient: index / 20, shift: null,
      intervals: { rate: [rate - 0.1, rate + 0.2], surface: [index, index + 0.2], annual: [-0.5, 0.1],
        acceleration: null, gradient: [-0.1, 0.2], shift: null },
      raw: { rate, surface: index + 0.012345678901234567, annual: -index / 10, acceleration: 0, gradient: index / 20, shift: 1.25 },
      rawIntervals: { rate: [rate - 0.1, rate + 0.2], acceleration: [0, 0], shift: [-1.125, 4.125] },
      metricMasks: { rate: false, surface: false, annual: false, acceleration: true, gradient: false, shift: true },
      metricMaskReasons: { acceleration: 'NATURAL_SPLINE_BOUNDARY', shift: 'UNSTABLE_AGE_GRADIENT' },
      metricValidFractions: { rate: 1, surface: 1, annual: 1, acceleration: 1, gradient: 1, shift: 1 },
      rawDerivatives: { logAnnual: -0.0012345678901234567, logGradient: 0.012345678901234567, logAcceleration: 0,
        intervals: { logAnnual: [-0.01, 0.01], logGradient: [-0.1, 0.1], logAcceleration: [0, 0] } } }],
    residuals: [{ year: 2000, age: 32.5, count: index + 0.125, pop: 100.25,
      observedRate: index + 0.25, fittedRate: rate + Number.EPSILON, fittedCount: index + 0.0123456789012345,
      logRate: index + 0.012345678901234567, devianceResidual: -0.1234567890123456,
      pearsonResidual: -0.2345678901234567, cohort: 1967.5, intervals: { rate: [rate - 0.1, rate + 0.2], logRate: [index, index + 0.2] } }],
    provenance: { filename: `group-${index}.csv`, ageGroups: [{ midpoint: 32.5, lower: 30, upper: 34 }] },
    diagnostics: { n: 1, converged: true, devianceExplained: 0.9876543210987654 },
    parameters: { coefficients: [index + 0.12345678901234567], formula: 'Count ~ te(Year, Age_Mid)', covarianceSource: 'Vc' },
    private_group_marker: `only-group-${index}`,
  };
  return { fitId, analysisId, sex, method, result, rds: Buffer.from([index, 0, 255, 13, 10, 82, 68, 83]) };
}

test('analysis group paths preserve Chinese while removing traversal, separators and controls without name collisions', () => {
  assert.equal(analysisGroupPath({ sex: 'Male' }, 0), '01_Male');
  assert.equal(analysisGroupPath({ sex: 'Female' }, 1), '02_Female');
  assert.equal(analysisGroupPath({ sex: 'Both' }, 2), '03_Both');
  const label = '../女\\../性别\n:*?"<>|\u0000', path = analysisGroupPath({ sex: label }, 3);
  assert.match(path, /^04_/); assert.match(path, /女/); assert.match(path, /性别/);
  assert.doesNotMatch(path, /\.\.|[\\/:*?"<>|\u0000-\u001f\u007f]/);
  assert.notEqual(analysisGroupPath({ sex: 'Male/Female' }, 0), analysisGroupPath({ sex: 'Male\\Female' }, 1));
  assert.ok(Buffer.byteLength(analysisGroupPath({ sex: '𠀀'.repeat(300) }, 0)) <= 255);
  assert.equal(analysisGroupPath({ sex: null }, 0), '01_Unlabelled');
  assert.equal(analysisGroupPath({}, 0), '01_Unlabelled');
  assert.throws(() => analysisGroupPath({ sex: 'Male' }, -1), error => error.code === 'INVALID_ANALYSIS_EXPORT');
});

test('workbook ZIP contains only one typed, unformatted nine-sheet workbook per distinct group', () => {
  const entries = [entry('Male', 1), entry('Female', 2)];
  delete entries[0].rds; delete entries[1].rds;
  const files = unzip(analysisWorkbookZip(entries, 'en'));
  assert.deepEqual([...files.keys()], ['01_Male.xlsx', '02_Female.xlsx']);
  entries.forEach((item, index) => {
    const book = unzip(files.get(index === 0 ? '01_Male.xlsx' : '02_Female.xlsx'));
    assert.equal([...book.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length, 9);
    assert.equal(book.has('xl/styles.xml'), false);
    const rate = book.get('xl/worksheets/sheet3.xml').toString('utf8');
    assert.ok(rate.includes(`<c r="D2" t="n"><v>${item.result.points[0].rate}</v></c>`));
    assert.ok(rate.includes(item.sex));
    assert.doesNotMatch(rate, /<f\b|<c\b[^>]*\ss=|<cols\b|<autoFilter\b|<pane\b/);
    const inputs = book.get('xl/worksheets/sheet2.xml').toString('utf8');
    assert.ok(inputs.includes(`<c r="G2" t="n"><v>${item.result.input[0].Count}</v></c>`));
    assert.ok(!rate.includes(entries[1 - index].sex));
  });
});

test('all-group data archive keeps each JSON/RDS byte-for-byte, independent numeric data and actual group identities', () => {
  const entries = [entry('Male', 1), entry('女/../性别\n', 2)],
    resultsBefore = entries.map(item => structuredClone(item.result)), rdsBefore = entries.map(item => Buffer.from(item.rds));
  const files = unzip(analysisResultZip(entries, 'zh'));
  assert.equal(files.size, 25);
  assert.ok(files.has('README_zh.txt') && files.has('README_en.txt') && files.has('analysis.json'));
  assert.ok(![...files.keys()].some(name => /^\d+_[^/]+\/README_/.test(name)));
  const manifest = JSON.parse(files.get('analysis.json'));
  assert.equal(manifest.analysisId, 'one-analysis'); assert.equal(manifest.scope, 'analysis'); assert.equal(manifest.locale, 'zh');
  entries.forEach((item, index) => {
    const path = analysisGroupPath(item, index);
    assert.deepEqual(manifest.groups[index], { path, sex: item.sex, fitId: item.fitId, method: item.method });
    const individual = readableResultFiles(item.result, item.rds, 'zh');
    for (const [name, data] of Object.entries(individual)) {
      if (name.startsWith('README_')) continue;
      assert.deepEqual(files.get(`${path}/${name}`), Buffer.isBuffer(data) ? data : Buffer.from(data));
    }
    assert.deepEqual(files.get(`${path}/03_reproducibility/fit.rds`), rdsBefore[index]);
    assert.equal(files.get(`${path}/03_reproducibility/results.json`).toString(), JSON.stringify(publicCountResult(item.result)));
    assert.equal(JSON.parse(files.get(`${path}/03_reproducibility/results.json`)).private_group_marker, `only-group-${index + 1}`);
    assert.deepEqual(item.result, resultsBefore[index]); assert.deepEqual(item.rds, rdsBefore[index]);
  });
  assert.ok(files.get('README_zh.txt').toString().includes('全部成功保留的性别组'));
  assert.ok(files.get('README_zh.txt').toString().includes('9张普通数据表'));
  assert.ok(files.get('README_en.txt').toString().includes('do not refit, resample or round'));
  assert.ok(files.get('README_en.txt').toString().includes('95% UI'));
  for (const locale of ['en', 'zh']) assert.match(files.get(`README_${locale}.txt`).toString(), /^BLSD Tool /);
});

test('single unlabelled analysis stays null in JSON and never receives an invented Both identity', () => {
  const item = entry(null, 1), files = unzip(analysisResultZip([item], 'en'));
  assert.deepEqual([...unzip(analysisWorkbookZip([item])).keys()], ['01_Unlabelled.xlsx']);
  const manifest = JSON.parse(files.get('analysis.json'));
  assert.equal(manifest.groups[0].sex, null); assert.equal(manifest.groups[0].path, '01_Unlabelled');
  const retained = JSON.parse(files.get('01_Unlabelled/03_reproducibility/results.json'));
  assert.equal(retained.meta.sex, null); assert.equal(Object.hasOwn(retained.input[0], 'Sex'), false);
});

test('readableResultFiles extraction preserves the single-group ZIP fixture in both languages', () => {
  const result = { schemaVersion: '1', fitId: 'single', analysisId: 'analysis', meta: { sex: null },
    settings: { method: 'nb-reml' }, input: [], points: [] };
  const rds = Buffer.from('legacy retained RDS');
  // Only the bilingual README product name changes. Restoring the previous
  // brand must reproduce the entire previous ZIP, including every table byte.
  const previousBrandBaseline = { en: '037bc032fe3572151e976784a6fc5c9648c62273de15ae17dec208f4db6afd89',
    zh: 'fe46206bcead5a3b965939ef115c791c53705b29d37e9635bd5e2901c4456e41' };
  const baseline = { en: '5a33fdbca29ab8dab130ab0a3f705c2b849903e95d2b52efefab80959abe591d',
    zh: '7a8afb1172f3199bd024ff1f2b3f13eae54fa2b893c900672dcf609e440547f6' };
  for (const locale of ['en', 'zh']) {
    const bytes = readableResultZip(result, rds, locale);
    const files = readableResultFiles(result, rds, locale);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), baseline[locale]);
    assert.deepEqual(bytes, zipFiles(files));
    const previousFiles = Object.fromEntries(Object.entries(files).map(([name, data]) => [name,
      name.startsWith('README_') ? String(data).replace(/^BLSD Tool /, 'BLSD Studio ') : data]));
    assert.equal(createHash('sha256').update(zipFiles(previousFiles)).digest('hex'), previousBrandBaseline[locale]);
    for (const language of ['en', 'zh']) assert.match(String(files[`README_${language}.txt`]), /^BLSD Tool /);
    assert.match(String(files['01_tables/input.csv']), locale === 'zh' ? /^\uFEFF性别,时期,/ : /^\uFEFFSex,Period,/);
    assert.match(String(files['01_tables/observations.csv']), locale === 'zh' ? /近似出生时期/ : /Approximate birth period/);
    assert.equal(files['03_reproducibility/results.json'], JSON.stringify(publicCountResult(result)));
    assert.deepEqual(files['03_reproducibility/fit.rds'], rds);
  }
});

test('invalid or mixed analyses are rejected and aggregate retained payloads enforce the 256 MiB guard', () => {
  assert.throws(() => analysisResultZip([]), error => error.code === 'INVALID_ANALYSIS_EXPORT');
  assert.throws(() => analysisResultZip([{ result: {} }]), error => error.code === 'INVALID_ANALYSIS_EXPORT');
  const first = entry('Male', 1), second = entry('Female', 2);
  second.analysisId = 'another-analysis';
  assert.throws(() => analysisWorkbookZip([first, second]), error => error.code === 'INVALID_ANALYSIS_EXPORT');
  second.analysisId = first.analysisId;
  // Shared storage avoids allocating a separate large snapshot per group.
  const large = Buffer.alloc(MAX_ANALYSIS_EXPORT_BYTES / 2);
  first.rds = large; second.rds = large;
  assert.throws(() => analysisResultZip([first, second]), error => error.code === 'EXPORT_TOO_LARGE' && /256 MiB/.test(error.message));
});
