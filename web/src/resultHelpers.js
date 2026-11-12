import { metricValue, resultInterval } from './chartResult.js';
const METRICS = ['surface', 'annual', 'acceleration', 'gradient', 'shift'];
const pointIndexes = new WeakMap();

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function coordinates(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(finite))].sort((a, b) => a - b);
}
function closest(values, target) {
  if (!values.length || !Number.isFinite(Number(target))) return null;
  const number = Number(target);
  return values.reduce((best, value) => Math.abs(value - number) < Math.abs(best - number) ? value : best, values[0]);
}
function indexFor(result) {
  if (pointIndexes.has(result)) return pointIndexes.get(result);
  const points = Array.isArray(result?.points) ? result.points : [];
  const index = {
    years: coordinates(result?.grid?.years),
    ages: coordinates(result?.grid?.ages),
    byCoordinate: new Map(points.map(point => [`${point.year}|${point.age}`, point])),
    points,
  };
  pointIndexes.set(result, index);
  return index;
}

/** Return the actual server point nearest to a selected age and year. */
export function nearestResultPoint(result, year, age) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.points) || !result.points.length) return null;
  if (!Number.isFinite(Number(year)) || !Number.isFinite(Number(age))) return null;
  const index = indexFor(result);
  const selectedYear = closest(index.years, year);
  const selectedAge = closest(index.ages, age);
  if (selectedYear !== null && selectedAge !== null) {
    const exact = index.byCoordinate.get(`${selectedYear}|${selectedAge}`);
    if (exact) return exact;
  }
  // A sparse response still selects an actual returned point, never an invented cell.
  const yearSpan = Math.max(1, (index.years.at(-1) ?? 1) - (index.years[0] ?? 0));
  const ageSpan = Math.max(1, (index.ages.at(-1) ?? 1) - (index.ages[0] ?? 0));
  let nearest = null, bestDistance = Infinity;
  for (const point of index.points) {
    if (!finite(point.year) || !finite(point.age)) continue;
    const distance = ((point.year - Number(year)) / yearSpan) ** 2 + ((point.age - Number(age)) / ageSpan) ** 2;
    if (distance < bestDistance) { nearest = point; bestDistance = distance; }
  }
  return nearest;
}

/** Reject an incompatible API response before it can be presented as a fitted result. */
export function assertFittedResult(result) {
  if (result?.schemaVersion !== '1' || result?.meta?.fitted !== true ||
      !Array.isArray(result?.grid?.years) || !Array.isArray(result?.grid?.ages) ||
      !Array.isArray(result?.points) || result.points.length === 0) {
    throw new Error('INVALID_FIT_RESPONSE');
  }
  const years = coordinates(result.grid.years), ages = coordinates(result.grid.ages);
  if (years.length !== result.grid.years.length || ages.length !== result.grid.ages.length || !years.length || !ages.length) {
    throw new Error('INVALID_FIT_RESPONSE');
  }
  const seen = new Set();
  for (const point of result.points) {
    const key = `${point.year}|${point.age}`;
    if (!finite(point.year) || !finite(point.age) || !years.includes(point.year) || !ages.includes(point.age) || seen.has(key)) {
      throw new Error('INVALID_FIT_RESPONSE');
    }
    seen.add(key);
    for (const metric of METRICS) {
      if (point[metric] !== null && !finite(point[metric])) throw new Error('INVALID_FIT_RESPONSE');
      const interval = point.intervals?.[metric];
      if (interval !== null && interval !== undefined &&
          (!Array.isArray(interval) || interval.length !== 2 || !interval.every(value => value === null || finite(value)))) {
        throw new Error('INVALID_FIT_RESPONSE');
      }
    }
  }
  return result;
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Export only the real returned grid values. A masked or missing value stays blank. */
export function fittedResultCsv(result, metric) {
  if (!METRICS.includes(metric)) throw new Error('UNKNOWN_METRIC');
  assertFittedResult(result);
  const header = ['Year', 'Age_Mid', 'Metric', 'Fitted_Value', 'Lower_95', 'Upper_95', 'Masked', 'Mask_Reason', 'Valid_Draw_Fraction', 'Method', 'Result_Type'];
  const method = result.diagnostics?.method ?? result.settings?.method ?? '';
  const rows = result.points.map(point => {
    const value = metricValue(point, metric);
    const interval = value === null ? null : resultInterval(point, metric);
    return [point.year, point.age, metric, value, interval?.[0], interval?.[1],
      value === null,
      point.metricMaskReasons?.[metric] ?? (metric === 'shift' ? point.maskReason : ''), point.validFraction, method, 'R_FITTED_RESULT'];
  });
  return '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function filenameFromDisposition(disposition, fallback) {
  let filename;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition || '');
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(disposition || '');
  const plain = /filename\s*=\s*([^;]+)/i.exec(disposition || '');
  if (encoded) {
    try { filename = decodeURIComponent(encoded[1].trim()); } catch { /* Fall through to a plain filename. */ }
  }
  filename ||= quoted?.[1] || plain?.[1]?.trim() || fallback;
  const safe = String(filename || fallback).split(/[\\/]/).at(-1).replace(/[\x00-\x1f<>:"|?*]/g, '_');
  return safe && safe !== '.' && safe !== '..' ? safe : fallback;
}

/** A successful HTTP status is insufficient when a static server returns its HTML fallback. */
export function exportResponseMatchesFormat(contentType, format) {
  const expected = { csv: 'text/csv', json: 'application/json', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf', png: 'image/png', tiff: 'image/tiff' }[format];
  return Boolean(expected && typeof contentType === 'string' && contentType.split(';')[0].trim().toLowerCase() === expected);
}

export function formatResultNumber(value, digits = 3) {
  return finite(value) ? Number(value.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
}

export function normalizedModelSettings(settings, summary) {
  if (!['quasi-gcv', 'quasi-reml', 'nb-reml'].includes(settings?.method)) return null;
  const output = { method: settings.method };
  for (const name of ['draws', 'seed', 'kAge', 'kYear', 'threshold']) {
    const value = settings[name];
    if (value === '' || value === null || value === undefined || typeof value === 'boolean' || !Number.isFinite(Number(value))) return null;
    output[name] = Number(value);
  }
  if (!Number.isInteger(output.draws) || output.draws < 100 || output.draws > 10000 ||
      !Number.isInteger(output.seed) || output.seed < 0 || output.seed > 2147483647 ||
      !Number.isInteger(output.kAge) || output.kAge < 4 || output.kAge > Math.min(40, (summary?.ages?.length ?? 0) - 1) ||
      !Number.isInteger(output.kYear) || output.kYear < 4 || output.kYear > Math.min(40, (summary?.years?.length ?? 0) - 1) ||
      output.threshold <= 0 || output.threshold > 1) return null;
  return output;
}

/** A field draft is committed only when it is a complete finite number. */
export function coordinateDraftValue(draft) {
  if (typeof draft !== 'string' && typeof draft !== 'number') return null;
  const text = String(draft).trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Keep the field readable without rounding the selected server coordinate. */
export function formatCoordinateDraft(value) {
  return finite(value) ? String(Number(value.toFixed(3))) : '';
}
