import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBothRows } from '../src/bothGroups.js';
import { parseCsv, prepareInputData, validateRows, toInputCsv } from '../src/data.js';

const grid = Sex => Array.from({ length: 5 }, (_, year) =>
  Array.from({ length: 5 }, (_, age) => ({
    Year: 2000 + year, Age_Group: `${30 + age * 5}–${34 + age * 5}`, Age_Mid: 32.5 + age * 5,
    Deaths: (Sex.toLowerCase().trim() === 'male' ? 18 : 7) + age + year * 0.25,
    Pop: (Sex.toLowerCase().trim() === 'male' ? 80000 : 120000) + age * 1000 + year * 0.125, Sex,
  }))
).flat();
const paired = () => [...grid('Male'), ...grid('Female')];
const bothRows = result => result.rows.filter(row => row.Sex === 'Both');

test('Both sums matched counts and populations without rounding, rate averaging or source mutation', () => {
  const input = paired();
  const original = structuredClone(input);
  input.forEach(Object.freeze);
  Object.freeze(input);
  const result = deriveBothRows(input);
  assert.equal(result.warning, null);
  assert.deepEqual(result.derivedBoth, {
    sex: 'Both', sourceSexes: ['Male', 'Female'], rows: 25, method: 'SUM_MATCHED_COUNTS_AND_EXPOSURE',
  });
  assert.equal(result.rows.length, 75);
  assert.deepEqual(input, original);
  assert.deepEqual(result.rows.slice(0, 50), input);
  const combined = bothRows(result);
  for (let index = 0; index < combined.length; index++) {
    const male = input[index], female = input[index + 25], both = combined[index];
    assert.deepEqual(both, { ...male, Deaths: male.Deaths + female.Deaths, Pop: male.Pop + female.Pop, Sex: 'Both' });
    const simpleAverage = (male.Deaths / male.Pop + female.Deaths / female.Pop) / 2;
    assert.notEqual(both.Deaths / both.Pop, simpleAverage);
  }
  assert.ok(combined.some(row => !Number.isInteger(row.Deaths) && !Number.isInteger(row.Pop)));
});

test('pairing uses coordinates rather than source order and canonicalizes actual age bounds', () => {
  const males = grid(' MALE ');
  const females = grid('female').reverse().map(row => ({ ...row, Age_Group: row.Age_Group.replace('–', '-') + 'years' }));
  const result = deriveBothRows([...females, ...males]);
  assert.deepEqual(result.derivedBoth.sourceSexes, [' MALE ', 'female']);
  assert.deepEqual(bothRows(result).map(row => [row.Year, row.Age_Mid]), males.map(row => [row.Year, row.Age_Mid]));
  assert.ok(bothRows(result).every(row => !row.Age_Group.includes('years') && row.Age_Group.includes('–')));
  assert.equal(result.rows[0], females[0]);
});

test('supplied Both in any case takes precedence without recomputation, replacement or warning', () => {
  for (const Sex of ['Both', 'both', 'BOTH', ' Both ']) {
    const supplied = grid(Sex).map(row => ({ ...row, Deaths: 9999 }));
    const input = [...paired(), ...supplied];
    const result = deriveBothRows(input);
    assert.equal(result.rows, input);
    assert.equal(result.derivedBoth, null);
    assert.equal(result.warning, null);
    assert.deepEqual(result.rows.slice(50), supplied);
  }
});

test('single sex, absent Sex and arbitrary labels remain independent without inventing Both', () => {
  for (const input of [[], grid('Male'), grid('Female'), grid('Unspecified'), paired().map(({ Sex, ...row }) => row),
    [...grid('男性'), ...grid('女性')]]) {
    const result = deriveBothRows(input);
    assert.equal(result.rows, input);
    assert.equal(result.derivedBoth, null);
    assert.equal(result.warning, null);
  }
});

test('unrelated groups are retained independently when a matching Male/Female pair derives Both', () => {
  const other = grid('Other');
  const input = [...paired(), ...other];
  const result = deriveBothRows(input);
  assert.equal(result.rows.length, 100);
  assert.deepEqual(result.rows.filter(row => row.Sex === 'Other'), other);
  assert.equal(result.derivedBoth.rows, 25);
});

test('mismatched coordinates or unpaired holes never create a partial Both group', () => {
  const countMismatch = paired().slice(1);
  const yearMismatch = paired();
  yearMismatch[25] = { ...yearMismatch[25], Year: 1999 };
  const ageMismatch = paired();
  ageMismatch[25] = { ...ageMismatch[25], Age_Group: '25–29', Age_Mid: 27.5 };
  const differentHoles = [...grid('Male').slice(1), ...grid('Female').slice(0, -1)];
  for (const input of [countMismatch, yearMismatch, ageMismatch, differentHoles]) {
    const result = deriveBothRows(input);
    assert.equal(result.rows, input);
    assert.equal(result.derivedBoth, null);
    assert.equal(result.warning.code, 'BOTH_GROUP_MISMATCH');
    assert.equal(result.warning.row, null);
  }
});

test('matching incomplete grids preserve the same holes and keep validation warnings', () => {
  const input = [...grid('Male').slice(1), ...grid('Female').slice(1)];
  const prepared = prepareInputData(validateRows(input));
  assert.equal(prepared.derivedBoth.rows, 24);
  assert.equal(bothRows(prepared).length, 24);
  assert.ok(!bothRows(prepared).some(row => row.Year === 2000 && row.Age_Mid === 32.5));
  assert.equal(prepared.warnings.filter(warning => warning.code === 'INCOMPLETE_GRID').length, 3);
});

test('same midpoint with different known bounds or unknown bounds does not pool age groups', () => {
  const differentBounds = paired();
  differentBounds[25] = { ...differentBounds[25], Age_Group: '31–33' };
  const unknownBounds = paired();
  delete unknownBounds[25].Age_Group;
  const malformedBounds = paired();
  malformedBounds[25] = { ...malformedBounds[25], Age_Group: '30–34 years old' };
  const wrongMidpoint = paired();
  wrongMidpoint[25] = { ...wrongMidpoint[25], Age_Group: '30–39' };
  for (const input of [differentBounds, unknownBounds, malformedBounds, wrongMidpoint]) {
    const result = deriveBothRows(input);
    assert.equal(result.derivedBoth, null);
    assert.equal(result.warning.code, 'BOTH_GROUP_MISMATCH');
  }
});

test('legacy midpoint-only pairs remain compatible without fabricated age boundaries', () => {
  const input = paired().map(({ Age_Group, ...row }) => row);
  const result = deriveBothRows(input);
  assert.equal(result.derivedBoth.rows, 25);
  assert.ok(bothRows(result).every(row => !Object.hasOwn(row, 'Age_Group')));
  assert.deepEqual(validateRows(result.rows).errors, []);
});

test('ambiguous case variants and duplicate source coordinates cannot be silently pooled', () => {
  for (const alternate of ['male', 'FEMALE']) {
    const input = [...paired(), ...grid(alternate)];
    const result = deriveBothRows(input);
    assert.equal(result.rows, input);
    assert.equal(result.warning.code, 'BOTH_GROUP_AMBIGUOUS');
  }
  const input = paired();
  input[1] = { ...input[0] };
  assert.equal(deriveBothRows(input).warning.code, 'BOTH_GROUP_MISMATCH');
});

test('overflow, invalid numeric inputs and nonpositive exposure never append derived rows', () => {
  for (const [column, value] of [['Deaths', Number.MAX_VALUE], ['Pop', Number.MAX_VALUE], ['Year', NaN],
    ['Age_Mid', Infinity], ['Deaths', '18'], ['Deaths', -1], ['Pop', 0], ['Pop', -1]]) {
    const input = paired().map(({ Age_Group, ...row }) => row);
    input[0][column] = value;
    if (value === Number.MAX_VALUE) input[25][column] = value;
    if (column === 'Year' || column === 'Age_Mid') input[25][column] = value;
    const result = deriveBothRows(input);
    assert.equal(result.rows, input);
    assert.equal(result.derivedBoth, null);
    assert.equal(result.warning.code, 'BOTH_GROUP_INVALID_SUM');
  }
});

test('import preparation keeps the source preview/count and adds an independently selectable Both group', () => {
  const parsed = parseCsv(toInputCsv(paired()));
  const prepared = prepareInputData(parsed);
  assert.equal(prepared.sourceRows, parsed.rows);
  assert.equal(prepared.sourceSummary, parsed.summary);
  assert.equal(prepared.sourceSummary.count, 50);
  assert.equal(prepared.summary.count, 75);
  assert.deepEqual(prepared.groups.map(group => [group.sex, group.derived || false, group.rows.length]), [
    ['Male', false, 25], ['Female', false, 25], ['Both', true, 25],
  ]);
  assert.deepEqual(prepared.errors, []);
  assert.deepEqual(prepared.warnings, parsed.warnings);
  assert.equal(prepareInputData(prepared), prepared);
  assert.equal(deriveBothRows(prepared.rows).derivedBoth, null);
});

test('structural import errors retain their original issues and prevent deriving from a dropped subset', () => {
  const invalid = paired();
  invalid[0].Deaths = 'bad';
  const parsed = validateRows(invalid);
  const prepared = prepareInputData(parsed);
  assert.equal(prepared.rows, parsed.rows);
  assert.equal(prepared.derivedBoth, null);
  assert.equal(prepared.errors, parsed.errors);
  assert.equal(prepared.warnings, parsed.warnings);

  const source = toInputCsv(paired()) + '\r\n2000,30–34,1,1000,Male,extra';
  const malformedCsv = parseCsv(source);
  assert.ok(malformedCsv.errors.some(error => error.code === 'COLUMN_COUNT'));
  assert.equal(prepareInputData(malformedCsv).derivedBoth, null);
});

test('domain-only failures stay per-group and do not block a valid pair or hide short derived groups', () => {
  const short = grid('Short').filter(row => row.Year < 2004);
  const validPair = prepareInputData(validateRows([...paired(), ...short]));
  assert.equal(validPair.derivedBoth.rows, 25);
  assert.equal(validPair.errors.filter(error => error.code === 'TOO_FEW_YEARS').length, 1);
  assert.match(validPair.errors[0].message, /Short/);

  const shortPair = prepareInputData(validateRows(paired().filter(row => row.Year < 2004)));
  assert.equal(shortPair.derivedBoth.rows, 20);
  assert.equal(shortPair.errors.filter(error => error.code === 'TOO_FEW_YEARS').length, 3);
  assert.ok(shortPair.errors.some(error => error.message.includes('(Both)')));
});
