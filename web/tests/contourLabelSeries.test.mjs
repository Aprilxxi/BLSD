import test from 'node:test';
import assert from 'node:assert/strict';
import * as echarts from 'echarts';
import { contourLabelSeries } from '../src/contourLabelSeries.js';

const font = 'Arial, "Microsoft YaHei", sans-serif';
const contours = () => [
  { level: 1.234, points: [[-20, 35], [120, 35]] },
  { level: 2.234, points: [[-20, 70], [120, 70]] },
];
const marker = { id: 'selected-location', type: 'scatter', z: 10, symbolSize: 9, data: [[50, 50]] };
function chartFor(paths, options) {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 700, height: 440 });
  chart.setOption({
    animation: false,
    grid: { left: 50, top: 20, right: 50, bottom: 60 },
    xAxis: { type: 'value', min: 0, max: 100 },
    yAxis: { type: 'value', min: 0, max: 100 },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none', start: 0, end: 100 },
      { type: 'inside', yAxisIndex: 0, filterMode: 'none', start: 0, end: 100 },
    ],
    series: [contourLabelSeries(paths, [0, 0], font, options), marker],
  });
  return chart;
}
function renderedLabels(chart) {
  const svg = chart.renderToSVGString();
  assert.match(svg, /^<svg\b/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  return ['1.23', '2.23'].flatMap(text => [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)]
    .filter(match => match[1] === text).map(() => text));
}
const renderedLineCount = chart => [...chart.renderToSVGString().matchAll(/<polyline\b/g)].length;

test('real SVG custom rendering removes all previous children on N → 0 → N updates', () => {
  const paths = contours(), chart = chartFor(paths);
  try {
    assert.deepEqual(renderedLabels(chart), ['1.23', '2.23']);
    assert.equal(renderedLineCount(chart), 4);
    paths.splice(0, paths.length);
    chart.setOption({ series: [{ id: 'contour-labels', data: [[0, 0]] }] });
    assert.deepEqual(renderedLabels(chart), []);
    assert.equal(renderedLineCount(chart), 0);
    paths.push(...contours());
    chart.setOption({ series: [{ id: 'contour-labels', data: [[0, 0]] }] });
    assert.deepEqual(renderedLabels(chart), ['1.23', '2.23']);
    assert.equal(renderedLineCount(chart), 4);
  } finally { chart.dispose(); }
});

test('SVG renders actual line gaps with plain glyphs, preserving both metric line styles', () => {
  for (const metric of ['surface', 'annual']) {
    const chart = chartFor(contours(), { metric });
    try {
      assert.deepEqual(renderedLabels(chart), ['1.23', '2.23']);
      const svg = chart.renderToSVGString();
      const textTags = [...svg.matchAll(/<text\b[^>]*>(?:1\.23|2\.23)<\/text>/g)].map(match => match[0]);
      assert.equal(textTags.length, 2);
      textTags.forEach(tag => {
        assert.match(tag, /font: 12px/);
        assert.doesNotMatch(tag, /stroke=|stroke-width=|paint-order=/);
        assert.match(tag, metric === 'surface' ? /fill="#ffffff"/ : /fill="#333333"/);
      });
      const stroke = metric === 'surface' ? '#ffffff' : '#333333';
      const lineTags = [...svg.matchAll(/<polyline\b[^>]*>/g)].map(match => match[0])
        .filter(tag => tag.includes(`stroke="${stroke}"`));
      assert.equal(lineTags.length, 4, 'Each of two contours is visibly split into two paths around its label.');
      lineTags.forEach(tag => {
        assert.match(tag, metric === 'surface' ? /stroke-width="0\.8"/ : /stroke-width="0\.65"/);
        assert.match(tag, metric === 'surface' ? /stroke-opacity="0\.88"/ : /stroke-opacity="0\.45"/);
      });
      assert.doesNotMatch(svg, /<rect\b[^>]*fill="(?:#fff(?:fff)?|white|rgba\(255,255,255)/i);
      assert.match(svg, /clip-path="url\(#/);
    } finally { chart.dispose(); }
  }
});

test('real dataZoom dispatches recalculate clipped pixels and clear/recover labels', () => {
  const chart = chartFor(contours());
  try {
    assert.deepEqual(renderedLabels(chart), ['1.23', '2.23']);
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, start: 90, end: 100 });
    assert.deepEqual(renderedLabels(chart), []);
    assert.equal(renderedLineCount(chart), 0);
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, start: 0, end: 100 });
    assert.deepEqual(renderedLabels(chart), ['1.23', '2.23']);
    // Both vertices of each contour remain outside the narrowed x viewport.
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 40, end: 60 });
    assert.deepEqual(renderedLabels(chart), ['1.23', '2.23']);
    chart.resize({ width: 440, height: 320 });
    assert.deepEqual(renderedLabels(chart), ['1.23', '2.23']);
  } finally { chart.dispose(); }
});

test('labels are silent beneath the marker and toggling their series removes rendered text', () => {
  const paths = contours(), chart = chartFor(paths);
  try {
    assert.deepEqual(renderedLabels(chart), ['1.23', '2.23']);
    const series = chart.getOption().series;
    const labels = series.find(item => item.id === 'contour-labels');
    assert.equal(labels.silent, true);
    assert.equal(labels.z, 6);
    assert.ok(labels.z < series.find(item => item.id === 'selected-location').z);
    assert.equal(labels.tooltip.show, false);
    assert.equal(labels.emphasis.disabled, true);
    chart.setOption({ series: [marker] }, { replaceMerge: ['series'] });
    assert.deepEqual(renderedLabels(chart), []);
    assert.equal(renderedLineCount(chart), 0);
    assert.deepEqual(chart.getOption().series.filter(Boolean).map(item => item.id), ['selected-location']);
    chart.setOption({ series: [contourLabelSeries(paths, [0, 0], font), marker] }, { replaceMerge: ['series'] });
    assert.deepEqual(renderedLabels(chart), ['1.23', '2.23']);
  } finally { chart.dispose(); }
});
