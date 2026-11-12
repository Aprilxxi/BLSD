import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContourLevels, placeContourLabels } from '../src/contourLabels.js';

const rect = { x: 30, y: 20, width: 600, height: 360 };
const identity = point => point;
const line = (level, y, start = 0, end = 700) => ({ level, points: [[start, y], [end, y]] });
const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('levels use concise exact identities, with enough digits to distinguish neighbours', () => {
  const levels = [0, -0, -2.5, 3, 1.2341, 1.2342, 0.00000012, 120000000, Number.MAX_VALUE, Number.MIN_VALUE];
  const labels = formatContourLevels([...levels, NaN, Infinity, null, '3']);
  assert.equal(labels.size, 9);
  assert.equal(labels.get(0), '0');
  assert.equal(labels.get(-2.5), '-2.5');
  assert.equal(labels.get(3), '3');
  assert.equal(labels.get(0.00000012), '1.2e-7');
  assert.equal(labels.get(120000000), '1.2e8');
  const common = formatContourLevels([1000, 10000, 0.001, -0.00012]);
  assert.deepEqual([...common.values()], ['1000', '1e4', '0.001', '-1.2e-4']);
  assert.notEqual(labels.get(1.2341), labels.get(1.2342));
  assert.equal(new Set(labels.values()).size, labels.size);
  assert.ok([...labels.values()].every(label => !/NaN|Infinity/.test(label)));
  const adjacent = [1, 1 + Number.EPSILON, 1 + 2 * Number.EPSILON];
  assert.equal(new Set(formatContourLevels(adjacent).values()).size, 3);
});

test('a label follows its retained level and stays inside the plot with complete padded bounds', () => {
  const contour = line(4.25, 190);
  const original = structuredClone(contour);
  const labels = placeContourLabels([contour], identity, rect);
  assert.equal(labels.length, 1);
  const label = labels[0];
  assert.equal(label.level, 4.25);
  assert.equal(label.text, '4.25');
  assert.equal(label.y, 190);
  assert.ok(Math.abs(label.x - 330) < 1e-8);
  assert.equal(label.rotation, -0);
  assert.equal(label.fontSize, 11);
  assert.ok(label.width >= label.text.length * 11 * 0.6 + 6);
  assert.ok(label.height >= 13);
  assert.ok(label.bounds.x >= rect.x + 8);
  assert.ok(label.bounds.y >= rect.y + 8);
  assert.ok(label.bounds.x + label.bounds.width <= rect.x + rect.width - 8);
  assert.ok(label.bounds.y + label.bounds.height <= rect.y + rect.height - 8);
  assert.deepEqual(contour, original);
});

test('separate paths of one level receive at most one label, preferring a long internal run', () => {
  const labels = placeContourLabels([line(1, 45, 50, 125), line(1, 210), line(2, 300)], identity, rect);
  assert.equal(labels.length, 2);
  assert.equal(labels.find(label => label.level === 1).y, 210);
  assert.deepEqual(labels.map(label => label.level), [1, 2]);
});

test('nearby contours relocate or omit labels so rotated bounding boxes never overlap', () => {
  const contours = Array.from({ length: 12 }, (_, i) => line(i / 10, 100 + i * 3));
  const labels = placeContourLabels(contours, identity, rect);
  assert.ok(labels.length > 1);
  assert.ok(labels.length <= 8);
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    assert.equal(overlap(labels[i].bounds, labels[j].bounds), false);
  }
});

test('pixel-space tangent rotation matches ECharts positive-counterclockwise convention and stays upright', () => {
  const forward = { level: 2, points: [[70, 70], [570, 320]] };
  const reversed = { level: 2, points: [...forward.points].reverse() };
  const a = placeContourLabels([forward], identity, rect)[0];
  const b = placeContourLabels([reversed], identity, rect)[0];
  assert.ok(Math.abs(a.rotation + Math.atan2(250, 500)) < 1e-12);
  assert.ok(Math.abs(a.rotation - b.rotation) < 1e-12);
  const vertical = placeContourLabels([{ level: 3, points: [[330, 40], [330, 360]] }], identity, rect)[0];
  assert.equal(vertical.rotation, -Math.PI / 2);
  assert.ok([a, b, vertical].every(label => label.rotation >= -Math.PI / 2 && label.rotation <= Math.PI / 2));
});

test('zoomed crossing segments are clipped without requiring an original point inside the viewport', () => {
  const contours = [{ level: 1, points: [[1990, 32.5], [2023, 32.5]] }];
  const dataToPixel = ([year, age]) => [330 + (year - 2005) * 90, 190 - (age - 32.5) * 5];
  const labels = placeContourLabels(contours, dataToPixel, rect);
  assert.equal(labels.length, 1);
  assert.ok(Math.abs(labels[0].x - 330) < 1e-8);
  assert.equal(labels[0].y, 190);
  assert.deepEqual(placeContourLabels(contours, ([x, y]) => [x, y + 1000], rect), []);
});

test('invalid points break paths, short fragments and duplicate points cannot manufacture a label', () => {
  const contours = [
    { level: 1, points: [[80, 100], [90, 100], null, [550, 100], [560, 100]] },
    { level: 2, points: [[330, 200], [330, 200], [330, 200]] },
    { level: 3, points: [[100, 220], [110, 220], [NaN, 220], [500, 220], [510, 220]] },
    { level: Infinity, points: [[100, 250], [500, 250]] },
  ];
  assert.deepEqual(placeContourLabels(contours, identity, rect), []);
  assert.deepEqual(placeContourLabels([line(1, 190)], () => { throw new Error('coordinate unavailable'); }, rect), []);
  assert.deepEqual(placeContourLabels([line(1, 190)], () => [Infinity, 1], rect), []);
});

test('tiny viewports, edge paths and tight loops omit labels rather than clipping or bending text', () => {
  assert.deepEqual(placeContourLabels([line(1, 27)], identity, rect), []);
  assert.deepEqual(placeContourLabels([line(1, 25)], identity, { x: 0, y: 0, width: 35, height: 35 }), []);
  const circle = Array.from({ length: 65 }, (_, i) => [330 + 14 * Math.cos(i * Math.PI / 32), 190 + 14 * Math.sin(i * Math.PI / 32)]);
  assert.deepEqual(placeContourLabels([{ level: 1, points: circle }], identity, rect), []);
});

test('small layouts reduce density and supplied limits are honored without repeated levels', () => {
  const contours = Array.from({ length: 20 }, (_, i) => line(i, 40 + i * 16));
  const desktop = placeContourLabels(contours, identity, rect);
  const small = placeContourLabels(contours, ([x, y]) => [x / 3, y / 3], { x: 0, y: 0, width: 220, height: 140 });
  assert.ok(desktop.length <= 8 && desktop.length >= 5);
  assert.ok(small.length <= 2 && small.length > 0);
  assert.ok(desktop.at(-1).level > 15, 'A density limit keeps a spread of contour values.');
  assert.equal(placeContourLabels(contours, identity, rect, { maxLabels: 2 }).length, 2);
  assert.deepEqual(placeContourLabels(contours, identity, rect, { maxLabels: 0 }), []);
  assert.deepEqual(placeContourLabels(contours, identity, { x: 0, y: 0, width: 0, height: 30 }), []);
  assert.deepEqual(placeContourLabels(contours, identity, { ...rect, x: NaN }), []);
  assert.deepEqual(placeContourLabels(null, identity, rect), []);
});

test('inline presentation staggers labels instead of collecting them in a central column', () => {
  const contours = Array.from({ length: 6 }, (_, i) => line(i + 1, 65 + i * 50));
  const original = structuredClone(contours);
  const labels = placeContourLabels(contours, identity, rect, { stagger: true, fontSize: 12, maxLabels: 6 });
  assert.equal(labels.length, 6);
  assert.ok(Math.max(...labels.map(label => label.x)) - Math.min(...labels.map(label => label.x)) > 180);
  assert.ok(labels.every(label => label.fontSize === 12));
  assert.deepEqual(contours, original);
});
