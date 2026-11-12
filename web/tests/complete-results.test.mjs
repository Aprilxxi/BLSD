import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { completeResultCsv, completeResultZip, resultTables, publicCountResult } from '../server/results-download.mjs';

export function unzipGenerated(bytes) {
  const files = {}; let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString('utf8');
    const start = offset + 30 + length + extra;
    files[name] = inflateRawSync(bytes.subarray(start, start + size)); offset = start + size;
  }
  return files;
}

test('complete downloads retain raw/display values, null masks, sex and all auxiliary tables', () => {
  const result = { schemaVersion: '1', fitId: 'local', input: [{ Year: 2000, Age_Mid: 32.5, Deaths: 1.25, Pop: 100, Sex: 'Female' }],
    points: [{ year: 2000, age: 32.5, acceleration: null, raw: { acceleration: 0 },
      rawIntervals: { acceleration: [0, 0] }, intervals: { acceleration: null },
      metricMaskReasons: { acceleration: 'NATURAL_SPLINE_BOUNDARY' }, metricValidFractions: { acceleration: 1 } }],
    residuals: [{ cohort: 1967.5, devianceResidual: 0.2 }],
    ageSections: { points: [{ year: 2000, age: 32.5, rate: 1250, intervals: { rate: [1100, 1400] } }] },
    timeTrends: { points: [{ year: 2000, age: 32.5, rate: 1250 }] },
    provenance: { filename: '=source.csv' }, settings: { seed: 123 }, meta: { algorithmVersion: 'test' } };
  const tables = resultTables(result); assert.equal(tables.standardized_input[0].Count, 1.25);
  const csv = completeResultCsv(result);
  for (const field of ['raw.acceleration', 'rawIntervals.acceleration.lower95', 'metricMaskReasons.acceleration', 'metricValidFractions.acceleration', 'Female', 'age_sections', 'time_trends', 'analysis_metadata', 'input_provenance']) assert.ok(csv.includes(field), field);
  const rds = Buffer.from('retained R model/draws');
  const files = unzipGenerated(completeResultZip(result, rds));
  assert.deepEqual(files['fit.rds'], rds); assert.deepEqual(JSON.parse(files['results.json']), publicCountResult(result));
  assert.ok(files['prediction_grid.csv'].toString().includes('NATURAL_SPLINE_BOUNDARY'));
  assert.ok(files['age_sections.csv'].toString().includes('intervals.rate.lower95'));
  assert.ok(files['provenance.json'].toString().includes('=source.csv'));
});

test('public results normalize legacy count names without mutating retained observations or statistics', () => {
  const retained = {
    input: [{ Year: 2000, Age_Mid: 32.5, Deaths: 1.25, Pop: 100 }],
    residuals: [{ deaths: 1.25, count: 1.25, fittedDeaths: 1.4, fittedCount: 1.4, devianceResidual: -0.2 }],
    parameters: { formula: 'Deaths ~ te(Year, Age_Mid) + offset(log(Pop))', coefficients: [1.2] },
    provenance: { inputFormat: 'Year,Age_Mid,Deaths,Pop', filename: 'Deaths-source.csv' },
    diagnostics: { nonIntegerDeaths: true },
  };
  const original = structuredClone(retained), exposed = publicCountResult(retained);
  assert.deepEqual(retained, original);
  assert.deepEqual(exposed.input[0], { Year: 2000, Age_Mid: 32.5, Count: 1.25, Pop: 100 });
  assert.deepEqual(exposed.residuals[0], { count: 1.25, fittedCount: 1.4, devianceResidual: -0.2 });
  assert.equal(exposed.parameters.formula, 'Count ~ te(Year, Age_Mid) + offset(log(Pop))');
  assert.equal(exposed.provenance.inputFormat, 'Year,Age_Mid,Count,Pop');
  assert.equal(exposed.provenance.filename, 'Deaths-source.csv', 'A user-provided filename remains its original source string.');
  assert.equal(exposed.diagnostics.nonIntegerCount, true);
  assert.deepEqual(publicCountResult(exposed), exposed, 'Serialization also accepts already-neutral results.');
  const files = unzipGenerated(completeResultZip(retained, Buffer.from('unchanged R snapshot')));
  for (const filename of ['standardized_input.csv', 'residuals.csv', 'metadata.json']) {
    assert.doesNotMatch(files[filename].toString('utf8'), /Deaths|deaths|fittedDeaths/);
  }
});
