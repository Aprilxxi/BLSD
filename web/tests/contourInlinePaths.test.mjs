import test from 'node:test';
import assert from 'node:assert/strict';
import { contourInlinePaths } from '../src/contourInlinePaths.js';

const rect = { x: 0, y: 0, width: 100, height: 100 };
const identity = point => point;
const label = (overrides = {}) => ({ level: 1, x: 50, y: 50, rotation: 0, width: 20, height: 10, ...overrides });
const contour = (level = 1, points = [[-100, 50], [200, 50]]) => ({ level, points });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('a long segment crossing a glyph box splits exactly even when all original vertices are outside', () => {
  const contours = [contour()], labels = [label()];
  const original = structuredClone({ contours, labels });
  const paths = contourInlinePaths(contours, labels, identity, rect);
  assert.deepEqual(paths, [
    { level: 1, points: [[0, 50], [40, 50]] },
    { level: 1, points: [[60, 50], [100, 50]] },
  ]);
  assert.deepEqual({ contours, labels }, original);
});

test('only matching levels are cut and adjacent visible vertices remain connected', () => {
  const paths = contourInlinePaths([
    contour(1, [[0, 50], [20, 50], [50, 50], [80, 50], [100, 50]]),
    contour(2, [[0, 50], [50, 50], [100, 50]]),
  ], [label()], identity, rect);
  assert.deepEqual(paths, [
    { level: 1, points: [[0, 50], [20, 50], [40, 50]] },
    { level: 1, points: [[60, 50], [80, 50], [100, 50]] },
    { level: 2, points: [[0, 50], [50, 50], [100, 50]] },
  ]);
});

test('rotated gaps follow ECharts CCW text axes, including reversed paths', () => {
  const gap = label({ rotation: -Math.PI / 4 });
  const forward = contourInlinePaths([contour(1, [[0, 0], [100, 100]])], [gap], identity, rect);
  assert.equal(forward.length, 2);
  near(forward[0].points.at(-1)[0], 50 - 10 / Math.sqrt(2));
  near(forward[0].points.at(-1)[1], 50 - 10 / Math.sqrt(2));
  near(forward[1].points[0][0], 50 + 10 / Math.sqrt(2));
  near(forward[1].points[0][1], 50 + 10 / Math.sqrt(2));
  const reversed = contourInlinePaths([contour(1, [[100, 100], [0, 0]])], [gap], identity, rect);
  reversed.forEach((path, i) => path.points.forEach((point, j) => point.forEach((value, k) => near(value, forward[1 - i].points[1 - j][k]))));
});

test('overlapping gaps are united without hidden connecting segments or empty pieces', () => {
  const paths = contourInlinePaths([contour()], [label({ x: 45 }), label({ x: 55 })], identity, rect);
  assert.deepEqual(paths, [
    { level: 1, points: [[0, 50], [35, 50]] },
    { level: 1, points: [[65, 50], [100, 50]] },
  ]);
  assert.deepEqual(contourInlinePaths([contour()], [label({ width: 300 })], identity, rect), []);
});

test('invalid points and coordinates break paths without bridging missing data', () => {
  const paths = contourInlinePaths([contour(1, [[0, 50], [10, 50], null, [90, 50], [100, 50]])], [], identity, rect);
  assert.deepEqual(paths.map(path => path.points), [[[0, 50], [10, 50]], [[90, 50], [100, 50]]]);
  assert.deepEqual(contourInlinePaths([contour()], [], () => [NaN, 0], rect), []);
  assert.deepEqual(contourInlinePaths([contour()], [], () => { throw new Error('unavailable'); }, rect), []);
  assert.deepEqual(contourInlinePaths([contour(Infinity)], [], identity, rect), []);
  assert.deepEqual(contourInlinePaths([contour()], [], identity, { ...rect, width: 0 }), []);
  assert.deepEqual(contourInlinePaths([contour()], [label({ rotation: NaN })], identity, rect), [{ level: 1, points: [[0, 50], [100, 50]] }]);
});

test('projection and plot clipping use the current zoom without touching retained coordinates', () => {
  const original = [contour(2.2345, [[1990, 32.5], [2023, 32.5]])];
  const before = structuredClone(original);
  const paths = contourInlinePaths(original, [], ([year, age]) => [(year - 2000) * 30, age * 2], rect);
  assert.deepEqual(paths, [{ level: 2.2345, points: [[0, 65], [100, 65]] }]);
  assert.deepEqual(original, before);
});
