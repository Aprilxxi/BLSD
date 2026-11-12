import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFittedResult, nearestResultPoint, fittedResultCsv, normalizedModelSettings, filenameFromDisposition, coordinateDraftValue, formatCoordinateDraft, exportResponseMatchesFormat } from '../src/resultHelpers.js';

function point(year, age, shift = 0.1) {
  return { year, age, surface: 350, annual: -2, acceleration: 0, gradient: 0.04, shift,
    intervals: { surface: [300, 400], annual: [-3, -1], acceleration: [-0.01, 0.01], gradient: [0.03, 0.05], shift: shift === null ? null : [0.08, 0.12] },
    masked: shift === null, maskReason: shift === null ? 'UNSTABLE_AGE_GRADIENT' : null, validFraction: shift === null ? 0.8 : 1 };
}

test('download formats reject successful HTML fallbacks and mismatched binary responses', () => {
  for (const [format, mime] of Object.entries({ csv: 'text/csv', json: 'application/json', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf', png: 'image/png', tiff: 'image/tiff' })) {
    assert.equal(exportResponseMatchesFormat(mime + '; charset=utf-8', format), true);
    assert.equal(exportResponseMatchesFormat('text/html; charset=utf-8', format), false);
    assert.equal(exportResponseMatchesFormat(null, format), false);
  }
  assert.equal(exportResponseMatchesFormat('image/png', 'pdf'), false);
  assert.equal(exportResponseMatchesFormat('application/pdf', 'png'), false);
  assert.equal(exportResponseMatchesFormat('image/png', 'tiff'), false);
  assert.equal(exportResponseMatchesFormat('image/tiff', 'png'), false);
  assert.equal(exportResponseMatchesFormat('application/json', 'zip'), false);
  assert.equal(exportResponseMatchesFormat('application/zip', 'xlsx'), false);
  assert.equal(exportResponseMatchesFormat('application/vnd.ms-excel', 'xlsx'), false);
});
function fixture() {
  return { schemaVersion: '1', grid: { years: [2000, 2001, 2002], ages: [2.5, 7.5] },
    points: [point(2000, 2.5), point(2000, 7.5), point(2001, 2.5), point(2001, 7.5, null), point(2002, 2.5), point(2002, 7.5)],
    diagnostics: { method: 'quasi-gcv', converged: true }, settings: {}, meta: { fitted: true } };
}

test('selection snaps both coordinates to an actual server grid point', () => {
  const result = fixture();
  assert.equal(nearestResultPoint(result, 2000.7, 7), result.points[3]);
  assert.equal(nearestResultPoint(result, 1990, 90), result.points[1]);
  assert.equal(nearestResultPoint(result, 2001.5, 5), result.points[2]);
  assert.equal(nearestResultPoint(null, 2000, 2.5), null);
  assert.equal(nearestResultPoint(result, NaN, 2.5), null);
});

test('sparse results return an existing point instead of manufacturing a grid cell', () => {
  const result = fixture();
  result.points.splice(3, 1);
  const selected = nearestResultPoint(result, 2001, 7.5);
  assert.ok(result.points.includes(selected));
});

test('CSV contains the same point values and real intervals, with null staying blank', () => {
  const result = fixture();
  const lines = fittedResultCsv(result, 'shift').replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines.length, result.points.length + 1);
  assert.equal(lines[4], '2001,7.5,shift,,,,true,UNSTABLE_AGE_GRADIENT,0.8,quasi-gcv,R_FITTED_RESULT');
  assert.equal(lines[1], '2000,2.5,shift,0.1,0.08,0.12,false,,1,quasi-gcv,R_FITTED_RESULT');
  const acceleration = fittedResultCsv(result, 'acceleration').split('\r\n')[1].split(',');
  assert.equal(acceleration[3], '0');
  assert.equal(acceleration[4], '-0.01');
});

test('CSV export uses returned coordinates and safely quotes backend text', () => {
  const result = fixture();
  result.diagnostics.method = 'method,"variant"';
  assert.ok(fittedResultCsv(result, 'surface').includes('"method,""variant"""'));
  assert.throws(() => fittedResultCsv(result, 'missing'), /UNKNOWN_METRIC/);
});

test('unfitted, malformed or coordinate-mismatched responses cannot masquerade as a fit', () => {
  assert.equal(assertFittedResult(fixture()).meta.fitted, true);
  for (const change of [r => { r.meta.fitted = false; }, r => { r.schemaVersion = '2'; },
    r => { r.points[0].surface = Infinity; }, r => { r.points[0].year = 2030; },
    r => { r.points[0].intervals.surface = [1, Infinity]; }, r => { r.points.push(r.points[0]); }]) {
    const result = fixture(); change(result);
    assert.throws(() => assertFittedResult(result), /INVALID_FIT_RESPONSE/);
  }
});

test('model basis dimensions stop at unique coordinates minus one and all methods are explicit', () => {
  const settings = { method: 'quasi-reml', draws: '1000', seed: '123', kAge: '4', kYear: '4', threshold: '.005' };
  const summary = { ages: [1, 2, 3, 4, 5], years: [2000, 2001, 2002, 2003, 2004] };
  assert.deepEqual(normalizedModelSettings(settings, summary), { method: 'quasi-reml', draws: 1000, seed: 123, kAge: 4, kYear: 4, threshold: .005 });
  assert.equal(normalizedModelSettings({ ...settings, kAge: 5 }, summary), null);
  assert.equal(normalizedModelSettings({ ...settings, kYear: 5 }, summary), null);
  assert.equal(normalizedModelSettings({ ...settings, seed: '' }, summary), null);
  assert.equal(normalizedModelSettings({ ...settings, threshold: 0 }, summary), null);
  assert.equal(normalizedModelSettings({ ...settings, method: 'unrecognized' }, summary), null);
});

test('masked server points export blank exactly as chart readouts do', () => {
  const result = fixture();
  result.points[0].masked = true;
  const cells = fittedResultCsv(result, 'shift').split('\r\n')[1].split(',');
  assert.deepEqual(cells.slice(3, 7), ['', '', '', 'true']);
});

test('publication filename accepts UTF-8 headers and strips paths or unsafe characters', () => {
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E5%9B%BE%E8%A1%A8.pdf", 'figure.pdf'), '图表.pdf');
  assert.equal(filenameFromDisposition('attachment; filename="../paper.png"', 'figure.png'), 'paper.png');
  assert.equal(filenameFromDisposition(null, 'figure.pdf'), 'figure.pdf');
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''bad%XX; filename=paper.pdf", 'figure.pdf'), 'paper.pdf');
});

test('coordinate drafts retain incomplete editing states and only commit finite numbers', () => {
  for (const draft of ['', ' ', '-', '+', '.', '2e', '2e-', 'Infinity', 'NaN', '1e999', null, true, '85+']) {
    assert.equal(coordinateDraftValue(draft), null, `Must not commit ${String(draft)}`);
  }
  assert.equal(coordinateDraftValue('2005'), 2005);
  assert.equal(coordinateDraftValue('62.5'), 62.5);
  assert.equal(coordinateDraftValue('.5'), .5);
  assert.equal(coordinateDraftValue('2e3'), 2000);
  assert.equal(coordinateDraftValue('0'), 0);
});

test('field display uses at most three decimals while the selected grid coordinate stays exact', () => {
  const age = 62.601010101010104;
  assert.equal(formatCoordinateDraft(age), '62.601');
  assert.equal(formatCoordinateDraft(2005), '2005');
  assert.equal(formatCoordinateDraft(2005.123456), '2005.123');
  assert.equal(formatCoordinateDraft(Infinity), '');
  const result = fixture();
  result.grid.ages[1] = age;
  result.points.forEach(point => { if (point.age === 7.5) point.age = age; });
  const selected = nearestResultPoint(result, 2001, coordinateDraftValue(formatCoordinateDraft(age)));
  assert.equal(selected.age, age);
  assert.ok(fittedResultCsv(result, 'shift').includes(`2001,${age},shift`));
});
