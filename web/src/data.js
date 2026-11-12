// The example contains fixed, independently simulated count/exposure inputs.
// Fitted fields are produced only by the R service, never by this module.
export { demoRows, demoMetadata, demoProvenance, demoInputCsv } from './demoSurface.js';
import { parseAgeGroup } from './ageGroups.js';
import { deriveBothRows } from './bothGroups.js';
export { parseAgeGroup, ageGroupsForRows } from './ageGroups.js';
export const defaultModelSettings = Object.freeze({
  method: 'nb-reml',
  draws: 1000,
  seed: 123,
  kAge: 10,
  kYear: 10,
  threshold: 0.005,
});

const columns = ['Year', 'Age_Mid', 'Deaths', 'Pop'];
const inputColumns = ['Year', 'Age_Group', 'Count', 'Pop'];
const publicNumericColumns = ['Year', 'Age_Mid', 'Count', 'Pop'];
const optionalColumns = ['Sex'];
const headerAliases = new Map([
  ['year', 'Year'], ['年份', 'Year'], ['年度', 'Year'], ['年', 'Year'],
  ['age_mid', 'Age_Mid'], ['年龄中点', 'Age_Mid'], ['年龄', 'Age_Mid'],
  ['age_group', 'Age_Group'], ['年龄段', 'Age_Group'], ['年龄组', 'Age_Group'],
  ['count', 'Deaths'], ['计数', 'Deaths'], ['事件数', 'Deaths'], ['发病数', 'Deaths'], ['病例数', 'Deaths'],
  ['deaths', 'Deaths'], ['死亡数', 'Deaths'], ['死亡人数', 'Deaths'],
  ['pop', 'Pop'], ['人口', 'Pop'], ['人口数', 'Pop'], ['暴露人口', 'Pop'],
  ['sex', 'Sex'], ['性别', 'Sex'],
]);
const numberPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function issue(code, row, column, message) {
  return { code, row, column, message };
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!numberPattern.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarize(rows) {
  const years = [...new Set(rows.map(row => row.Year))].sort((a, b) => a - b);
  const ages = [...new Set(rows.map(row => row.Age_Mid))].sort((a, b) => a - b);
  return {
    count: rows.length,
    years,
    ages,
    minYear: years[0] ?? null,
    maxYear: years.at(-1) ?? null,
    minAge: ages[0] ?? null,
    maxAge: ages.at(-1) ?? null,
    sexes: [...new Set(rows.filter(row => row.Sex !== undefined).map(row => row.Sex))],
    groupCount: new Set(rows.map(row => row.Sex ?? null)).size,
  };
}

/** Explicit sex groups are isolated for validation and fitting; absent Sex is one group. */
export function sexGroups(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const sex = row.Sex ?? null;
    if (!grouped.has(sex)) grouped.set(sex, []);
    grouped.get(sex).push(row);
  }
  return [...grouped].map(([sex, group]) => ({ id: sex ?? '', sex, label: sex ?? '', rows: group, summary: summarize(group) }));
}

export function groupRows(rows, sex = null) {
  return rows.filter(row => (row.Sex ?? null) === (sex === '' ? null : sex));
}

export const filterRowsBySex = groupRows;

/** Convert closed age bands to unchanged model coordinates and validate count/exposure rows. */
export function validateRows(inputRows) {
  const rows = [];
  const errors = [];
  const warnings = [];
  const seen = new Map();
  const ageDomains = new Map();
  const hasSexColumn = Array.isArray(inputRows) && inputRows.some(row => Object.prototype.hasOwnProperty.call(row ?? {}, 'Sex'));
  const hasAgeGroupColumn = Array.isArray(inputRows) && inputRows.some(row => Object.prototype.hasOwnProperty.call(row ?? {}, 'Age_Group'));

  if (!Array.isArray(inputRows) || inputRows.length === 0) {
    return {
      rows, errors: [issue('EMPTY_DATA', null, null, 'The data table is empty.')],
      warnings, summary: summarize(rows), groups: [],
    };
  }

  inputRows.forEach((input, index) => {
    const rowNumber = input?._row ?? index + 2;
    const normalized = {};
    let valid = true;
    const hasOwn = column => Object.prototype.hasOwnProperty.call(input ?? {}, column);
    const countAliases = ['Count', 'count'].filter(hasOwn);
    const countValue = countAliases.length ? input[countAliases[0]] : input?.Deaths;
    if (countAliases.length > 1) {
      errors.push(issue('DUPLICATE_COLUMN', rowNumber, 'Count', 'The same count column appears more than once.'));
      valid = false;
    }

    if (hasSexColumn) {
      if (typeof input?.Sex !== 'string' || !input.Sex.trim()) {
        errors.push(issue('MISSING_SEX', rowNumber, 'Sex', 'Sex must be a non-empty group label when the Sex column is present.'));
        valid = false;
      } else normalized.Sex = input.Sex.trim();
    }

    let ageGroup = null;
    if (hasAgeGroupColumn) {
      ageGroup = parseAgeGroup(input?.Age_Group);
      if (!ageGroup) {
        const value = input?.Age_Group;
        const missing = value === undefined || value === null || (typeof value === 'string' && !value.trim());
        errors.push(issue(
          missing ? 'MISSING_AGE_GROUP' : 'INVALID_AGE_GROUP', rowNumber, 'Age_Group',
          missing ? 'Age_Group is required.' : 'Age_Group must be a closed age range such as 30–34, optionally followed by years or 岁, with nonnegative integer bounds in ascending order.',
        ));
        valid = false;
      } else {
        normalized.Age_Group = ageGroup.label;
        normalized.Age_Mid = ageGroup.midpoint;
      }
    }

    const numericColumns = hasAgeGroupColumn && !Object.prototype.hasOwnProperty.call(input ?? {}, 'Age_Mid')
      ? columns.filter(column => column !== 'Age_Mid') : columns;
    for (const column of numericColumns) {
      const value = column === 'Deaths' ? countValue : input?.[column];
      const displayColumn = column === 'Deaths' ? 'Count' : column;
      const parsed = numberValue(value);
      if (parsed === null) {
        const missing = value === undefined || value === null ||
          (typeof value === 'string' && value.trim() === '');
        errors.push(issue(
          missing ? 'MISSING_NUMBER' : 'INVALID_NUMBER', rowNumber, displayColumn,
          missing ? `${displayColumn} is required.` : `${displayColumn} must be a finite number.`,
        ));
        valid = false;
      } else {
        if (column === 'Age_Mid' && ageGroup && parsed !== ageGroup.midpoint) {
          errors.push(issue('INCONSISTENT_AGE_MID', rowNumber, 'Age_Mid', `Age_Mid must equal ${ageGroup.midpoint} for Age_Group ${ageGroup.label}.`));
          valid = false;
        } else normalized[column] = parsed;
      }
    }

    // Legacy Deaths is an internal compatibility name, never a fallback for an invalid Count.
    if (countAliases.length && hasOwn('Deaths')) {
      const legacyCount = numberValue(input.Deaths);
      if (legacyCount === null) {
        const missing = input.Deaths === undefined || input.Deaths === null ||
          (typeof input.Deaths === 'string' && input.Deaths.trim() === '');
        errors.push(issue(missing ? 'MISSING_NUMBER' : 'INVALID_NUMBER', rowNumber, 'Count',
          missing ? 'Count is required in each supplied count column.' : 'Each supplied Count value must be a finite number.'));
        valid = false;
      } else if (normalized.Deaths !== undefined && legacyCount !== normalized.Deaths) {
        errors.push(issue('CONFLICTING_COUNT_COLUMNS', rowNumber, 'Count', 'Count and the legacy count column must contain the same values when both are supplied.'));
        valid = false;
      }
    }

    if (normalized.Deaths < 0) {
      errors.push(issue('NEGATIVE_DEATHS', rowNumber, 'Count', 'Count must be zero or greater.'));
      valid = false;
    }
    if (normalized.Pop <= 0) {
      errors.push(issue('NON_POSITIVE_POP', rowNumber, 'Pop', 'Pop must be greater than zero.'));
      valid = false;
    }
    if (!valid) return;

    if (ageGroup) {
      const sex = normalized.Sex ?? null;
      if (!ageDomains.has(sex)) ageDomains.set(sex, new Map());
      const domain = ageDomains.get(sex);
      const existing = domain.get(ageGroup.midpoint);
      if (existing && (existing.lower !== ageGroup.lower || existing.upper !== ageGroup.upper)) {
        errors.push(issue('INCONSISTENT_AGE_GROUP', rowNumber, 'Age_Group', `Age_Group ${ageGroup.label} has the same midpoint as ${existing.label} on row ${existing.row}; use consistent age ranges within each sex group.`));
        return;
      }
      if (!existing) {
        const overlap = [...domain.values()].find(group => ageGroup.lower <= group.upper && ageGroup.upper >= group.lower);
        if (overlap) {
          errors.push(issue('OVERLAPPING_AGE_GROUPS', rowNumber, 'Age_Group', `Age_Group ${ageGroup.label} overlaps ${overlap.label} on row ${overlap.row}; use non-overlapping age ranges within each sex group.`));
          return;
        }
        domain.set(ageGroup.midpoint, { ...ageGroup, row: rowNumber });
      }
    }

    const key = JSON.stringify([normalized.Year, normalized.Age_Mid, normalized.Sex ?? null]);
    if (seen.has(key)) {
      errors.push(issue(
        'DUPLICATE_YEAR_AGE', rowNumber, hasAgeGroupColumn ? 'Year / Age_Group' : 'Year / Age_Mid',
        `This period and age already appear in the same sex group on row ${seen.get(key)}.`,
      ));
      return;
    }
    seen.set(key, rowNumber);
    rows.push(normalized);
  });

  const summary = summarize(rows);
  const groups = sexGroups(rows);
  for (const group of groups.length ? groups : [{ sex: null, rows: [], summary }]) {
    const suffix = group.sex === null ? '' : ` (${group.sex})`;
    if (group.summary.years.length < 5) {
      errors.push(issue('TOO_FEW_YEARS', null, 'Year', `At least five distinct periods are required${suffix}.`));
    }
    if (group.summary.ages.length < 5) {
      errors.push(issue('TOO_FEW_AGES', null, hasAgeGroupColumn ? 'Age_Group' : 'Age_Mid', `At least five distinct ages are required${suffix}.`));
    }
    if (group.summary.years.length >= 5 && group.summary.ages.length >= 5 &&
        group.rows.length !== group.summary.years.length * group.summary.ages.length) {
      warnings.push(issue(
        'INCOMPLETE_GRID', null, hasAgeGroupColumn ? 'Year / Age_Group' : 'Year / Age_Mid',
        `Some period and age combinations are missing. Review the age-by-period grid${suffix}.`,
      ));
    }
  }
  return { rows, errors, warnings, summary, groups };
}

/** Prepare import choices while retaining the original table and its validation issues. */
export function prepareInputData(validated) {
  if (Object.prototype.hasOwnProperty.call(validated, 'sourceRows')) return validated;
  const sourceRows = validated.rows || [];
  const prepared = {
    ...validated, sourceRows, sourceSummary: validated.summary || summarize(sourceRows), derivedBoth: null,
  };
  if ((validated.errors || []).some(error => !['TOO_FEW_YEARS', 'TOO_FEW_AGES'].includes(error.code))) return prepared;

  const derived = deriveBothRows(sourceRows);
  if (derived.warning) return { ...prepared, warnings: [...(validated.warnings || []), derived.warning] };
  if (!derived.derivedBoth) return prepared;
  const bothValidation = validateRows(derived.rows.filter(row => row.Sex === 'Both'));
  return {
    ...prepared,
    rows: derived.rows,
    summary: summarize(derived.rows),
    groups: sexGroups(derived.rows).map(group => group.sex === 'Both' ? { ...group, derived: true } : group),
    errors: [...(validated.errors || []), ...bothValidation.errors],
    warnings: [...(validated.warnings || []), ...bothValidation.warnings],
    derivedBoth: derived.derivedBoth,
  };
}

/** RFC-style comma-separated values, including escaped quotes and line breaks. */
function readRecords(source) {
  const records = [];
  const errors = [];
  let cells = [];
  let cell = '';
  let state = 'plain';
  let line = 1;
  let recordLine = 1;

  const finishRecord = () => {
    cells.push(cell);
    if (cells.some(value => value.trim() !== '')) records.push({ cells, row: recordLine });
    cells = [];
    cell = '';
    state = 'plain';
    recordLine = line + 1;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (state === 'quoted') {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          state = 'closed';
        }
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && source[index + 1] === '\n') index += 1;
        cell += '\n';
        line += 1;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === ',') {
      cells.push(cell);
      cell = '';
      state = 'plain';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      finishRecord();
      line += 1;
    } else if (char === '"') {
      if (state === 'plain' && cell.trim() === '') {
        cell = '';
        state = 'quoted';
      } else {
        errors.push(issue('INVALID_CSV_QUOTE', line, cells.length + 1, 'A quote occurs outside a quoted cell.'));
        cell += char;
      }
    } else if (state === 'closed') {
      if (!/\s/.test(char)) {
        errors.push(issue('INVALID_CSV_QUOTE', line, cells.length + 1, 'Unexpected text follows a closing quote.'));
        cell += char;
        state = 'plain';
      }
    } else {
      cell += char;
    }
  }
  if (state === 'quoted') {
    errors.push(issue('UNCLOSED_CSV_QUOTE', recordLine, cells.length + 1, 'A quoted cell is not closed.'));
  }
  if (cell !== '' || cells.length > 0) finishRecord();
  return { records, errors };
}

/** Parse a CSV and return validated numeric rows, actionable errors and warnings. */
export function parseCsv(text) {
  if (typeof text !== 'string') {
    return { rows: [], errors: [issue('INVALID_CSV', null, null, 'CSV input must be text.')], warnings: [] };
  }
  const { records, errors } = readRecords(text.replace(/^\uFEFF/, ''));
  if (records.length === 0) {
    return { rows: [], errors: [...errors, issue('EMPTY_DATA', null, null, 'The CSV file is empty.')], warnings: [] };
  }
  const header = records[0];
  const mappedColumns = header.cells.map(value => headerAliases.get(value.trim().toLowerCase()));
  header.cells.forEach((name, index) => {
    if (!mappedColumns[index]) {
      errors.push(issue('UNKNOWN_COLUMN', header.row, name.trim() || index + 1, 'Use Year, Age_Group, Count and Pop, with optional Sex. Legacy Age_Mid remains supported.'));
    } else if (mappedColumns.indexOf(mappedColumns[index]) !== index) {
      errors.push(issue('DUPLICATE_COLUMN', header.row, mappedColumns[index] === 'Deaths' ? 'Count' : mappedColumns[index], 'The same column appears more than once.'));
    }
  });
  for (const column of columns.filter(column => column !== 'Age_Mid')) {
    if (!mappedColumns.includes(column)) {
      const displayColumn = column === 'Deaths' ? 'Count' : column;
      errors.push(issue('MISSING_COLUMN', header.row, displayColumn, `${displayColumn} is missing from the CSV header.`));
    }
  }
  if (!mappedColumns.includes('Age_Group') && !mappedColumns.includes('Age_Mid')) {
    errors.push(issue('MISSING_COLUMN', header.row, 'Age_Group', 'Age_Group is missing from the CSV header.'));
  }
  if (errors.length > 0) return { rows: [], errors, warnings: [] };

  const rawRows = [];
  for (const record of records.slice(1)) {
    if (record.cells.length !== mappedColumns.length) {
      errors.push(issue('COLUMN_COUNT', record.row, null, 'The row does not match the number of header columns.'));
      continue;
    }
    const row = { _row: record.row };
    mappedColumns.forEach((column, index) => { row[column] = record.cells[index]; });
    rawRows.push(row);
  }
  const validated = validateRows(rawRows);
  return { ...validated, errors: [...errors, ...validated.errors] };
}

export function toCsv(rows) {
  const exportColumns = rows.some(row => row.Sex !== undefined) ? [...columns, ...optionalColumns] : columns;
  return writeCsv(rows, exportColumns);
}

function writeCsv(rows, exportColumns) {
  const escape = value => {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [exportColumns.join(','), ...rows.map(row => exportColumns.map(column => escape(row[column])).join(','))].join('\r\n');
}

/** User input CSV uses unit-free ASCII bands for spreadsheet compatibility; unknown bounds remain explicit numeric coordinates. */
export function toInputCsv(rows, ageGroups = []) {
  const knownGroups = new Map();
  for (const bounds of ageGroups) {
    const group = parseAgeGroup(`${bounds.lower}–${bounds.upper}`);
    if (group && group.midpoint === bounds.midpoint) knownGroups.set(group.midpoint, group);
  }
  const labelledRows = rows.map(row => {
    const group = parseAgeGroup(row.Age_Group) ?? knownGroups.get(row.Age_Mid);
    return group && (row.Age_Mid === undefined || row.Age_Mid === group.midpoint)
      ? { ...row, Count: row.Count ?? row.count ?? row.Deaths, Age_Group: `${group.lower}-${group.upper}` } : null;
  });
  if (labelledRows.some(row => row === null)) {
    const exportColumns = rows.some(row => row.Sex !== undefined) ? [...publicNumericColumns, ...optionalColumns] : publicNumericColumns;
    return writeCsv(rows.map(row => ({ ...row, Count: row.Count ?? row.count ?? row.Deaths })), exportColumns);
  }
  const exportColumns = rows.some(row => row.Sex !== undefined) ? [...inputColumns, ...optionalColumns] : inputColumns;
  return writeCsv(labelledRows, exportColumns);
}

export function downloadFile(filename, content, mime = 'text/csv;charset=utf-8') {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('File downloads are available only in a browser.');
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Keep binary exports available while embedded browsers materialize them.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
