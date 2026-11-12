import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartGrid, metricLayer, metricColorRange, metricMaskReason, resultInterval } from '../src/chartResult.js';

function fittedResult() {
  return { meta: { fitted: true }, grid: { years: [2000.5, 2001.25], ages: [10, 20] }, points: [
    { year: 2000.5, age: 10, surface: 4, annual: -2, acceleration: null, shift: null, masked: true, maskReason: 'SMALL_AGE_GRADIENT', intervals: {} },
    { year: 2001.25, age: 10, surface: 5, annual: 30, acceleration: null, shift: 0.1, intervals: { shift: [0.05, 0.2] } },
    { year: 2000.5, age: 20, surface: 6, annual: 1, acceleration: null, shift: 0.2, intervals: {} },
  ] };
}

test('actual decimal coordinates are retained and absent cells are explicitly missing', () => {
  const grid = buildChartGrid(fittedResult());
  assert.deepEqual(grid.years, [2000.5, 2001.25]);
  assert.equal(grid.cells.length, 4);
  assert.equal(grid.cells.at(-1).point, null);
  assert.deepEqual(metricLayer(grid, 'shift')[0].slice(0, 4), [2000.5, 10, null, 1]);
  assert.equal(metricLayer(grid, 'surface').at(-1)[2], null);
  assert.equal(buildChartGrid(null), null);
  assert.equal(buildChartGrid({ ...fittedResult(), meta: { fitted: false } }), null);
});

test('reference scales preserve the complete range and signed ratio/acceleration retain zero centre', () => {
  const result = fittedResult();
  assert.deepEqual(metricColorRange(result.points, 'annual'), {
    hasFinite: true, min: -2, max: 30, observedMin: -2, observedMax: 30, constant: false, zero: false,
  });
  assert.equal(metricColorRange(result.points, 'surface').min, 4);
  assert.equal(metricColorRange(result.points, 'surface').max, 6);
  assert.equal(metricColorRange(result.points, 'acceleration').hasFinite, false);
  assert.equal(metricColorRange([{ annual: 0 }], 'annual').zero, true);
  assert.equal(metricColorRange([{ annual: -8 }, { annual: -1 }], 'annual').max, -1);
  assert.equal(metricColorRange([{ gradient: 6 }, { gradient: 16 }], 'gradient').min, 6);
  assert.equal(metricColorRange([{ shift: 1 }, { shift: 0.1 }], 'shift').min, -1);
});

test('real intervals and metric-specific missing reasons survive without synthesis', () => {
  const result = fittedResult(), grid = buildChartGrid(result);
  assert.deepEqual(resultInterval(result.points[1], 'shift'), [0.05, 0.2]);
  assert.equal(resultInterval(result.points[0], 'shift'), null);
  assert.equal(resultInterval({ intervals: { shift: [0.2, 0.1] } }, 'shift'), null);
  assert.match(metricMaskReason(result.points[0], 'shift', grid, 'en'), /too small/);
  assert.equal(metricMaskReason(result.points[0], 'acceleration', grid, 'zh'), null);
  assert.match(metricMaskReason(null, 'annual', grid, 'en'), /No estimate/);
  assert.equal(metricMaskReason({ ...result.points[0], metricMaskReasons: { acceleration: 'NATURAL_SPLINE_BOUNDARY' } }, 'acceleration', grid, 'en'), null);
  assert.match(metricMaskReason({ ...result.points[0], metricMaskReasons: { shift: 'NON_FINITE_RATIO' } }, 'shift', grid, 'zh'), /非有限/);
});
