import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, validateRows, toInputCsv, prepareInputData } from '../src/data.js';

const grid = () => Array.from({ length: 5 }, (_, year) => Array.from({ length: 5 }, (_, age) => ({
  Year: 2000 + year, Age_Group: `${age * 5}-${age * 5 + 4}`, Deaths: 10.125 + age, Pop: 100000.0625,
}))).flat();
const renameCount = (rows, field = 'Count') => rows.map(({ Deaths, ...row }) => ({ ...row, [field]: Deaths }));

test('Count and count normalize to the identical legacy observations, including fractional estimates', () => {
  const expected = validateRows(grid());
  for (const field of ['Count', 'count']) {
    const result = validateRows(renameCount(grid(), field));
    assert.deepEqual(result, expected);
    assert.ok(result.warnings.every(issue => issue.column === 'Count' && !/death/i.test(issue.message)));
  }
});

test('neutral CSV aliases and legacy count aliases preserve all count/exposure values', () => {
  const expected = validateRows(grid());
  for (const alias of ['Count', 'count', 'COUNT', '计数', '事件数', '发病数', '病例数', 'Deaths', '死亡数', '死亡人数']) {
    const csv = `Year,Age_Group,${alias},Pop\r\n` + grid().map(row => `${row.Year},${row.Age_Group},${row.Deaths},${row.Pop}`).join('\r\n');
    assert.deepEqual(parseCsv(csv), expected, alias);
  }
});

test('Count cannot silently use a legacy value when blank, nonfinite, negative or malformed', () => {
  for (const value of ['', ' ', null, undefined, NaN, Infinity, 'Infinity', 'NaN', '1e999', '10abc', true, {}, -1]) {
    const rows = grid().map(row => ({ ...row, Count: row.Deaths }));
    rows[0].Count = value;
    const result = validateRows(rows);
    assert.ok(result.errors.some(issue => issue.row === 2 && issue.column === 'Count'), String(value));
    assert.equal(result.rows.length, 24);
  }
});

test('coexisting current and legacy count values must agree after strict numeric normalization', () => {
  const rows = grid().map(row => ({ ...row, Count: String(row.Deaths) }));
  assert.deepEqual(validateRows(rows), validateRows(grid()));
  for (const value of ['', null, undefined, NaN, Infinity, '10abc']) {
    const invalid = rows.map(row => ({ ...row }));
    invalid[0].Deaths = value;
    assert.ok(validateRows(invalid).errors.some(issue => issue.row === 2 && issue.column === 'Count'), String(value));
  }
  rows[0].Count = rows[0].Deaths + 1;
  assert.ok(validateRows(rows).errors.some(issue => issue.code === 'CONFLICTING_COUNT_COLUMNS' && issue.row === 2));
});

test('duplicate count aliases fail explicitly in CSV and direct objects', () => {
  for (const fields of ['Count,Deaths', 'Count,count', 'Count,事件数', '发病数,病例数']) {
    const result = parseCsv(`Year,Age_Group,${fields},Pop\r\n2000,0-4,10,10,100000`);
    assert.ok(result.errors.some(issue => issue.code === 'DUPLICATE_COLUMN' && issue.column === 'Count'), fields);
  }
  const rows = renameCount(grid()).map(row => ({ ...row, count: row.Count }));
  assert.ok(validateRows(rows).errors.some(issue => issue.code === 'DUPLICATE_COLUMN' && issue.column === 'Count'));
});

test('public input CSV uses Count for age bands and midpoint-only compatibility without rounding', () => {
  const validated = validateRows(grid());
  const csv = toInputCsv(validated.rows);
  assert.equal(csv.split('\r\n')[0], 'Year,Age_Group,Count,Pop');
  assert.deepEqual(parseCsv(csv), validated);
  const midpointRows = validated.rows.map(({ Age_Group, ...row }) => row);
  const midpointCsv = toInputCsv(midpointRows);
  assert.equal(midpointCsv.split('\r\n')[0], 'Year,Age_Mid,Count,Pop');
  assert.deepEqual(parseCsv(midpointCsv), validateRows(midpointRows));
  assert.equal(toInputCsv([]), 'Year,Age_Group,Count,Pop');
});

test('Count and legacy imports produce the same independent sex groups and derived Both counts', () => {
  const source = ['Male', 'Female'].flatMap((Sex, index) => grid().map(row => ({ ...row, Deaths: row.Deaths + index, Sex })));
  const expected = prepareInputData(validateRows(source));
  const actual = prepareInputData(validateRows(renameCount(source)));
  assert.deepEqual(actual, expected);
  assert.equal(actual.sourceRows.length, 50);
  assert.equal(actual.rows.length, 75);
  assert.equal(actual.groups.find(group => group.sex === 'Both').rows[0].Deaths, 21.25);
});
