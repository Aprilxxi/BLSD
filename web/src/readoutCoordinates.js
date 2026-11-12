import { parseAgeGroup } from './ageGroups.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);

function selectedSex(result) {
  if (own(result?.meta, 'sex')) return result.meta.sex;
  if (own(result?.provenance, 'sex')) return result.provenance.sex;
  return null;
}

function boundsOption(bounds) {
  if (!bounds || !Number.isSafeInteger(bounds.lower) || !Number.isSafeInteger(bounds.upper)) return null;
  const parsed = parseAgeGroup(`${bounds.lower}–${bounds.upper}`);
  if (!parsed || (bounds.midpoint !== undefined && bounds.midpoint !== parsed.midpoint)) return null;
  return { value: parsed.midpoint, label: parsed.label, lower: parsed.lower, upper: parsed.upper };
}

function uniqueOptions(options) {
  const unique = new Map();
  for (const option of options) {
    if (!option) continue;
    const key = `${option.lower}:${option.upper}`;
    if (!unique.has(key)) unique.set(key, option);
  }
  return [...unique.values()].sort((a, b) => a.value - b.value || a.lower - b.lower);
}

/** Closed ranges supplied with this fit; numeric midpoints never imply bounds. */
export function ageGroupOptions(result, rows = [], sex = selectedSex(result)) {
  const supplied = Array.isArray(result?.provenance?.ageGroups) ? result.provenance.ageGroups : [];
  const provenanceOptions = uniqueOptions(supplied
    .filter(group => group && (group.sex === undefined || group.sex === sex))
    .map(boundsOption));
  if (provenanceOptions.length) return provenanceOptions;

  // The caller may pass all input groups or this group's rows. A missing Sex
  // remains unlabelled; it must not borrow another group's supplied ranges.
  return uniqueOptions((Array.isArray(rows) ? rows : [])
    .filter(row => row && (row.Sex ?? null) === sex)
    .map(row => {
      const parsed = parseAgeGroup(row.Age_Group);
      if (!parsed || (row.Age_Mid !== undefined && row.Age_Mid !== parsed.midpoint)) return null;
      return { value: parsed.midpoint, label: parsed.label, lower: parsed.lower, upper: parsed.upper };
    }));
}

/** Expose retained derivation metadata without changing input, fit or labels. */
export function readoutCoordinateChoices(result, rows = [], sex = selectedSex(result)) {
  return {
    ageOptions: ageGroupOptions(result, rows, sex),
    derivedBoth: result?.provenance?.derivedBoth ?? result?.meta?.derivedBoth ?? null,
  };
}

/** Completed-age range 30–34 contains continuous ages from 30 up to 35. */
export function containingAgeGroup(age, options) {
  if (!finite(age)) return null;
  return (Array.isArray(options) ? options : []).find(option =>
    finite(option?.lower) && finite(option?.upper) && option.lower <= age && age < option.upper + 1) ?? null;
}

function numericAgeLabel(age, precision) {
  if (!finite(age)) return '—';
  const digits = Number.isInteger(precision) && precision >= 0 && precision <= 20 ? precision : 3;
  return String(Number(age.toFixed(digits)));
}

/** Curve age labels denote a band only at its exact model midpoint. */
export function formattedAgeLabel(age, options, precision = 3) {
  const exact = finite(age) && (Array.isArray(options) ? options : []).find(option => option.value === age);
  return exact ? exact.label : numericAgeLabel(age, precision);
}

/**
 * A chart click selects a continuous grid age. Keep that exact value in a
 * temporary select option while showing its supplied containing range.
 * Commit a midpoint only in the select's change handler, never on blur.
 */
export function ageGroupSelectState(age, options, precision = 3) {
  const exact = finite(age) && (Array.isArray(options) ? options : []).find(option => option.value === age);
  const containing = exact || containingAgeGroup(age, options);
  const label = containing?.label ?? numericAgeLabel(age, precision);
  return {
    value: finite(age) ? age : '',
    label,
    continuous: Boolean(finite(age) && !exact),
    currentOption: finite(age) ? { value: age, label } : null,
  };
}
