import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlsdServer } from './index.mjs';
import { validateFitRequest, validateGroupFitRequest, validateExportRequest } from './api.mjs';
import { publicCountResult } from './results-download.mjs';
import { inflateRawSync } from 'node:zlib';

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

function tiffProperties(bytes) {
  const order = bytes.subarray(0, 2).toString('ascii');
  assert.ok(order === 'II' || order === 'MM', 'TIFF must declare its byte order.');
  const read16 = offset => order === 'II' ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const read32 = offset => order === 'II' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  assert.equal(read16(2), 42, 'Export must use a valid TIFF signature.');
  const directory = read32(4), tags = new Map();
  for (let index = 0; index < read16(directory); index += 1) {
    const entry = directory + 2 + index * 12, tag = read16(entry), type = read16(entry + 2), count = read32(entry + 4);
    if (![256, 257, 259, 282, 283, 296].includes(tag)) continue;
    assert.equal(count, 1, `TIFF tag ${tag} must have one value.`);
    const offset = type === 5 ? read32(entry + 8) : entry + 8;
    tags.set(tag, type === 3 ? read16(offset) : type === 4 ? read32(offset) :
      type === 5 ? read32(offset) / read32(offset + 4) : NaN);
  }
  return { width: tags.get(256), height: tags.get(257), compression: tags.get(259),
    xResolution: tags.get(282), yResolution: tags.get(283), resolutionUnit: tags.get(296) };
}

function observations(multiplier = 1) {
  return Array.from({ length: 8 }, (_, yi) => Array.from({ length: 9 }, (_, ai) => {
    const Year = 2000 + yi, Age_Mid = 30 + ai * 5, Pop = 180000 + ai * 7000;
    const rate = Math.exp(-8 + 0.065 * (Age_Mid - 30) - 0.02 * yi);
    const Deaths = Math.round(Pop * rate * (1 + 0.11 * Math.sin(yi * 1.8 + ai * 1.2))) * multiplier;
    return { Year, Age_Mid, Deaths, Pop };
  })).flat();
}
const baseSettings = { method: 'quasi-gcv', draws: 100, seed: 123, kAge: 4, kYear: 4, threshold: 0.005 };
const request = () => ({ rows: observations(), settings: { ...baseSettings },
  provenance: { source: 'API_CONTRACT_SIMULATED_COUNTS', simulated: true, seed: 123 } });

function smallObservations(sex = null, multiplier = 1) {
  return Array.from({ length: 5 }, (_, yi) => Array.from({ length: 5 }, (_, ai) => {
    const Year = 2000 + yi, Age_Mid = 30 + ai * 5, Pop = 200000 + ai * 7000;
    const Deaths = Math.round(Pop * Math.exp(-8 + 0.065 * (Age_Mid - 30) - 0.02 * yi)
      * (1 + 0.09 * Math.sin(yi * 1.8 + ai * 1.2))) * multiplier;
    return { Year, Age_Mid, Deaths, Pop, ...(sex === null ? {} : { Sex: sex }) };
  })).flat();
}
const groupRequest = (sexes = ['Female', 'Male']) => ({
  rows: sexes.flatMap((sex, index) => smallObservations(sex, index + 1)),
  selectedSexes: sexes, settings: { ...baseSettings },
  provenance: { source: 'API_CONTRACT_SIMULATED_COUNTS', simulated: true },
});

function ageGroupObservations(sex = null, multiplier = 1) {
  return smallObservations(sex, multiplier).map(row => {
    const lower = row.Age_Mid;
    // Different closed groups may share a midpoint across independent sexes.
    const narrow = sex === 'Male';
    return { ...row, Age_Mid: lower + 2.5,
      Age_Group: narrow ? `${lower + 1}–${lower + 3}` : `${lower}–${lower + 4}` };
  });
}

async function withServer(options, operation) {
  const jobRoot = await mkdtemp(path.join(os.tmpdir(), 'blsd-api-test-'));
  const { failSex, captureExportSettings, ...serverOptions } = options;
  if (failSex) {
    // A controlled R failure exercises recovery between two real fits. Zero
    // counts are valid input and must not be assumed to make mgcv fail.
    const adapterPath = path.join(jobRoot, 'fail-one-group.R');
    const realAdapter = fileURLToPath(new URL('./blsd_adapter.R', import.meta.url)).replaceAll('\\', '/');
    await writeFile(adapterPath, `source(${JSON.stringify(realAdapter)})\noriginal_fit <- fit_blsd_web\nfit_blsd_web <- function(request) {\n  if (\"Sex\" %in% names(request$rows) && request$rows$Sex[1] == ${JSON.stringify(failSex)}) blsd_fail(\"FIT_FAILED\", \"Controlled test failure\")\n  original_fit(request)\n}\nblsd_main()\n`);
    serverOptions.adapterPath = adapterPath;
  }
  let exportSettingsPath;
  if (captureExportSettings) {
    exportSettingsPath = path.join(jobRoot, 'captured-export.json');
    const wrapperPath = path.join(jobRoot, 'capture-export.R');
    const realExporter = fileURLToPath(new URL('./blsd_export.R', import.meta.url)).replaceAll('\\', '/');
    await writeFile(wrapperPath, `source(${JSON.stringify(realExporter)})\nrequest <- jsonlite::fromJSON(commandArgs(trailingOnly = TRUE)[2])\njsonlite::write_json(request, ${JSON.stringify(exportSettingsPath.replaceAll('\\', '/'))}, auto_unbox = TRUE, null = "null")\nblsd_export_main()\n`);
    serverOptions.exporterPath = wrapperPath;
  }
  const server = createBlsdServer({ ...serverOptions, jobRoot, gridOptions: { maxAgePoints: 15, maxYearPoints: 8 } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await operation(base, { exportSettingsPath }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(jobRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(jobRoot).startsWith('blsd-api-test-'));
    // The server's close hook also removes retained job directories. Windows
    // can briefly lock a directory while those asynchronous removals finish.
    await rm(jobRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const post = (base, endpoint, body) => fetch(`${base}${endpoint}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
function attachmentFilename(response) {
  const header = response.headers.get('content-disposition');
  assert.ok(header && !/[\r\n]/.test(header));
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  assert.ok(encoded, 'Downloads must provide a UTF-8 filename alongside the ASCII fallback.');
  const filename = decodeURIComponent(encoded[1]);
  assert.ok(!/[\/\\\r\n]/.test(filename), 'A sex label must never become a path or header injection.');
  return filename;
}

test('server validation rejects duplicates, malformed data and unknown fitting methods', () => {
  const duplicate = request(); duplicate.rows.push(duplicate.rows[0]);
  assert.throws(() => validateFitRequest(duplicate), error => error.code === 'DUPLICATE_YEAR_AGE');
  const invalid = request(); invalid.rows[0].Pop = 0;
  assert.throws(() => validateFitRequest(invalid), error => error.code === 'INVALID_DATA');
  const invalidMethod = request(); invalidMethod.settings.method = 'binomial';
  assert.throws(() => validateFitRequest(invalidMethod), error => error.code === 'INVALID_SETTINGS');
  const adjusted = request(); adjusted.settings.kAge = 10; adjusted.settings.kYear = 10;
  const result = validateFitRequest(adjusted);
  assert.equal(result.settings.kAge, 8); assert.equal(result.settings.kYear, 7);
  const sex = request(); sex.rows = sex.rows.map(row => ({ ...row, Sex: 'Female' }));
  assert.ok(validateFitRequest(sex).rows.every(row => row.Sex === 'Female'));
  sex.rows[0].Sex = 'Male';
  assert.throws(() => validateFitRequest(sex), error => error.code === 'MIXED_SEX_GROUPS');
});

test('Count and count input preserve legacy counts and reject conflicts without falling back', () => {
  const original = request(), expected = validateFitRequest(original);
  for (const name of ['Count', 'count']) {
    const body = { ...original, rows: original.rows.map(({ Deaths, ...row }) => ({ ...row, [name]: Deaths })) };
    assert.deepEqual(validateFitRequest(body), expected);
    assert.ok(body.rows.every(row => !Object.hasOwn(row, 'Deaths')), 'Validation does not mutate source input.');
    assert.deepEqual(validateFitRequest({ ...body, rows: body.rows.map((row, index) => ({ ...row, Deaths: original.rows[index].Deaths })) }), expected);
    for (const value of [null, '', '1', NaN, Infinity]) {
      const invalid = { ...body, rows: body.rows.map((row, index) => index ? row : { ...row, [name]: value, Deaths: original.rows[0].Deaths }) };
      assert.throws(() => validateFitRequest(invalid), error => error.code === 'INVALID_DATA');
    }
    const conflict = { ...body, rows: body.rows.map((row, index) => ({ ...row, Deaths: original.rows[index].Deaths + 1 })) };
    assert.throws(() => validateFitRequest(conflict), error => error.code === 'CONFLICTING_COUNT_COLUMNS');
  }
  assert.throws(() => validateFitRequest({ ...original, rows: original.rows.map(row => ({ ...row, Count: row.Deaths, count: row.Deaths })) }),
    error => error.code === 'DUPLICATE_COLUMN');
  const sources = groupRequest(), countSources = { ...sources, rows: sources.rows.map(({ Deaths, ...row }) => ({ ...row, Count: Deaths })) };
  for (const body of [sources, countSources]) body.selectedSexes = ['Both', 'Male', 'Female'];
  assert.deepEqual(validateGroupFitRequest(countSources), validateGroupFitRequest(sources));
  const short = { ...countSources, rows: countSources.rows.filter(row => row.Year < 2004) };
  assert.deepEqual(validateGroupFitRequest(short).map(group => group.error.code), Array(3).fill('INSUFFICIENT_DOMAIN'));
});

test('real R Count input exactly matches legacy fits and exports neutral round-trippable count data', { timeout: 120000 }, async t => {
  await withServer({ requestsPerMinute: 30 }, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    const fit = async body => {
      const response = await post(base, '/api/fit', body), result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const downloadZip = async result => unzip(Buffer.from(await (await fetch(`${base}/api/results/${result.fitId}/download?format=zip`)).arrayBuffer()));
    for (const method of ['quasi-gcv', 'quasi-reml', 'nb-reml']) {
      const body = { rows: smallObservations(), settings: { ...baseSettings, method } };
      const legacy = await fit(body), before = await downloadZip(legacy);
      const counted = await fit({ ...body, rows: body.rows.map(({ Deaths, ...row }) => ({ ...row, Count: Deaths })) });
      const after = await downloadZip(counted);
      for (const field of ['input', 'points', 'residuals', 'ageSections', 'timeTrends', 'parameters', 'diagnostics', 'provenance'])
        assert.deepEqual(counted[field], legacy[field], `${method} ${field} must not change when the count column is relabelled.`);
      assert.deepEqual(after['fit.rds'], before['fit.rds'], `${method} retains exactly the same fitted model and coefficient draws.`);
      assert.match(counted.parameters.formula, /^Count ~/);
      for (const row of counted.residuals) {
        assert.equal(row.count, row.deaths); assert.equal(row.fittedCount, row.fittedDeaths);
      }
      const neutral = JSON.parse(after['results.json']);
      assert.ok(neutral.input.every(row => Object.hasOwn(row, 'Count') && !Object.hasOwn(row, 'Deaths')));
      assert.ok(neutral.residuals.every(row => Object.hasOwn(row, 'count') && !Object.hasOwn(row, 'deaths') && !Object.hasOwn(row, 'fittedDeaths')));
      assert.equal(neutral.diagnostics.nonIntegerCount, false);
      const roundTrip = validateFitRequest({ rows: neutral.input, settings: neutral.settings });
      assert.deepEqual(roundTrip.rows, legacy.input);
      for (const filename of ['standardized_input.csv', 'residuals.csv', 'metadata.json', 'results.json'])
        assert.doesNotMatch(after[filename].toString('utf8'), /Deaths|deaths|fittedDeaths/);
      const json = await (await fetch(`${base}/api/results/${counted.fitId}/download?format=json`)).json();
      assert.deepEqual(json, neutral);
    }
  });
});

test('publication settings preserve display switches and default omitted switches to visible', () => {
  const body = { fitId: '11111111-1111-4111-8111-111111111111', metric: 'surface', format: 'pdf' };
  const defaults = validateExportRequest(body);
  assert.equal(defaults.showContours, true); assert.equal(defaults.showIntervals, true);
  for (const showContours of [false, true]) for (const showIntervals of [false, true]) {
    const validated = validateExportRequest({ ...body, showContours, showIntervals });
    assert.equal(validated.showContours, showContours); assert.equal(validated.showIntervals, showIntervals);
  }
  for (const name of ['showContours', 'showIntervals']) for (const value of [null, 0, 1, 'false', 'true', [], {}]) {
    assert.throws(() => validateExportRequest({ ...body, [name]: value }), error => error.code === 'INVALID_EXPORT_SETTINGS');
  }
});

test('publication settings support PDF, PNG and TIFF at double-column width only', () => {
  const body = { fitId: '11111111-1111-4111-8111-111111111111', metric: 'annual' };
  for (const format of ['pdf', 'png', 'tiff']) {
    const defaults = validateExportRequest({ ...body, format });
    assert.equal(defaults.format, format); assert.equal(defaults.widthMm, 180); assert.equal(defaults.dpi, 600);
    assert.equal(validateExportRequest({ ...body, format, widthMm: 180, dpi: 600 }).widthMm, 180);
    for (const widthMm of [90, 0, 179, 180.5, 181, NaN, Infinity])
      assert.throws(() => validateExportRequest({ ...body, format, widthMm }), error => error.code === 'INVALID_EXPORT_SETTINGS');
  }
  for (const format of ['tif', 'jpeg', 'svg', undefined, null, ['pdf'], {}, 1])
    assert.throws(() => validateExportRequest({ ...body, format }), error => error.code === 'INVALID_EXPORT_SETTINGS');
});

test('publication settings preserve all selected curves without a twelve-coordinate cap', () => {
  const sectionYears = Array.from({ length: 34 }, (_, index) => 1990 + index);
  const trendAges = Array.from({ length: 20 }, (_, index) => 2.5 + index * 5);
  const body = { fitId: '11111111-1111-4111-8111-111111111111', metric: 'timeTrends', format: 'pdf', sectionYears, trendAges };
  assert.deepEqual(validateExportRequest(body).sectionYears, sectionYears);
  assert.deepEqual(validateExportRequest(body).trendAges, trendAges);
  assert.deepEqual(validateExportRequest({ ...body, trendAges: [...trendAges, trendAges[0]] }).trendAges, trendAges);
  for (const value of [[], [NaN], [Infinity], ['32.5'], null]) {
    assert.throws(() => validateExportRequest({ ...body, trendAges: value }), error => error.code === 'INVALID_EXPORT_SETTINGS');
  }
});

test('age groups preserve true bounds, reject midpoint conflicts and isolate sex provenance', () => {
  const rows = ageGroupObservations();
  const validated = validateFitRequest({ rows, settings: baseSettings });
  assert.deepEqual(validated.rows, rows);
  assert.deepEqual(validated.provenance.ageGroups, Array.from({ length: 5 }, (_, index) => ({
    midpoint: 32.5 + index * 5, lower: 30 + index * 5, upper: 34 + index * 5,
  })));
  const ascii = rows.map(row => ({ ...row, Age_Group: ` ${row.Age_Group.replace('–', ' - ')} ` }));
  assert.deepEqual(validateFitRequest({ rows: ascii, settings: baseSettings }).rows, rows);
  for (const Age_Group of ['30+', '30–', '30.5–34', '34–30', null, 30]) {
    const invalidRows = rows.map((row, index) => index === 0 ? { ...row, Age_Group } : row);
    assert.throws(() => validateFitRequest({ rows: invalidRows }), error => error.code === 'INVALID_DATA');
  }
  const mismatched = rows.map((row, index) => index === 0 ? { ...row, Age_Mid: 32 } : row);
  assert.throws(() => validateFitRequest({ rows: mismatched }), error => error.code === 'INVALID_DATA');
  const conflicting = rows.map((row, index) => index === 5 ? { ...row, Age_Group: '31–33' } : row);
  assert.throws(() => validateFitRequest({ rows: conflicting }), error => error.code === 'INVALID_DATA');
  const overlapping = rows.map(row => row.Age_Mid === 37.5 ? { ...row, Age_Group: '33–41' } : row);
  assert.throws(() => validateFitRequest({ rows: overlapping }), error => error.code === 'INVALID_DATA');
  const combined = [...ageGroupObservations('Female'), ...ageGroupObservations('Male', 2)];
  const groups = validateGroupFitRequest({ rows: combined, selectedSexes: ['Female', 'Male'], settings: baseSettings,
    provenance: { ageGroups: [{ midpoint: 32.5, lower: 0, upper: 64 }] } });
  assert.ok(groups.every(group => group.request));
  assert.deepEqual(groups[0].request.provenance.ageGroups[0], { midpoint: 32.5, lower: 30, upper: 34 });
  assert.deepEqual(groups[1].request.provenance.ageGroups[0], { midpoint: 32.5, lower: 31, upper: 33 });
  assert.ok(groups.every(group => group.request.rows.every(row => row.Sex === group.sex)));
  for (const sex of [null, 'Female']) {
    const single = validateGroupFitRequest({ rows: ageGroupObservations(sex), settings: baseSettings });
    assert.equal(single.length, 1); assert.equal(single[0].sex, sex);
    assert.equal(single[0].request.provenance.inputFormat, 'Year,Age_Group,Count,Pop');
    assert.deepEqual(single[0].request.provenance.ageGroups[0], { midpoint: 32.5, lower: 30, upper: 34 });
  }
  const legacyGroups = validateGroupFitRequest({
    rows: [...smallObservations('Female'), ...smallObservations('Male').map(row => ({ ...row, Age_Mid: row.Age_Mid + 40 }))],
    selectedSexes: ['Female', 'Male'], settings: baseSettings,
    provenance: { ageGroups: [{ midpoint: 30, lower: 28, upper: 31 }, { midpoint: 70, lower: 68, upper: 71 }] },
  });
  assert.deepEqual(legacyGroups.map(group => group.request.provenance.ageGroups.map(age => age.midpoint)), [[30], [70]]);
});

test('real R age-group input retains labels in downloads and matches midpoint-only fitting', { timeout: 90000 }, async t => {
  await withServer({ requestsPerMinute: 30 }, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    const sexes = ['Female', 'Male'];
    const rows = sexes.flatMap((sex, index) => ageGroupObservations(sex, index + 1));
    const response = await post(base, '/api/fit-groups', { rows, selectedSexes: sexes, settings: baseSettings,
      provenance: { source: 'API_AGE_GROUP_SIMULATED_COUNTS', ageGroups: [{ midpoint: 32.5, lower: 0, upper: 64 }] } });
    const batch = await response.json();
    assert.equal(response.status, 200, JSON.stringify(batch));
    assert.ok(batch.results.every(group => group.status === 'fulfilled'), JSON.stringify(batch));
    for (const group of batch.results) {
      const expectedInput = rows.filter(row => row.Sex === group.sex);
      assert.deepEqual(group.result.input, expectedInput);
      assert.equal(group.result.provenance.sex, group.sex);
      assert.deepEqual(group.result.provenance.ageGroups[0], group.sex === 'Female' ?
        { midpoint: 32.5, lower: 30, upper: 34 } : { midpoint: 32.5, lower: 31, upper: 33 });
      const json = await (await fetch(`${base}/api/results/${group.fitId}/download?format=json`)).json();
      assert.deepEqual(json, publicCountResult(group.result));
      const zipResponse = await fetch(`${base}/api/results/${group.fitId}/download?format=zip`);
      const zip = unzip(Buffer.from(await zipResponse.arrayBuffer()));
      assert.deepEqual(JSON.parse(zip['provenance.json']), group.result.provenance);
      assert.deepEqual(JSON.parse(zip['results.json']).input, publicCountResult(expectedInput));
      assert.match(zip['standardized_input.csv'].toString('utf8'), /Age_Group/);
      assert.ok(zip['standardized_input.csv'].toString('utf8').includes(expectedInput[0].Age_Group));
    }
    // The labels are an input convenience. Fixed midpoint/count/exposure data
    // and seed must produce the exact same fitted fields and intervals.
    const female = batch.results[0].result;
    const midpointRows = rows.filter(row => row.Sex === 'Female').map(({ Age_Group, ...row }) => row);
    const legacyResponse = await post(base, '/api/fit', { rows: midpointRows, settings: baseSettings });
    const legacy = await legacyResponse.json();
    assert.equal(legacyResponse.status, 200, JSON.stringify(legacy));
    for (const field of ['points', 'residuals', 'ageSections', 'timeTrends', 'parameters', 'diagnostics'])
      assert.deepEqual(female[field], legacy[field], `${field} must not change when only age labels are added.`);
    const unlabelledRows = ageGroupObservations();
    const unlabelledResponse = await post(base, '/api/fit-groups', { rows: unlabelledRows, settings: baseSettings });
    const unlabelled = await unlabelledResponse.json();
    assert.equal(unlabelledResponse.status, 200, JSON.stringify(unlabelled));
    assert.equal(unlabelled.results.length, 1); assert.equal(unlabelled.results[0].sex, null);
    assert.equal(unlabelled.results[0].result.meta.sex, null);
    assert.deepEqual(unlabelled.results[0].result.input, unlabelledRows);
    assert.deepEqual(unlabelled.results[0].result.points, female.points);
  });
});

test('group selection isolates rows and validation failures without mixing or silently fitting unselected sex', () => {
  const body = groupRequest();
  body.selectedSexes = ['Male', 'Female'];
  const groups = validateGroupFitRequest(body);
  assert.deepEqual(groups.map(group => group.sex), ['Male', 'Female']);
  for (const group of groups) {
    assert.equal(group.request.rows.length, 25);
    assert.ok(group.request.rows.every(row => row.Sex === group.sex));
    assert.equal(group.request.provenance.sex, group.sex);
  }
  body.rows.find(row => row.Sex === 'Female').Pop = 0;
  const partial = validateGroupFitRequest(body);
  assert.ok(partial[0].request); assert.equal(partial[1].error.code, 'INVALID_DATA');
  body.selectedSexes = ['Male'];
  assert.equal(validateGroupFitRequest(body).length, 1, 'Unselected invalid groups are not fitted.');
  for (const selectedSexes of [[], ['Unknown'], ['Male', 'Male'], [42]]) {
    assert.throws(() => validateGroupFitRequest({ ...body, selectedSexes }), error => error.code === 'INVALID_GROUP_SELECTION');
  }
  assert.throws(() => validateGroupFitRequest({ ...body, selectedSexes: undefined }), error => error.code === 'INVALID_GROUP_SELECTION');
  assert.throws(() => validateGroupFitRequest({ ...body, settings: { method: 'binomial' } }), error => error.code === 'INVALID_SETTINGS');
  assert.throws(() => validateGroupFitRequest(groupRequest(), 1), error => error.code === 'TOO_MANY_GROUPS');
  for (const sex of [null, 'Female']) {
    const single = validateGroupFitRequest({ rows: smallObservations(sex), settings: baseSettings });
    assert.equal(single.length, 1); assert.equal(single[0].sex, sex); assert.ok(single[0].request);
  }
});

test('Both is derived only from matched count/exposure cells and its provenance is established by the server', () => {
  const female = ageGroupObservations('Female').map(row => ({ ...row, Deaths: row.Deaths * 0.83, Pop: row.Pop * 0.71 }));
  const male = female.map(row => ({ ...row, Sex: 'male', Deaths: row.Deaths * 1.67, Pop: row.Pop * 1.43 }));
  const body = { rows: [...female, ...male], selectedSexes: ['Both', 'male', 'Female'], settings: baseSettings,
    provenance: { source: 'TEST_SOURCE', derivedBoth: { method: 'UNVERIFIED_CLIENT_FLAG' } } };
  const original = structuredClone(body.rows);
  const groups = validateGroupFitRequest(body);
  assert.deepEqual(groups.map(group => group.sex), ['Both', 'male', 'Female']);
  assert.deepEqual(body.rows, original, 'Combining must not mutate either source group.');
  const combined = groups[0].request;
  assert.equal(combined.rows.length, 25);
  for (let index = 0; index < female.length; index++) {
    assert.deepEqual(combined.rows[index], { Year: female[index].Year, Age_Mid: female[index].Age_Mid,
      Age_Group: female[index].Age_Group, Deaths: female[index].Deaths + male[index].Deaths,
      Pop: female[index].Pop + male[index].Pop, Sex: 'Both' });
  }
  assert.deepEqual(combined.provenance.derivedBoth, {
    sex: 'Both', sourceSexes: ['male', 'Female'], rows: 25, method: 'SUM_MATCHED_COUNTS_AND_EXPOSURE',
  });
  assert.deepEqual(combined.provenance.ageGroups[0], { midpoint: 32.5, lower: 30, upper: 34 });
  assert.deepEqual(groups[1].request.rows, male); assert.deepEqual(groups[2].request.rows, female);
  assert.ok(groups.slice(1).every(group => !Object.hasOwn(group.request.provenance, 'derivedBoth')));
  const existingBoth = female.map(row => ({ ...row, Sex: 'bOtH', Deaths: row.Deaths * 4 }));
  const explicit = validateGroupFitRequest({ ...body, rows: [...body.rows, ...existingBoth], selectedSexes: ['bOtH'] });
  assert.deepEqual(explicit[0].request.rows, existingBoth, 'An explicitly supplied Both group takes precedence.');
  assert.ok(!Object.hasOwn(explicit[0].request.provenance, 'derivedBoth'));
  assert.throws(() => validateGroupFitRequest({ ...body, rows: [...body.rows, ...existingBoth], selectedSexes: ['Both'] }),
    error => error.code === 'INVALID_GROUP_SELECTION', 'Existing labels remain actual input labels.');
  assert.throws(() => validateFitRequest({ rows: body.rows, settings: baseSettings }),
    error => error.code === 'DUPLICATE_YEAR_AGE', 'The legacy single-fit endpoint never pools sex rows implicitly.');
});

test('unmatched or invalid sources do not produce Both, while matched short-domain failures remain independent', () => {
  const body = groupRequest();
  const unmatched = body.rows.filter((row, index) => index !== 0);
  const shifted = body.rows.map(row => row.Sex === 'Male' ? { ...row, Year: row.Year + 1 } : row);
  const invalid = body.rows.map((row, index) => index === 0 ? { ...row, Pop: 0 } : row);
  const ambiguous = [...body.rows, ...smallObservations('male')];
  const differentBounds = [...ageGroupObservations('Female'), ...ageGroupObservations('Male')];
  for (const rows of [unmatched, shifted, invalid, ambiguous, differentBounds, smallObservations('Male')]) {
    assert.throws(() => validateGroupFitRequest({ ...body, rows, selectedSexes: ['Both'] }),
      error => error.code === 'INVALID_GROUP_SELECTION', 'Unsafe or incomplete sources cannot masquerade as a combined group.');
  }
  const shortSources = body.rows.filter(row => row.Year < 2004);
  const partial = validateGroupFitRequest({ ...body, rows: [...shortSources, ...smallObservations('Other')],
    selectedSexes: ['Male', 'Female', 'Both', 'Other'] });
  assert.deepEqual(partial.slice(0, 3).map(group => group.error.code), Array(3).fill('INSUFFICIENT_DOMAIN'));
  assert.ok(partial[3].request, 'An unrelated valid selected group must survive all three domain failures.');
  const legacyBounds = ['Female', 'Male'].flatMap(sex => Array.from({ length: 5 }, (_, index) => ({
    sex, midpoint: 30 + index * 5, lower: 28 + index * 5, upper: 31 + index * 5,
  })));
  const legacy = validateGroupFitRequest({ ...body, selectedSexes: ['Both'], provenance: { ageGroups: legacyBounds } });
  assert.deepEqual(legacy[0].request.provenance.ageGroups[0], { midpoint: 30, lower: 28, upper: 31 });
  const conflict = legacyBounds.map(group => group.sex === 'Male' ? { ...group, lower: group.lower - 1 } : group);
  assert.throws(() => validateGroupFitRequest({ ...body, selectedSexes: ['Both'], provenance: { ageGroups: conflict } }),
    error => error.code === 'INVALID_GROUP_SELECTION');
});

test('real R combines matched Male/Female observations and independently retains all three fits', { timeout: 120000 }, async t => {
  await withServer({ requestsPerMinute: 30 }, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    const female = ageGroupObservations('Female').map(row => ({ ...row, Deaths: row.Deaths * 0.83, Pop: row.Pop * 0.71 }));
    const male = female.map(row => ({ ...row, Sex: 'Male', Deaths: row.Deaths * 1.67, Pop: row.Pop * 1.43 }));
    const expectedBoth = female.map((row, index) => ({ ...row, Sex: 'Both', Deaths: row.Deaths + male[index].Deaths,
      Pop: row.Pop + male[index].Pop }));
    const response = await post(base, '/api/fit-groups', { rows: [...female, ...male], selectedSexes: ['Both', 'Male', 'Female'],
      settings: baseSettings, provenance: { source: 'API_COMBINED_SEX_SIMULATED_COUNTS', simulated: true } });
    const batch = await response.json();
    assert.equal(response.status, 200, JSON.stringify(batch));
    assert.deepEqual(batch.results.map(group => [group.sex, group.status]),
      [['Both', 'fulfilled'], ['Male', 'fulfilled'], ['Female', 'fulfilled']]);
    assert.equal(new Set(batch.results.map(group => group.fitId)).size, 3);
    assert.ok(batch.results.every(group => group.result.analysisId === batch.analysisId));
    for (const group of batch.results) {
      const expectedRows = group.sex === 'Both' ? expectedBoth : group.sex === 'Male' ? male : female;
      assert.deepEqual(group.result.input, expectedRows);
      assert.equal(group.result.meta.sex, group.sex);
      if (group.sex === 'Both') {
        const expectedDerivation = { sex: 'Both', sourceSexes: ['Male', 'Female'], rows: 25,
          method: 'SUM_MATCHED_COUNTS_AND_EXPOSURE' };
        assert.deepEqual(group.result.provenance.derivedBoth, expectedDerivation);
        assert.deepEqual(group.result.meta.derivedBoth, expectedDerivation);
      } else {
        assert.ok(!Object.hasOwn(group.result.provenance, 'derivedBoth'));
        assert.ok(!Object.hasOwn(group.result.meta, 'derivedBoth'));
      }
      const downloaded = await fetch(`${base}/api/results/${group.fitId}/download?format=json`);
      assert.equal(downloaded.status, 200);
      assert.deepEqual(await downloaded.json(), publicCountResult(group.result));
      // Independent ordinary fits with the same source/summed observations
      // must reproduce every numerical result, without averaging fitted rates.
      const independent = await post(base, '/api/fit', { rows: expectedRows, settings: baseSettings,
        provenance: { source: 'INDEPENDENT_INPUT', derivedBoth: { method: 'UNVERIFIED_CLIENT_FLAG' } } });
      const fitted = await independent.json();
      assert.equal(independent.status, 200, JSON.stringify(fitted));
      assert.ok(!Object.hasOwn(fitted.meta, 'derivedBoth'), 'A single-fit client metadata flag must not become a server-verified derivation.');
      for (const field of ['points', 'residuals', 'ageSections', 'timeTrends', 'parameters', 'diagnostics'])
        assert.deepEqual(group.result[field], fitted[field], `${group.sex} ${field} must match an independent fit of that group's observations.`);
    }
    const both = batch.results[0];
    const getZip = async () => unzip(Buffer.from(await (await fetch(`${base}/api/results/${both.fitId}/download?format=zip`)).arrayBuffer()));
    const before = await getZip();
    assert.deepEqual(JSON.parse(before['provenance.json']), both.result.provenance);
    assert.deepEqual(JSON.parse(before['results.json']).input, publicCountResult(expectedBoth));
    assert.match(before['standardized_input.csv'].toString('utf8'), /Age_Group/);
    const exported = await post(base, '/api/export', { fitId: both.fitId, metric: 'surface', format: 'pdf',
      showContours: false, showIntervals: false });
    assert.equal(exported.status, 200);
    assert.equal(attachmentFilename(exported), 'BLSD_surface_quasi-gcv_en_Both.pdf');
    assert.equal(Buffer.from(await exported.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.deepEqual((await getZip())['fit.rds'], before['fit.rds'], 'Combined figures must still use the exact retained model and draws.');
  });
});

test('batch HTTP reports per-group R failure and shared request errors safely', async () => {
  await withServer({ rscriptPath: '/definitely-missing-blsd-Rscript' }, async base => {
    const response = await post(base, '/api/fit-groups', groupRequest());
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.fitExpiresAt, null);
    assert.deepEqual(result.results.map(group => [group.sex, group.status, group.error.code]),
      [['Female', 'rejected', 'R_UNAVAILABLE'], ['Male', 'rejected', 'R_UNAVAILABLE']]);
    const invalid = await post(base, '/api/fit-groups', { ...groupRequest(), selectedSexes: ['Unknown'] });
    assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'INVALID_GROUP_SELECTION');
  });
});

test('HTTP rejects invalid input before invoking R and returns safe structured errors', async () => {
  await withServer({ rscriptPath: '/definitely-missing-blsd-Rscript', bodySizeLimit: 4096 }, async base => {
    const duplicate = request(); duplicate.rows = [...duplicate.rows.slice(0, 6), duplicate.rows[0]];
    const response = await post(base, '/api/fit', duplicate);
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'DUPLICATE_YEAR_AGE');
    const malformed = await fetch(`${base}/api/fit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
    const tooLarge = await post(base, '/api/fit', { padding: 'x'.repeat(5000) });
    assert.equal(tooLarge.status, 413); assert.equal((await tooLarge.json()).error.code, 'BODY_TOO_LARGE');
    const unsupported = await post(base, '/api/export', { fitId: 'arbitrary/path', metric: 'surface', format: 'pdf' });
    assert.equal(unsupported.status, 400); assert.equal((await unsupported.json()).error.code, 'INVALID_EXPORT_SETTINGS');
    const invalidSwitch = await post(base, '/api/export', { fitId: '11111111-1111-4111-8111-111111111111',
      metric: 'surface', format: 'pdf', showContours: 'false' });
    assert.equal(invalidSwitch.status, 400); assert.equal((await invalidSwitch.json()).error.code, 'INVALID_EXPORT_SETTINGS');
    const missing = await fetch(`${base}/api/results/11111111-1111-4111-8111-111111111111/download?format=zip`);
    assert.equal(missing.status, 410); assert.equal((await missing.json()).error.code, 'FIT_EXPIRED');
    const invalidDownload = await fetch(`${base}/api/results/not-a-fit/download?format=json`);
    assert.equal(invalidDownload.status, 400);
  });
});

test('HTTP publication exports forward every display-switch combination to the retained R renderer', { timeout: 120000 }, async t => {
  await withServer({ requestsPerMinute: 20, captureExportSettings: true }, async (base, { exportSettingsPath }) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    const fitted = await post(base, '/api/fit', request());
    const result = await fitted.json(); assert.equal(fitted.status, 200, JSON.stringify(result));
    const downloadZip = async () => unzip(Buffer.from(await (await fetch(`${base}/api/results/${result.fitId}/download?format=zip`)).arrayBuffer()));
    const before = await downloadZip();
    for (const showContours of [false, true]) for (const showIntervals of [false, true]) {
      for (const metric of ['surface', 'ageSections']) {
        const settings = { fitId: result.fitId, metric, format: 'pdf', locale: 'en', widthMm: 180, dpi: 600,
          showContours, showIntervals };
        const exported = await post(base, '/api/export', settings);
        assert.equal(exported.status, 200, exported.status === 200 ? metric : JSON.stringify(await exported.json()));
        assert.equal(Buffer.from(await exported.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
        assert.deepEqual(JSON.parse(await readFile(exportSettingsPath, 'utf8')), settings,
          'R must receive explicit false values as well as true values, independently for both switches.');
      }
    }
    const after = await downloadZip();
    assert.deepEqual(after['fit.rds'], before['fit.rds'], 'Display switches cannot change the retained model or coefficient draws.');
    assert.deepEqual(after['results.json'], before['results.json'], 'Display switches cannot change estimates, intervals, masks or metadata.');
  });
});

test('real R publication exports retain all selected observed years and age facets', { timeout: 120000 }, async t => {
  await withServer({ requestsPerMinute: 20, captureExportSettings: true }, async (base, { exportSettingsPath }) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    const sectionYears = Array.from({ length: 34 }, (_, index) => 1990 + index);
    const trendAges = Array.from({ length: 20 }, (_, index) => 2.5 + index * 5);
    const rows = sectionYears.flatMap(Year => trendAges.map(Age_Mid => {
      const Pop = 200000 + Age_Mid * 1000;
      const Deaths = Math.round(Pop * Math.exp(-9 + .06 * Age_Mid - .015 * (Year - 1990)) *
        (1 + .1 * Math.sin((Year - 1990) * 1.8 + Age_Mid * .2)));
      return { Year, Age_Mid, Deaths, Pop };
    }));
    const fitted = await post(base, '/api/fit', { rows, settings: baseSettings });
    const result = await fitted.json(); assert.equal(fitted.status, 200, JSON.stringify(result));
    assert.deepEqual(result.grid.observedYears, sectionYears);
    assert.deepEqual(result.grid.observedAges, trendAges);
    assert.deepEqual(result.defaults.sectionYears, [1990, 1995, 2000, 2005, 2010, 2015, 2020]);
    assert.deepEqual(result.defaults.trendAges, trendAges);
    assert.deepEqual(result.timeTrends.ages, trendAges);
    const download = async () => unzip(Buffer.from(await (await fetch(`${base}/api/results/${result.fitId}/download?format=zip`)).arrayBuffer()));
    const before = await download();
    for (const metric of ['ageSections', 'timeTrends', 'residuals']) {
      const settings = { fitId: result.fitId, metric, format: 'pdf', locale: 'en', widthMm: 180, dpi: 600,
        sectionYears, trendAges, showContours: true, showIntervals: true };
      const response = await post(base, '/api/export', settings);
      assert.equal(response.status, 200, response.status === 200 ? metric : JSON.stringify(await response.json()));
      assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
      assert.deepEqual(JSON.parse(await readFile(exportSettingsPath, 'utf8')), settings, 'R must receive all selected curves.');
    }
    const invalid = await post(base, '/api/export', { fitId: result.fitId, metric: 'ageSections', format: 'pdf', sectionYears: [...sectionYears, 2050] });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_EXPORT_SETTINGS');
    const after = await download();
    assert.deepEqual(after['fit.rds'], before['fit.rds']);
    assert.deepEqual(after['results.json'], before['results.json']);
  });
});

test('real R fitting propagates input data, family, seed, units, masks and publication exports', { timeout: 180000 }, async t => {
  await withServer({ requestsPerMinute: 30 }, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    assert.deepEqual(health.exportFormats, ['pdf', 'png', 'tiff']);
    const fit = async body => {
      const response = await post(base, '/api/fit', body);
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.meta.fitted, true); assert.equal(result.meta.simulationOnly, false);
      assert.equal(result.diagnostics.converged, true); assert.ok(result.fitId);
      const { smoothTests, parametricTests, basisChecks, basisCheckStatus, residualDf, aic } = result.diagnostics;
      assert.equal(smoothTests.length, 1); assert.equal(parametricTests.length, 1); assert.equal(basisChecks.length, 1);
      assert.equal(basisCheckStatus, 'AVAILABLE');
      const smooth = smoothTests[0], parameter = parametricTests[0], basis = basisChecks[0];
      assert.equal(smooth.term, 'te(Year,Age_Mid)'); assert.equal(smooth.approximate, true);
      assert.equal(smooth.statisticType, body.settings.method === 'nb-reml' ? 'Chi-sq' : 'F');
      assert.equal(parameter.term, '(Intercept)');
      assert.equal(parameter.statisticType, body.settings.method === 'nb-reml' ? 'z' : 't');
      assert.equal(basis.term, smooth.term); assert.equal(basis.replicates, 400); assert.equal(basis.seed, 20261015);
      for (const check of [smooth, parameter, basis]) {
        assert.equal(check.status, 'AVAILABLE'); assert.ok(Number.isFinite(check.pValue));
        assert.ok(check.pValue >= 0 && check.pValue <= 1);
      }
      assert.ok(Number.isFinite(basis.kIndex));
      assert.ok(Math.abs(residualDf - (result.diagnostics.n - result.diagnostics.edf)) < 1e-9);
      if (body.settings.method === 'nb-reml') assert.ok(Number.isFinite(aic));
      else assert.equal(aic, null, 'A quasi-likelihood family must not acquire an invented AIC.');
      assert.deepEqual(result.provenance, body.provenance, 'Input provenance must survive fitting and saved result downloads.');
      assert.equal(result.points.length, result.grid.years.length * result.grid.ages.length);
      for (const point of result.points) {
        assert.ok(Number.isFinite(point.surface)); assert.ok(Number.isFinite(point.annual)); assert.ok(Number.isFinite(point.gradient));
        assert.ok(Math.abs(point.annual - 100 * Math.expm1(point.logAnnual)) < 1e-10);
        assert.ok(Math.abs(point.gradient - 100 * Math.expm1(point.logGradient)) < 1e-10);
        if (point.year === result.grid.years[0] || point.year === result.grid.years.at(-1)) {
          assert.equal(point.acceleration, null); assert.equal(point.intervals.acceleration, null);
          assert.equal(point.metricMaskReasons.acceleration, 'NATURAL_SPLINE_BOUNDARY');
        }
        if (point.masked) { assert.equal(point.shift, null); assert.equal(point.intervals.shift, null); }
        else assert.ok(Math.abs(point.shift + point.logAnnual / point.logGradient) < 1e-10);
      }
      return result;
    };
    const gcv = await fit(request());
    assert.equal(gcv.diagnostics.smoothingMethod, 'GCV.Cp'); assert.equal(gcv.diagnostics.covarianceSource, 'Vp');
    assert.equal(gcv.meta.smoothingUncertaintyCorrected, false);
    const repeat = await fit(request());
    assert.deepEqual(repeat.points, gcv.points, 'Fixed seed must reproduce all coefficient-draw intervals.');
    assert.deepEqual(repeat.diagnostics, gcv.diagnostics, 'Permutation diagnostics must also reproduce at their own fixed seed.');
    const changedSeed = request(); changedSeed.settings.seed = 456;
    const alternate = await fit(changedSeed);
    assert.equal(alternate.points[30].surface, gcv.points[30].surface);
    assert.notDeepEqual(alternate.points[30].intervals.surface, gcv.points[30].intervals.surface);
    assert.deepEqual(alternate.diagnostics.smoothTests, gcv.diagnostics.smoothTests);
    assert.deepEqual(alternate.diagnostics.basisChecks, gcv.diagnostics.basisChecks,
      'Changing coefficient-draw seed must not alter the separate diagnostic permutation stream.');
    const changedCounts = request(); changedCounts.rows = observations(2);
    const doubled = await fit(changedCounts);
    assert.ok(Math.abs(doubled.points[30].surface - gcv.points[30].surface - Math.log(2)) < 0.002,
      'Doubling observed counts must double fitted mortality rates rather than reproduce a demo.');
    for (const method of ['quasi-reml', 'nb-reml']) {
      const body = request(); body.settings.method = method;
      const result = await fit(body);
      assert.equal(result.diagnostics.smoothingMethod, 'REML'); assert.equal(result.settings.method, method);
      assert.equal(result.diagnostics.covarianceSource, 'Vc');
      assert.equal(result.meta.smoothingUncertaintyCorrected, true);
      assert.ok(Number.isFinite(result.diagnostics.scale));
    }
    const maskedRequest = request(); maskedRequest.settings.threshold = 1;
    const masked = await fit(maskedRequest);
    assert.ok(masked.points.every(point => point.masked && point.shift === null));
    for (const point of masked.points.filter(p => p.acceleration === null)) {
      assert.equal(point.raw.acceleration, 0); assert.deepEqual(point.rawIntervals.acceleration, [0, 0]);
      assert.equal(point.metricMasks.acceleration, true); assert.equal(point.metricValidFractions.acceleration, 1);
    }
    assert.equal(masked.input.length, maskedRequest.rows.length);
    assert.equal(masked.residuals.length, maskedRequest.rows.length);
    assert.ok(masked.ageSections.points.length > 0 && masked.timeTrends.points.length > 0);
    assert.ok(masked.contours.surface.length > 0 && masked.contours.annual.length > 0);
    assert.ok(masked.grid.ages.includes(35), 'Exact observed age must survive the prediction axis.');
    const get = format => fetch(`${base}/api/results/${masked.fitId}/download?format=${format}`);
    const jsonResponse = await get('json'); assert.equal(jsonResponse.status, 200);
    assert.deepEqual(await jsonResponse.json(), publicCountResult(masked), 'Download only normalizes public count names, with no recomputation.');
    const csvResponse = await get('csv'); assert.equal(csvResponse.status, 200);
    const csv = await csvResponse.text();
    for (const field of ['standardized_input', 'prediction_grid', 'raw.acceleration', 'rawIntervals.acceleration.lower95', 'residuals', 'age_sections', 'time_trends', 'analysis_metadata']) assert.ok(csv.includes(field), field);
    const zipResponse = await get('zip'); assert.equal(zipResponse.status, 200);
    const files = unzip(Buffer.from(await zipResponse.arrayBuffer()));
    assert.deepEqual(JSON.parse(files['results.json']), publicCountResult(masked)); assert.ok(files['fit.rds'].length > 1000);
    assert.ok(files['prediction_grid.csv'].length > 1000);
    for (const metric of ['surface', 'acceleration', 'gradient', 'shift', 'ageSections', 'timeTrends', 'residuals']) {
      const response = await post(base, '/api/export', { fitId: masked.fitId, metric, format: 'pdf', locale: 'en', widthMm: 180, dpi: 600 });
      assert.equal(response.status, 200, response.status === 200 ? metric : JSON.stringify(await response.json()));
      assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    }
    for (const format of ['pdf', 'png', 'tiff']) {
      const response = await post(base, '/api/export', { fitId: masked.fitId, metric: 'annual', format, locale: 'en', widthMm: 180, dpi: 600 });
      if (response.status !== 200) assert.fail(JSON.stringify(await response.json()));
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 1000); assert.match(response.headers.get('content-disposition'), /BLSD_annual_quasi-gcv_en/);
      assert.equal(attachmentFilename(response), `BLSD_annual_quasi-gcv_en.${format}`);
      if (format === 'pdf') {
        assert.equal(response.headers.get('content-type'), 'application/pdf');
        assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
      } else if (format === 'png') {
        assert.equal(response.headers.get('content-type'), 'image/png');
        assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.ok(Math.abs(bytes.readUInt32BE(16) - 180 / 25.4 * 600) < 1, 'PNG must be 180 mm wide at 600 dpi.');
        const physical = bytes.indexOf(Buffer.from('pHYs'));
        assert.ok(physical >= 0); assert.ok(Math.abs(bytes.readUInt32BE(physical + 4) - 600 / 0.0254) < 2);
      } else {
        assert.equal(response.headers.get('content-type'), 'image/tiff');
        const properties = tiffProperties(bytes);
        assert.equal(properties.compression, 5, 'TIFF must use lossless LZW compression.');
        assert.equal(properties.resolutionUnit, 2, 'TIFF resolution is expressed in inches.');
        assert.equal(properties.xResolution, 600); assert.equal(properties.yResolution, 600);
        assert.ok(Math.abs(properties.width - 180 / 25.4 * 600) < 1, 'TIFF must be 180 mm wide at 600 dpi.');
        assert.ok(Math.abs(properties.height - 112 / 25.4 * 600) < 1, 'TIFF must preserve the existing double-column figure height.');
      }
    }
    assert.deepEqual(await (await get('json')).json(), publicCountResult(masked), 'PDF, PNG and TIFF exports cannot mutate the retained result.');
    const secondFiles = unzip(Buffer.from(await (await get('zip')).arrayBuffer()));
    assert.deepEqual(secondFiles['fit.rds'], files['fit.rds'], 'Figures and downloads cannot mutate or replace the model or draws.');
  });
});

test('expired fitId cannot produce a download or publication figure', async t => {
  await withServer({ fitTtlMs: 1 }, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    const fitted = await post(base, '/api/fit', request()); assert.equal(fitted.status, 200);
    const result = await fitted.json();
    await new Promise(resolve => setTimeout(resolve, 10));
    const response = await fetch(`${base}/api/results/${result.fitId}/download?format=json`);
    assert.equal(response.status, 410); assert.equal((await response.json()).error.code, 'FIT_EXPIRED');
    const exported = await post(base, '/api/export', { fitId: result.fitId, metric: 'surface', format: 'pdf' });
    assert.equal(exported.status, 410); assert.equal((await exported.json()).error.code, 'FIT_EXPIRED');
  });
});

test('real R batch keeps more than five independent sex fits as one analysis and isolates failures', { timeout: 180000 }, async t => {
  await withServer({ maxAnalyses: 1, requestsPerMinute: 50, failSex: 'R failure' }, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    const unsafeSex = '男性/../"\r\n\\';
    const sexes = ['Female', 'Male', unsafeSex, 'Group 4', 'Group 5', 'Group 6'];
    const body = groupRequest(sexes);
    body.rows.push(...smallObservations('Invalid').map((row, index) => ({ ...row, ...(index === 0 ? { Pop: 0 } : {}) })),
      ...smallObservations('R failure'), ...smallObservations('Unselected', 10));
    body.selectedSexes = ['Invalid', sexes[0], 'R failure', ...sexes.slice(1)];
    const response = await post(base, '/api/fit-groups', body);
    const batch = await response.json();
    assert.equal(response.status, 200, JSON.stringify(batch));
    assert.deepEqual(batch.results.map(group => group.sex), body.selectedSexes);
    assert.equal(batch.results[0].error.code, 'INVALID_DATA');
    const failed = batch.results.find(group => group.sex === 'R failure');
    assert.equal(failed.status, 'rejected', 'A failed R model cannot suppress the other selected fits.');
    assert.equal(failed.error.code, 'FIT_FAILED');
    const successes = batch.results.filter(group => group.status === 'fulfilled');
    assert.equal(successes.length, 6);
    assert.equal(new Set(successes.map(group => group.fitId)).size, 6);
    assert.equal(new Set(successes.map(group => group.result.analysisId)).size, 1);
    for (const group of successes) {
      assert.equal(group.result.analysisId, batch.analysisId);
      assert.equal(group.result.meta.fitExpiresAt, batch.fitExpiresAt);
      assert.equal(group.result.meta.sex, group.sex);
      assert.equal(group.result.provenance.sex, group.sex);
      assert.deepEqual(group.result.input, body.rows.filter(row => row.Sex === group.sex));
      const downloaded = await fetch(`${base}/api/results/${group.fitId}/download?format=json`);
      assert.equal(downloaded.status, 200, 'Sibling fits must not evict each other, even above five groups.');
      const suffix = group.sex === unsafeSex ? '男性_.._____' : group.sex;
      assert.equal(attachmentFilename(downloaded), `BLSD_complete_quasi-gcv_${group.fitId}_${suffix}.json`);
      assert.deepEqual(await downloaded.json(), publicCountResult(group.result), 'Download retains this group alone and the exact returned values.');
    }
    assert.ok(Math.abs(successes.at(-1).result.points[30].surface - successes[0].result.points[30].surface - Math.log(6)) < 0.01,
      'Distinct input counts must produce distinct fitted surfaces.');
    const first = successes[0];
    const zip = async () => unzip(Buffer.from(await (await fetch(`${base}/api/results/${first.fitId}/download?format=zip`)).arrayBuffer()));
    const before = await zip();
    assert.deepEqual(JSON.parse(before['results.json']), publicCountResult(first.result));
    assert.ok(before['fit.rds'].length > 1000);
    const exported = await post(base, '/api/export', { fitId: first.fitId, metric: 'surface', format: 'pdf' });
    assert.equal(exported.status, 200); assert.equal(Buffer.from(await exported.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal(attachmentFilename(exported), 'BLSD_surface_quasi-gcv_en_Female.pdf');
    for (const group of successes.slice(1, 3)) {
      const figure = await post(base, '/api/export', { fitId: group.fitId, metric: 'surface', format: 'pdf' });
      assert.equal(figure.status, 200);
      assert.equal(attachmentFilename(figure), group.sex === unsafeSex ?
        'BLSD_surface_quasi-gcv_en_男性_.._____.pdf' : 'BLSD_surface_quasi-gcv_en_Male.pdf');
      await figure.arrayBuffer();
    }
    assert.deepEqual((await zip())['fit.rds'], before['fit.rds'], 'Per-group export uses the same saved model and draws.');
    const replacement = await post(base, '/api/fit', { rows: smallObservations(), settings: baseSettings });
    const single = await replacement.json();
    assert.equal(replacement.status, 200, JSON.stringify(single));
    const singleDownload = await fetch(`${base}/api/results/${single.fitId}/download?format=json`);
    assert.equal(attachmentFilename(singleDownload), `BLSD_complete_quasi-gcv_${single.fitId}.json`);
    await singleDownload.arrayBuffer();
    const singleFigure = await post(base, '/api/export', { fitId: single.fitId, metric: 'surface', format: 'pdf' });
    assert.equal(singleFigure.status, 200);
    assert.equal(attachmentFilename(singleFigure), 'BLSD_surface_quasi-gcv_en.pdf');
    await singleFigure.arrayBuffer();
    for (const group of successes) {
      const expired = await fetch(`${base}/api/results/${group.fitId}/download?format=json`);
      assert.equal(expired.status, 410, 'Eviction removes every fit of the oldest analysis together.');
    }
  });
});

test('real R batch expires all sibling downloads and exports together', { timeout: 60000 }, async t => {
  await withServer({ fitTtlMs: 1 }, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    const response = await post(base, '/api/fit-groups', groupRequest());
    const batch = await response.json(); assert.equal(response.status, 200, JSON.stringify(batch));
    assert.ok(batch.results.every(group => group.status === 'fulfilled'));
    await new Promise(resolve => setTimeout(resolve, 10));
    for (const group of batch.results) {
      const downloaded = await fetch(`${base}/api/results/${group.fitId}/download?format=json`);
      assert.equal(downloaded.status, 410); assert.equal((await downloaded.json()).error.code, 'FIT_EXPIRED');
      const exported = await post(base, '/api/export', { fitId: group.fitId, metric: 'surface', format: 'pdf' });
      assert.equal(exported.status, 410); assert.equal((await exported.json()).error.code, 'FIT_EXPIRED');
    }
  });
});
