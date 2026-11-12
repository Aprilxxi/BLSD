export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sortedCoordinates(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(isFiniteNumber))].sort((a, b) => a - b);
}

function cellBounds(values, index) {
  const center = values[index];
  if (values.length === 1) return [center - 0.5, center + 0.5];
  return [index === 0 ? center : (values[index - 1] + center) / 2,
    index === values.length - 1 ? center : (center + values[index + 1]) / 2];
}

/** Preserve each returned coordinate and leave an absent grid cell missing. */
export function buildChartGrid(result) {
  if (result?.meta?.fitted !== true || !Array.isArray(result.points) || !result.points.length) return null;
  const years = sortedCoordinates(result.grid?.years);
  const ages = sortedCoordinates(result.grid?.ages);
  if (!years.length || !ages.length) return null;
  const byCoordinate = new Map(result.points.map(point => [`${point.year}|${point.age}`, point]));
  const cells = [];
  for (let ai = 0; ai < ages.length; ai += 1) {
    const [lowAge, highAge] = cellBounds(ages, ai);
    for (let yi = 0; yi < years.length; yi += 1) {
      const [lowYear, highYear] = cellBounds(years, yi);
      const point = byCoordinate.get(`${years[yi]}|${ages[ai]}`) ?? null;
      cells.push({ year: years[yi], age: ages[ai], lowYear, highYear, lowAge, highAge, point });
    }
  }
  return {
    years, ages, cells, byCoordinate,
    domain: { minYear: cellBounds(years, 0)[0], maxYear: cellBounds(years, years.length - 1)[1],
      minAge: cellBounds(ages, 0)[0], maxAge: cellBounds(ages, ages.length - 1)[1] },
  };
}

export function metricValue(point, metric) {
  if (!point || (metric === 'shift' && point.masked === true)) return null;
  return isFiniteNumber(point[metric]) ? point[metric] : null;
}

export function resultInterval(point, metric) {
  const interval = point?.intervals?.[metric];
  return Array.isArray(interval) && interval.length === 2 && interval.every(isFiniteNumber)
    && interval[0] <= interval[1] ? interval : null;
}

/** Use the complete finite range; no quantile clipping or hidden cutoff. */
export function metricColorRange(points, metric) {
  const finite = (Array.isArray(points) ? points : []).map(point => metricValue(point, metric)).filter(isFiniteNumber);
  if (!finite.length) return { hasFinite: false, min: -1, max: 1, observedMin: null, observedMax: null, constant: false, zero: false };
  let observedMin = Infinity, observedMax = -Infinity;
  for (const value of finite) { observedMin = Math.min(observedMin, value); observedMax = Math.max(observedMax, value); }
  const constant = observedMin === observedMax;
  const zero = constant && observedMin === 0;
  if (['surface', 'gradient', 'annual'].includes(metric)) {
    return { hasFinite: true, min: constant ? observedMin - 0.5 : observedMin,
      max: constant ? observedMax + 0.5 : observedMax, observedMin, observedMax, constant, zero };
  }
  const extent = Math.max(Math.abs(observedMin), Math.abs(observedMax));
  return { hasFinite: true, min: extent === 0 ? -1 : -extent, max: extent === 0 ? 1 : extent,
    observedMin, observedMax, constant, zero };
}

export function metricLayer(grid, metric) {
  if (!grid) return [];
  return grid.cells.map(cell => {
    const value = metricValue(cell.point, metric);
    return [cell.year, cell.age, value, value === null ? 1 : 0,
      cell.lowYear, cell.highYear, cell.lowAge, cell.highAge, cell.point === null ? 1 : 0];
  });
}

const MASK_REASONS = {
  UNSTABLE_AGE_GRADIENT: { en: 'Masked: the age gradient is unstable.', zh: '已屏蔽：年龄梯度不稳定。' },
  SMALL_AGE_GRADIENT: { en: 'Masked: the age gradient is too small.', zh: '已屏蔽：年龄梯度过小。' },
  AGE_GRADIENT_TOO_SMALL: { en: 'Masked: the age gradient is too small.', zh: '已屏蔽：年龄梯度过小。' },
  LOW_VALID_DRAW_FRACTION: { en: 'Masked: too few valid coefficient draws.', zh: '已屏蔽：有效系数抽样比例过低。' },
  INSUFFICIENT_VALID_DRAWS: { en: 'Masked: too few valid coefficient draws.', zh: '已屏蔽：有效系数抽样比例过低。' },
  NON_FINITE_RATIO: { en: 'Masked: some coefficient draws produce a non-finite equivalent-age shift ratio.', zh: '已屏蔽：部分系数抽样产生了非有限的等效年龄移动比值。' },
  BOUNDARY: { en: 'Unavailable at the period boundary.', zh: '时期边界处不可估计。' },
  TIME_BOUNDARY: { en: 'Unavailable at the period boundary.', zh: '时期边界处不可估计。' },
  BOUNDARY_ACCELERATION: { en: 'Acceleration is unavailable at the period boundary.', zh: '时期边界处不可估计加速度。' },
  NATURAL_SPLINE_BOUNDARY: { en: 'Acceleration is hidden at natural-spline time endpoints, where curvature is constrained.', zh: '自然样条在时间端点的曲率受约束，因此不展示该处加速度。' },
  NON_FINITE: { en: 'No finite estimate at this location.', zh: '此位置没有有限估计值。' },
};

export function metricMaskReason(point, metric, grid, locale = 'en') {
  const language = locale === 'zh' ? 'zh' : 'en';
  // Display omissions for acceleration are recorded only in machine-readable downloads.
  if (metric === 'acceleration') return null;
  if (metricValue(point, metric) !== null) return null;
  if (!point) return language === 'zh' ? '此网格位置没有返回估计值。' : 'No estimate was returned for this grid cell.';
  const supplied = point.metricMaskReasons?.[metric] ?? (typeof point.maskReason === 'object' && point.maskReason !== null
    ? point.maskReason[metric] : metric === 'shift' ? point.maskReason : null);
  const code = typeof supplied === 'string' ? supplied.toUpperCase().replace(/[ -]/g, '_') : null;
  if (code && MASK_REASONS[code]) return MASK_REASONS[code][language];
  if (metric === 'acceleration' && grid && (point.year === grid.years[0] || point.year === grid.years.at(-1))) {
    return MASK_REASONS.BOUNDARY_ACCELERATION[language];
  }
  if (metric === 'shift' && point.masked) return MASK_REASONS.UNSTABLE_AGE_GRADIENT[language];
  return language === 'zh' ? '此位置没有有限估计值。' : 'No finite estimate at this location.';
}
