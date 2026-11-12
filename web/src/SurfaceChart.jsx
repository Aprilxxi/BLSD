import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { METRIC_META, formatResultValue } from './metricMeta.js';
import { nearestResultPoint } from './resultHelpers.js';
import { nearestResidualObservation, residualObservationSelection, residualScatterData } from './residualHelpers.js';
import { buildChartGrid, isFiniteNumber, metricColorRange, metricLayer, metricMaskReason, metricValue, resultInterval } from './chartResult.js';
import { VIRIDIS, AGE_PALETTE, PERIOD_COLORS, TREND_LINE, TREND_RIBBON, figurePalette } from './figureStyle.js';
import { contourLabelSeries } from './contourLabelSeries.js';

export { METRIC_META, formatResultValue } from './metricMeta.js';
export const DIVERGING = AGE_PALETTE;
export const SEQUENTIAL = VIRIDIS;
const MASKED_COLOR = '#939da5';
const FONT = 'Arial, "Microsoft YaHei", sans-serif';
const COPY = {
  en: { emptyTitle: 'No fitted result yet', emptyText: 'Run analysis to view results.', unavailable: 'No finite estimates',
    interval: '95% UI', intervalTitle: 'Approximate pointwise model uncertainty interval from Gaussian coefficient draws', year: 'Period', age: 'Age', ageShort: 'Age', fittedRateUnit: 'Fitted rate per 100,000',
    residual: 'Deviance residual', observations: 'Observations',
    interactive: 'Interactive fitted result; hover to read values, click to select, scroll to zoom', rate: 'Rate per 100,000', observedRate: 'Observed rate', fittedRate: 'Fitted rate' },
  zh: { emptyTitle: '尚无拟合结果', emptyText: '运行分析后查看结果。', unavailable: '无有限估计值',
    interval: '95% UI', intervalTitle: '模型的近似逐点不确定区间（系数近似高斯抽样）', year: '时期', age: '年龄', ageShort: '年龄', fittedRateUnit: '拟合率（每10万人）',
    residual: '偏差残差', observations: '观测残差',
    interactive: '交互拟合结果；悬浮读取，点击选点，滚轮缩放', rate: '率（每10万人）', observedRate: '观测率', fittedRate: '拟合率' },
};
function numberLabel(value) {
  if (!isFiniteNumber(value)) return '—';
  if (value !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 1000000)) return value.toExponential(2);
  return String(Number(value.toFixed(3)));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
function intervalLabel(copy) {
  return `<span title="${escapeHtml(copy.intervalTitle)}">${copy.interval}</span>`;
}
function quantityLabel(value, metric, language, label = METRIC_META[metric].readoutLabel[language]) {
  const unit = METRIC_META[metric].readoutUnit[language];
  const displayUnit = ['surface', 'ageSections', 'timeTrends'].includes(metric) ? `(${unit})` : unit;
  return `${escapeHtml(label)}: <strong>${formatResultValue(value, metric)}</strong>${unit ? ` ${escapeHtml(displayUnit)}` : ''}`;
}
function textGraphic(text, x, y, size = 13, options = {}) {
  return { type: 'text', silent: true, x, y, ...options,
    style: { text, fill: '#222', align: 'center', verticalAlign: 'middle', font: `${size}px ${FONT}`, ...options.style } };
}
function legendGraphics(width, height, state) {
  if (!state.grid || state.curve) return [];
  const residual = state.metric === 'residuals';
  const range = residual ? { hasFinite: true, min: state.grid.domain.minAge, max: state.grid.domain.maxAge } : state.range;
  if (!range.hasFinite) return [];
  const palette = figurePalette(state.metric, range);
  const vertical = width >= 620 && !['gradient', 'shift'].includes(state.metric);
  const unit = residual ? COPY[state.language].age : METRIC_META[state.metric].unit[state.language];
  const size = vertical ? Math.min(128, height * 0.3) : Math.min(230, width - 108);
  const left = vertical ? width - 106 : (width + 32 - size) / 2;
  const top = vertical ? (height - size) / 2 - 4 : height - 45;
  const barWidth = vertical ? 14 : size, barHeight = vertical ? size : 10;
  const stops = palette.map((color, i) => ({ offset: i / (palette.length - 1), color }));
  const title = vertical ? unit.replace(' per ', '\nper ').replace(' / ', '\n/ ') : unit;
  const graphics = [textGraphic(title, vertical ? left + 30 : left + size / 2, vertical ? top - 26 : top - 20, 11,
      { style: { lineHeight: 16 } }),
    { type: 'rect', silent: true, shape: { x: left, y: top, width: barWidth, height: barHeight },
      style: { fill: new echarts.graphic.LinearGradient(0, vertical ? 1 : 0, vertical ? 0 : 1, 0, stops) } }];
  const constant = range.constant;
  const step = 10 ** Math.floor(Math.log10((range.max - range.min) / 4));
  const targetStep = (range.max - range.min) / 4;
  const niceStep = [1, 2, 2.5, 3, 5, 10].map(v => v * step).reduce((a, b) => Math.abs(a - targetStep) <= Math.abs(b - targetStep) ? a : b);
  let ticks = constant ? [range.observedMin] : Array.from({ length: 9 }, (_, i) => Math.ceil(range.min / niceStep) * niceStep + i * niceStep).filter(v => v <= range.max + niceStep * 1e-8);
  if (!ticks.length) ticks = [range.min, (range.min + range.max) / 2, range.max];
  ticks.forEach((value, i) => {
    const fraction = constant ? 0.5 : (value - range.min) / (range.max - range.min);
    const x = vertical ? left + barWidth : left + size * fraction;
    const y = vertical ? top + size * (1 - fraction) : top + barHeight;
    graphics.push({ type: 'line', silent: true, shape: { x1: x, y1: y, x2: x + (vertical ? 4 : 0), y2: y + (vertical ? 0 : 4) }, style: { stroke: '#666', lineWidth: 0.6 } },
      textGraphic(tickLabel(value), x + (vertical ? 8 : 0), y + (vertical ? 0 : 14), 10, { style: { align: vertical ? 'left' : 'center' } }));
  });
  return graphics;
}
function tickLabel(value) {
  if (!isFiniteNumber(value)) return '';
  if (value === 0) return '0';
  return String(Number(value.toPrecision(3)));
}
function ageLabel(result, value, language) {
  const group = result.provenance?.ageGroups?.find(g => g.midpoint === value &&
    isFiniteNumber(g.lower) && isFiniteNumber(g.upper) && g.upper >= g.lower && Math.abs((g.lower + g.upper + 1) / 2 - value) < 1e-8);
  return group ? `${group.lower}–${group.upper}` :
    `${language === 'zh' ? '年龄中点' : 'Age midpoint'} ${numberLabel(value)}`;
}
function fieldTooltip(params, state) {
  const { result, grid, metric, language, showIntervals } = state;
  if (!grid) return '';
  const coordinates = params.seriesId === 'selected-location' ? [state.point?.year, state.point?.age] : params.value;
  const point = nearestResultPoint(result, coordinates?.[0], coordinates?.[1]);
  const readoutMetric = metric === 'surface' ? 'rate' : metric;
  const formatMetric = metric === 'surface' ? 'ageSections' : metric;
  const value = metricValue(point, readoutMetric), interval = resultInterval(point, readoutMetric);
  const reason = metricMaskReason(point, metric, grid, language), copy = COPY[language];
  if (metric === 'acceleration' && value === null) return '';
  return `<div>${copy.year}: ${numberLabel(point?.year)} · ${copy.ageShort}: ${numberLabel(point?.age)}</div><div style="margin-top:6px">${quantityLabel(value, formatMetric, language)}</div>${showIntervals && interval ? `<div style="margin-top:6px">${intervalLabel(copy)}: [${formatResultValue(interval[0], formatMetric)}, ${formatResultValue(interval[1], formatMetric)}]</div>` : ''}${reason ? `<div style="margin-top:6px">${escapeHtml(reason)}</div>` : ''}`;
}
function axis(name, min, max, lightGrid = true) {
  return { type: 'value', min, max, splitNumber: 4, name, nameLocation: 'middle', nameGap: 32,
    nameTextStyle: { fontSize: 12, color: '#222', fontWeight: 400 },
    axisLine: { show: false }, axisTick: { show: false },
    axisLabel: { color: '#525252', fontSize: 10, margin: 9, formatter: numberLabel, hideOverlap: true },
    splitLine: { show: lightGrid, showMinLine: false, showMaxLine: false, lineStyle: { color: '#e9e9e9', width: 1 } },
    minorTick: { show: false, splitNumber: 2 }, minorSplitLine: { show: lightGrid, lineStyle: { color: '#f3f3f3', width: 0.8 } } };
}
function seriesPointTooltip(params, state) {
  const rows = Array.isArray(params) ? params.filter(v => !v.seriesId.startsWith('band-') && !v.seriesId.startsWith('outline-')) : [params];
  const copy = COPY[state.language];
  if (state.metric === 'residuals') {
    const item = rows.find(p => p.data?.source)?.data?.source;
    if (!item) return '';
    const interval = resultInterval(item, 'rate');
    return `<div>${copy.year}: ${numberLabel(item.year)} · ${copy.ageShort}: ${numberLabel(item.age)}</div><div style="margin-top:6px">${quantityLabel(item.devianceResidual, 'residuals', state.language)}</div><div>${quantityLabel(item.observedRate, 'ageSections', state.language, copy.observedRate)}</div><div>${quantityLabel(item.fittedRate, 'ageSections', state.language, copy.fittedRate)}</div>${interval ? `<div>${intervalLabel(copy)}: [${formatResultValue(interval[0], 'ageSections')}, ${formatResultValue(interval[1], 'ageSections')}]</div>` : ''}`;
  }
  return rows.map(param => {
    const p = param.data?.source;
    if (!p) return '';
    if (p.observation) return `<div style="margin:4px 0">${param.marker || ''}${copy.year}: ${numberLabel(p.year)} · ${copy.ageShort}: ${numberLabel(p.age)}<div style="margin-left:15px">${quantityLabel(p.observedRate, 'ageSections', state.language, copy.observedRate)}</div></div>`;
    const interval = resultInterval(p, 'rate');
    return `<div style="margin:4px 0">${param.marker || ''}${escapeHtml(param.seriesName)} · ${numberLabel(state.metric === 'ageSections' ? p.age : p.year)}<div style="margin-left:15px">${quantityLabel(p.rate, 'ageSections', state.language, copy.fittedRate)}</div>${state.showIntervals && interval ? `<div style="margin-left:15px">${intervalLabel(copy)}: [${formatResultValue(interval[0], 'ageSections')}, ${formatResultValue(interval[1], 'ageSections')}]</div>` : ''}</div>`;
  }).join('');
}
function lineSeries(state) {
  const isSection = state.metric === 'ageSections', selected = isSection ? state.sectionYears : state.trendAges;
  const selectedValues = [...new Set(selected || [])].sort((a, b) => a - b);
  const series = [];
  const colors = selectedValues.length <= 3 ? PERIOD_COLORS : [...PERIOD_COLORS, '#C77CFF', '#00BFC4', '#C49A00'];
  selectedValues.forEach((coordinate, i) => {
    const points = state.result.points.filter(p => (isSection ? p.year : p.age) === coordinate && isFiniteNumber(p.rate)).sort((a, b) => isSection ? a.age - b.age : a.year - b.year);
    const x = p => isSection ? p.age : p.year;
    const name = isSection ? String(coordinate) : ageLabel(state.result, coordinate, state.language);
    const color = isSection ? colors[i % colors.length] : TREND_LINE;
    const lineType = ['solid', 'dashed', 'dotted'][Math.floor(i / colors.length) % 3];
    const axes = { xAxisIndex: isSection ? 0 : i, yAxisIndex: isSection ? 0 : i };
    const visible = state.legendSelection?.[name] !== false;
    const displayedPoints = visible ? points : [];
    if (state.showIntervals) {
      series.push({ id: `band-${i}`, type: 'custom', ...axes, silent: true, z: 1, encode: { x: [0, 3], y: [1, 2, 4, 5] }, data: displayedPoints.slice(0, -1).flatMap((p, index) => {
        const next = displayedPoints[index + 1], ci = resultInterval(p, 'rate'), nextCi = resultInterval(next, 'rate');
        return ci && nextCi ? [[x(p), ci[0], ci[1], x(next), nextCi[0], nextCi[1]]] : [];
      }), renderItem: (params, api) => ({ type: 'polygon', shape: { points: [api.coord([api.value(0), api.value(1)]), api.coord([api.value(0), api.value(2)]), api.coord([api.value(3), api.value(5)]), api.coord([api.value(3), api.value(4)])] }, style: { fill: isSection ? color : TREND_RIBBON, opacity: isSection ? 0.12 : 0.2 }, clipPath: { type: 'rect', shape: { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height } } }) });
    }
    series.push({ id: `curve-${coordinate}`, name, type: 'line', ...axes, z: 3, showSymbol: false, symbolSize: 5, clip: true,
      lineStyle: { color, width: 1.6, type: isSection ? lineType : 'solid' }, itemStyle: { color }, data: points.map(p => ({ value: [x(p), p.rate], source: p })), emphasis: { focus: 'series' } });
    const observations = (state.result.residuals || []).filter(p => (isSection ? p.year : p.age) === coordinate && isFiniteNumber(p.observedRate) && (!isSection || p.observedRate > 0));
    if (observations.length) series.push({ id: `observed-${coordinate}`, name: isSection ? name : COPY[state.language].observedRate, type: 'scatter', ...axes, z: 4, symbolSize: isSection ? 4.5 : 3.8,
      itemStyle: { color: isSection ? color : '#222', opacity: isSection ? 0.8 : 0.85 }, data: (visible ? observations : []).map(p => ({ value: [x(p), p.observedRate], source: { ...p, observation: true } })) });
  });
  return { series, names: selectedValues.map(String) };
}
/** Every displayed value and interval belongs to the retained R fit and coefficient draws. */
export default function SurfaceChart({ result, metric = 'shift', year = 2005, age = 62.5, locale = 'en', showIntervals = true,
  showContours = true, sectionYears, trendAges, onSelect, chartRef }) {
  const hostRef = useRef(null), instanceRef = useRef(null), stateRef = useRef(null), callbackRef = useRef(onSelect), viewRef = useRef(null);
  callbackRef.current = onSelect;
  const [size, setSize] = useState({ width: 800, height: 550 });
  const language = locale === 'zh' ? 'zh' : 'en';
  const selectedMetric = METRIC_META[metric] ? metric : 'shift';
  const curve = ['ageSections', 'timeTrends'].includes(selectedMetric);
  const grid = useMemo(() => buildChartGrid(result), [result]);
  const layer = useMemo(() => metricLayer(grid, selectedMetric).filter(row => selectedMetric !== 'acceleration' || row[3] !== 1), [grid, selectedMetric]);
  const range = useMemo(() => metricColorRange(grid ? result.points : [], selectedMetric), [grid, result, selectedMetric]);
  const point = useMemo(() => grid ? selectedMetric === 'residuals' ? nearestResidualObservation(result, year, age) : nearestResultPoint(result, year, age) : null, [grid, result, year, age, selectedMetric]);
  stateRef.current = { result, grid, metric: selectedMetric, curve, language, range, showIntervals, showContours, point,
    sectionYears: sectionYears || result?.defaults?.sectionYears || result?.ageSections?.years || [],
    trendAges: trendAges || result?.defaults?.trendAges || result?.timeTrends?.ages || [] };
  const copy = COPY[language];
  useEffect(() => {
    const chart = echarts.init(hostRef.current, null, { renderer: 'canvas', devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
    instanceRef.current = chart;
    if (chartRef) chartRef.current = chart;
    const click = params => {
      if (!params.data?.source) return;
      const state = stateRef.current;
      if (state.metric === 'residuals') {
        const selection = residualObservationSelection(state.result, params.data.source);
        if (selection) callbackRef.current?.(selection);
      } else callbackRef.current?.({ year: params.data.source.year, age: params.data.source.age });
    };
    const fieldClick = event => {
      const state = stateRef.current, pixel = [event.offsetX, event.offsetY];
      if (!state.grid || state.curve || state.metric === 'residuals' || !chart.containPixel({ gridIndex: 0 }, pixel)) return;
      const coordinate = chart.convertFromPixel({ gridIndex: 0 }, pixel), p = nearestResultPoint(state.result, coordinate[0], coordinate[1]);
      if (p && !(state.metric === 'acceleration' && metricValue(p, 'acceleration') === null)) callbackRef.current?.({ year: p.year, age: p.age });
    };
    const legendChange = event => {
      const state = stateRef.current;
      if (!state.curve) return;
      state.legendSelection = event.selected;
      const companions = lineSeries(state).series.filter(series => series.id.startsWith('band-') || series.id.startsWith('observed-'));
      chart.setOption({ series: companions });
    };
    chart.on('click', click); chart.getZr().on('click', fieldClick);
    chart.on('legendselectchanged', legendChange);
    const observer = new ResizeObserver(() => {
      chart.resize(); setSize({ width: chart.getWidth(), height: chart.getHeight() });
    });
    observer.observe(hostRef.current);
    return () => { observer.disconnect(); chart.off('click', click); chart.off('legendselectchanged', legendChange); chart.getZr().off('click', fieldClick); if (chartRef?.current === chart) chartRef.current = null; chart.dispose(); instanceRef.current = null; };
    // The canvas instance persists as values and display settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const chart = instanceRef.current, state = stateRef.current;
    if (!chart) return;
    if (chartRef) chartRef.current = chart;
    if (!grid) { chart.clear(); return; }
    const { domain } = grid;
    const currentZoom = viewRef.current?.metric === selectedMetric && viewRef.current?.result === result ? chart.getOption()?.dataZoom : null;
    state.legendSelection = viewRef.current?.metric === selectedMetric && viewRef.current?.result === result ? chart.getOption()?.legend?.[0]?.selected || {} : {};
    const width = chart.getWidth(), height = chart.getHeight();
    const verticalLegend = width >= 620 && !['gradient', 'shift'].includes(selectedMetric);
    const option = { animation: false, backgroundColor: '#ffffff', textStyle: { fontFamily: FONT, color: '#222' },
      grid: { left: 58, width: Math.max(80, width - 58 - (verticalLegend ? 126 : 16)), top: 12, height: height - 12 - (verticalLegend ? 50 : 116), show: false },
      tooltip: { trigger: 'item', confine: true, borderWidth: 1, borderColor: '#d5d9dc', backgroundColor: 'rgba(255,255,255,0.97)', textStyle: { fontFamily: FONT, color: '#222', fontSize: 12 }, padding: 12 },
      dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none', start: currentZoom?.[0]?.start ?? 0, end: currentZoom?.[0]?.end ?? 100 },
        { type: 'inside', yAxisIndex: 0, filterMode: 'none', start: currentZoom?.[1]?.start ?? 0, end: currentZoom?.[1]?.end ?? 100 }],
      graphic: legendGraphics(width, height, state), series: [] };
    if (curve) {
      const section = selectedMetric === 'ageSections', lines = lineSeries(state);
      option.tooltip = { ...option.tooltip, trigger: 'axis', formatter: params => seriesPointTooltip(params, stateRef.current) };
      option.series = lines.series;
      if (section) {
        option.grid = { left: 60, right: width >= 620 ? 88 : 16, top: 12, bottom: width >= 620 ? 50 : 90 };
        const agePadding = (domain.maxAge - domain.minAge) * 0.015;
        option.xAxis = axis(copy.age, domain.minAge - agePadding, domain.maxAge + agePadding);
        option.xAxis.axisLabel.showMinLabel = false; option.xAxis.axisLabel.showMaxLabel = false;
        const values = result.points.filter(p => state.sectionYears.includes(p.year)).flatMap(p => [p.rate, ...(resultInterval(p, 'rate') || [])]).concat((result.residuals || []).filter(p => state.sectionYears.includes(p.year)).map(p => p.observedRate)).filter(v => isFiniteNumber(v) && v > 0);
        const logMin = Math.log(Math.min(...values)), logMax = Math.log(Math.max(...values));
        const logPadding = (logMax - logMin || 1) * 0.05;
        option.yAxis = { ...axis(copy.rate), type: 'log', logBase: 10, min: Math.exp(logMin - logPadding), max: Math.exp(logMax + logPadding), scale: true, nameGap: 47 };
        option.yAxis.axisLabel.showMinLabel = false; option.yAxis.axisLabel.showMaxLabel = false;
        option.legend = { type: 'scroll', ...(width >= 620 ? { right: 14, top: 36, bottom: 36, orient: 'vertical' } : { bottom: 12, left: 'center' }),
          data: lines.names, selected: state.legendSelection, textStyle: { color: '#444', fontSize: 12 }, itemWidth: 22, itemHeight: 6, itemGap: 14, selectedMode: true };
        if (width >= 620) option.graphic.push(textGraphic(copy.year, width - 43, 16, 12));
      } else {
        const count = state.trendAges.length, cols = Math.min(count, width >= 720 ? 3 : width >= 490 ? 2 : 1), rows = Math.ceil(count / cols);
        const left = 62, right = 12, gap = cols === 3 ? 46 : 50, panelWidth = (width - left - right - (cols - 1) * gap) / cols;
        const top = 30, bottom = 44, rowGap = 48, panelHeight = (height - top - bottom - (rows - 1) * rowGap) / rows;
        option.grid = []; option.xAxis = []; option.yAxis = [];
        state.trendAges.forEach((coordinate, i) => {
          const col = i % cols, row = Math.floor(i / cols), panelLeft = left + col * (panelWidth + gap), panelTop = top + row * (panelHeight + rowGap);
          option.grid.push({ left: panelLeft, top: panelTop, width: panelWidth, height: panelHeight });
          const xa = axis('', domain.minYear - 0.5, domain.maxYear + 0.5); xa.gridIndex = i; xa.splitNumber = 3; xa.axisLabel.fontSize = 10;
          xa.axisLabel.formatter = value => String(Math.round(value)); xa.minInterval = 1;
          option.xAxis.push(xa);
          const ya = { ...axis(''), gridIndex: i, scale: true, splitNumber: 3,
            min: extent => extent.min - (extent.max - extent.min || Math.abs(extent.min) || 1) * 0.05,
            max: extent => extent.max + (extent.max - extent.min || Math.abs(extent.max) || 1) * 0.05 };
          ya.axisLabel = { ...ya.axisLabel, fontSize: 10, showMinLabel: false, showMaxLabel: false };
          option.yAxis.push(ya);
          option.graphic.push(textGraphic(ageLabel(result, coordinate, language), panelLeft + panelWidth / 2, panelTop - 18, 12));
        });
        option.graphic.push(textGraphic(copy.year, left + (width - left - right) / 2, height - 13, 12),
          textGraphic(copy.rate, 16, height / 2, 12, { rotation: Math.PI / 2 }));
        option.dataZoom = [{ ...option.dataZoom[0], xAxisIndex: Array.from({ length: count }, (_, i) => i) }];
      }
    } else if (selectedMetric === 'residuals') {
      const residuals = residualScatterData(result);
      const values = residuals.map(point => point.source);
      const padded = field => {
        if (!values.length) return [undefined, undefined];
        const min = Math.min(...values.map(p => p[field])), max = Math.max(...values.map(p => p[field]));
        const padding = (max - min || 1) * 0.05;
        return [min - padding, max + padding];
      };
      const fittedRates = values.map(point => point.fittedRate);
      const logMin = fittedRates.length ? Math.log(Math.min(...fittedRates)) : null;
      const logMax = fittedRates.length ? Math.log(Math.max(...fittedRates)) : null;
      const logPadding = fittedRates.length ? (logMax - logMin || 1) * 0.05 : 0;
      option.xAxis = { ...axis(copy.fittedRateUnit), type: 'log', logBase: 10, scale: true,
        ...(fittedRates.length ? { min: Math.exp(logMin - logPadding), max: Math.exp(logMax + logPadding) } : {}) };
      option.yAxis = { ...axis(copy.residual, ...padded('devianceResidual')), scale: true, nameGap: 42, splitNumber: 3 };
      for (const a of [option.xAxis, option.yAxis]) { a.axisLabel.showMinLabel = false; a.axisLabel.showMaxLabel = false; }
      option.tooltip.formatter = params => seriesPointTooltip(params, stateRef.current);
      option.visualMap = { type: 'continuous', show: false, dimension: 2, min: domain.minAge, max: domain.maxAge, seriesIndex: [0], inRange: { color: SEQUENTIAL } };
      option.series = [{ id: 'residual-observations', name: copy.observations, type: 'scatter', symbolSize: 4.5,
        itemStyle: { opacity: 0.55 }, data: residuals,
        markLine: { silent: true, symbol: 'none', lineStyle: { color: '#555', type: 'dashed', width: 0.8 }, label: { show: false }, data: [{ yAxis: 0 }] } },
        { id: 'selected-residual', type: 'scatter', z: 10, symbolSize: 9, data: [], itemStyle: { color: 'transparent', borderColor: '#183646', borderWidth: 1.5 }, emphasis: { scale: false } }];
    } else {
      const fieldGrid = !['gradient', 'shift'].includes(selectedMetric);
      const yearPadding = fieldGrid ? 0 : (domain.maxYear - domain.minYear) * 0.04;
      const agePadding = fieldGrid ? 0 : (domain.maxAge - domain.minAge) * 0.04;
      const lowYear = selectedMetric === 'acceleration' && layer.length ? Math.min(...layer.map(row => row[4])) : domain.minYear;
      const highYear = selectedMetric === 'acceleration' && layer.length ? Math.max(...layer.map(row => row[5])) : domain.maxYear;
      option.xAxis = axis(copy.year, lowYear - yearPadding, highYear + yearPadding, fieldGrid);
      option.yAxis = axis(copy.age, domain.minAge - agePadding, domain.maxAge + agePadding, fieldGrid);
      option.xAxis.splitNumber = 4; option.yAxis.splitNumber = fieldGrid ? 3 : 6;
      for (const a of [option.xAxis, option.yAxis]) { a.axisLabel.showMinLabel = false; a.axisLabel.showMaxLabel = false; }
      option.xAxis.axisLabel.showMinLabel = ['surface', 'annual'].includes(selectedMetric);
      option.tooltip.formatter = params => fieldTooltip(params, stateRef.current);
      option.visualMap = { type: 'continuous', show: false, dimension: 2, min: range.min, max: range.max, seriesIndex: [0], inRange: { color: figurePalette(selectedMetric, range) } };
      option.series = [{ id: 'fitted-field', name: METRIC_META[selectedMetric].title[language], type: 'custom', coordinateSystem: 'cartesian2d',
        dimensions: ['year', 'age', 'estimate', 'missing', 'lowYear', 'highYear', 'lowAge', 'highAge', 'absentCell'], encode: { x: 0, y: 1, tooltip: [2] }, data: layer, progressive: 0,
        renderItem: (params, api) => {
          const topLeft = api.coord([api.value(4), api.value(7)]), bottomRight = api.coord([api.value(5), api.value(6)]);
          const shape = echarts.graphic.clipRectByRect({ x: Math.floor(topLeft[0]), y: Math.floor(topLeft[1]), width: Math.ceil(bottomRight[0]) - Math.floor(topLeft[0]), height: Math.ceil(bottomRight[1]) - Math.floor(topLeft[1]) },
            { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height });
          return shape ? { type: 'rect', shape, style: { fill: api.value(3) === 1 ? MASKED_COLOR : api.visual('color') } } : null;
        }, emphasis: { disabled: true } }];
      if (showContours && ['surface', 'annual'].includes(selectedMetric)) {
        // Render paths and labels together so the line leaves a clean gap at
        // each number, recalculating only display geometry on zoom and resize.
        option.series.push(contourLabelSeries(result.contours?.[selectedMetric] || [], [domain.minYear, domain.minAge], FONT,
          { metric: selectedMetric }));
      }
      option.series.push({ id: 'selected-location', type: 'scatter', z: 10, symbolSize: 9, data: [], itemStyle: { color: '#183646', borderColor: '#fff', borderWidth: 1.5 }, emphasis: { scale: false } });
    }
    chart.setOption(option, { notMerge: true });
    viewRef.current = { metric: selectedMetric, result };
  }, [grid, layer, selectedMetric, language, range, curve, showContours, showIntervals, sectionYears, trendAges, chartRef, result, size]);
  useEffect(() => {
    const chart = instanceRef.current;
    if (!chart || !grid || curve) return;
    if (selectedMetric === 'residuals') {
      chart.setOption({ series: [{ id: 'selected-residual', data: point ? [{ value: [point.fittedRate, point.devianceResidual, point.age], source: point }] : [] }] });
    } else chart.setOption({ series: [{ id: 'selected-location', data: point && !(selectedMetric === 'acceleration' && metricValue(point, 'acceleration') === null) ? [[point.year, point.age]] : [] }] });
  }, [grid, point, selectedMetric, curve, language, showContours, showIntervals, size]);
  const facetCount = stateRef.current.trendAges.length;
  const facetColumns = Math.min(facetCount || 1, size.width >= 720 ? 3 : size.width >= 490 ? 2 : 1);
  const facetHeight = Math.max(340, Math.ceil(facetCount / facetColumns) * 210 + 32);
  return <div style={{ position: 'relative', width: '100%', height: selectedMetric === 'timeTrends' ? facetHeight : '100%' }}>
    <div ref={hostRef} className="surface-chart-canvas" role={grid ? 'img' : undefined} aria-hidden={!grid || undefined}
      aria-label={grid ? `${METRIC_META[selectedMetric].title[language]}. ${copy.interactive}` : undefined} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    {!grid && <div role="status" className="chart-empty"><strong>{copy.emptyTitle}</strong><span>{copy.emptyText}</span></div>}
  </div>;
}
