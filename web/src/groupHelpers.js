import { assertFittedResult } from './resultHelpers.js';

const NUMERIC_DRAFT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function coordinates(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter(value => typeof value === 'number' && Number.isFinite(value)))].sort((a, b) => a - b);
}

/** Preserve every supplied label; an unlabeled input is represented by null. */
export function availableGroupSelection(rowsOrGroups) {
  const entries = Array.isArray(rowsOrGroups) ? rowsOrGroups : rowsOrGroups?.groups ?? rowsOrGroups?.rows ?? [];
  return [...new Set(entries.map(entry => {
    const group = Object.prototype.hasOwnProperty.call(entry ?? {}, 'sex') || Array.isArray(entry?.rows);
    return (group ? entry?.sex : entry?.Sex) ?? null;
  }))];
}

function groupSummary(group) {
  return {
    count: group?.summary?.count ?? group?.rows?.length ?? 0,
    ages: coordinates(group?.summary?.ages ?? group?.rows?.map(row => row.Age_Mid)),
    years: coordinates(group?.summary?.years ?? group?.rows?.map(row => row.Year)),
  };
}

/** Settings-only summary: each basis must fit the smallest independently fittable group. */
export function minimumGroupSummary(groups) {
  const summaries = (Array.isArray(groups) ? groups : []).map(groupSummary);
  const valid = summaries.filter(summary => summary.ages.length >= 5 && summary.years.length >= 5);
  // Let the API report each invalid domain rather than making all group failures a settings error.
  const fallback = Array.from({ length: 5 }, (_, index) => index);
  const shortest = axis => valid.reduce((best, summary) =>
    !best || summary[axis].length < best.length ? summary[axis] : best, null) ?? fallback;
  const ages = shortest('ages'), years = shortest('years');
  return {
    count: summaries.reduce((sum, summary) => sum + summary.count, 0),
    ages, years, minAge: ages[0], maxAge: ages.at(-1), minYear: years[0], maxYear: years.at(-1),
    groupCount: summaries.length,
  };
}

/** Clamp valid integer basis drafts only; never repair an empty or malformed setting. */
export function clampGroupSettings(settings, groups) {
  const output = { ...settings }, summary = minimumGroupSummary(groups);
  for (const [name, axis] of [['kAge', 'ages'], ['kYear', 'years']]) {
    const draft = settings?.[name];
    if (typeof draft !== 'number' && typeof draft !== 'string') continue;
    if (typeof draft === 'string' && !NUMERIC_DRAFT.test(draft.trim())) continue;
    const value = Number(draft);
    if (!Number.isFinite(value) || !Number.isInteger(value)) continue;
    output[name] = Math.max(4, Math.min(value, 40, summary[axis].length - 1));
  }
  return output;
}

function invalidBatch() {
  const error = new Error('INVALID_GROUP_FIT_RESPONSE');
  error.code = 'INVALID_GROUP_FIT_RESPONSE';
  throw error;
}

/** Reject an entire response when even one selected group's identity is inconsistent. */
export function assertGroupFitResponse(payload, selectedSexes) {
  const validSex = sex => sex === null || (typeof sex === 'string' && sex.trim().length > 0);
  if (!Array.isArray(selectedSexes) || !selectedSexes.length ||
      !selectedSexes.every(validSex) || new Set(selectedSexes).size !== selectedSexes.length ||
      payload?.schemaVersion !== '1' || typeof payload?.analysisId !== 'string' || !payload.analysisId.trim() ||
      !Array.isArray(payload.results) || payload.results.length !== selectedSexes.length) invalidBatch();
  const fitIds = new Set();
  payload.results.forEach((entry, index) => {
    if (entry?.sex !== selectedSexes[index]) invalidBatch();
    if (entry.status === 'rejected') {
      if (typeof entry.error?.code !== 'string' || !entry.error.code.trim()) invalidBatch();
      return;
    }
    const result = entry.result;
    if (entry.status !== 'fulfilled' || typeof entry.fitId !== 'string' || !entry.fitId.trim() ||
        fitIds.has(entry.fitId) || result?.fitId !== entry.fitId || result?.meta?.fitId !== entry.fitId ||
        result?.meta?.sex !== entry.sex || result?.analysisId !== payload.analysisId ||
        result?.meta?.analysisId !== payload.analysisId) invalidBatch();
    if (Array.isArray(result.input) && result.input.some(row => (row?.Sex ?? null) !== entry.sex)) invalidBatch();
    try { assertFittedResult(result); } catch { invalidBatch(); }
    fitIds.add(entry.fitId);
  });
  return payload;
}

/** Every fifth calendar year from the first observation; never invent a missing year. */
export function defaultSectionYears(values) {
  const available = coordinates(values);
  return available.filter(value => (value - available[0]) % 5 === 0);
}

/** Offer observed coordinates only where this group's retained grid has predictions. */
export function groupCurveOptions(result) {
  const options = (axis, observed, inputField) => {
    const permitted = new Set(coordinates(axis));
    const observations = observed ?? result?.input?.map(row => row[inputField]) ?? axis;
    return coordinates(observations).filter(value => permitted.has(value));
  };
  return {
    sectionYears: options(result?.grid?.years, result?.grid?.observedYears, 'Year'),
    trendAges: options(result?.grid?.ages, result?.grid?.observedAges, 'Age_Mid'),
  };
}

/** Curve selections always belong to this group's retained grid, without a curve-count cap. */
export function groupCurveCoordinates(result) {
  const select = (axis, defaults) => {
    const available = coordinates(axis), permitted = new Set(available);
    const selected = [...new Set((Array.isArray(defaults) ? defaults : []).filter(value => permitted.has(value)))];
    return selected.length ? selected : available.slice(0, 1);
  };
  return {
    sectionYears: select(result?.grid?.years, defaultSectionYears(result?.grid?.observedYears ?? result?.input?.map(row => row.Year) ?? result?.grid?.years)),
    trendAges: select(result?.grid?.ages, coordinates(result?.grid?.observedAges ?? result?.input?.map(row => row.Age_Mid) ?? result?.grid?.ages)),
  };
}
