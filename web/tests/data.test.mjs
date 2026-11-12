import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { demoRows, demoMetadata, demoProvenance, demoInputCsv, parseCsv, validateRows, toCsv, toInputCsv, parseAgeGroup, ageGroupsForRows, downloadFile, defaultModelSettings, sexGroups, groupRows, filterRowsBySex } from '../src/data.js';

const grid = () => Array.from({ length: 5 }, (_, year) =>
  Array.from({ length: 5 }, (_, age) => ({ Year: 2000 + year, Age_Mid: 2.5 + age * 5, Deaths: 10 + age, Pop: 100000 }))
).flat();
const codes = result => result.errors.map(error => error.code);
const closedGrid = () => Array.from({ length: 5 }, (_, year) =>
  Array.from({ length: 5 }, (_, age) => ({ Year: 2000 + year, Age_Group: `${age * 5}–${age * 5 + 4}`, Deaths: 10 + age, Pop: 100000 }))
).flat();

test('independent synthetic demo covers 34 periods and 13 bounded age groups without a sex label', () => {
  assert.equal(demoRows.length, 442);
  const result = validateRows(demoRows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.rows.every(row => Number.isSafeInteger(row.Year) && Number.isSafeInteger(row.Deaths) && Number.isSafeInteger(row.Pop)));
  assert.ok(demoRows.every(row => !Object.hasOwn(row, 'Sex')));
  assert.equal(result.summary.years.length, 34);
  assert.equal(result.summary.ages.length, 13);
  assert.equal(result.summary.minYear, 1990);
  assert.equal(result.summary.maxYear, 2023);
  assert.equal(result.summary.minAge, 32.5);
  assert.equal(result.summary.maxAge, 92.5);
  assert.deepEqual(result.summary.sexes, []);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].sex, null);
  assert.equal(demoMetadata.sex ?? null, null);
  assert.equal(demoMetadata.simulated, true);
  assert.equal(demoMetadata.derived, false);
  assert.equal(demoMetadata.originalEstimates, false);
  assert.equal(demoMetadata.source, 'INDEPENDENT_SYNTHETIC_COUNT_EXPOSURE');
  assert.equal(demoMetadata.version, 'BLSD-INDEPENDENT-SYNTHETIC-20261022-v1');
  assert.equal(demoMetadata.generationSeed, 20261022);
  assert.equal(demoMetadata.coefficientSeed, 123);
  assert.equal(demoMetadata.filename, 'example_data.csv');
  assert.equal(demoProvenance, demoMetadata);
  assert.notEqual(demoMetadata.transformation?.kind, 'SMOOTH_AGE_YEAR_RATE_PERTURBATION_THEN_INTEGER_ROUND');
  assert.equal(demoMetadata.ageGroups.length, 13);
  assert.deepEqual(demoMetadata.ageGroups[0], { midpoint: 32.5, lower: 30, upper: 34 });
  assert.deepEqual(demoMetadata.ageGroups.at(-1), { midpoint: 92.5, lower: 90, upper: 94 });
  assert.deepEqual(demoMetadata.ageGroups.map(group => group.midpoint), result.summary.ages);
  assert.deepEqual(defaultModelSettings, { method: 'nb-reml', draws: 1000, seed: 123, kAge: 10, kYear: 10, threshold: 0.005 });
});

test('the active example preserves every authoritative CSV count and population byte-for-byte', async () => {
  const bytes = await readFile(new URL('../data/example/example_data.csv', import.meta.url));
  const publicBytes = await readFile(new URL('../public/demo/example_data.csv', import.meta.url));
  const expectedHash = '5d2b2edac8329cedf6b2fecb29fbb046b62b892dfba27255c9d4541575a0f46c';
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash);
  assert.equal(demoMetadata.sourceSha256.toLowerCase(), expectedHash);
  assert.deepEqual(publicBytes, bytes, 'The public CSV is a copy, with no rewritten values or line endings.');
  assert.deepEqual(Buffer.from(demoInputCsv, 'utf8'), bytes, 'The bundled CSV used by the example/template download retains every original byte.');
  assert.equal(bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0], '"Year","Age_Group","Count","Pop"');
  const source = parseCsv(bytes.toString('utf8'));
  assert.deepEqual(source.errors, []);
  assert.deepEqual(source.warnings, []);
  assert.equal(source.rows.length, demoRows.length);
  assert.deepEqual(source.summary.sexes, []);
  const values = rows => rows.map(row => ({ Year: row.Year, Age_Mid: row.Age_Mid, Count: row.Deaths, Pop: row.Pop }));
  assert.deepEqual(values(validateRows(demoRows).rows), values(source.rows));
  assert.deepEqual(source.rows.slice(0, 2).map(row => [row.Year, row.Age_Group, row.Deaths, row.Pop]),
    [[1990, '30–34', 134, 2000000], [1990, '35–39', 276, 1721416]]);
  assert.deepEqual(ageGroupsForRows(source.rows), demoMetadata.ageGroups);
});

test('the synthetic example keeps its fixed generation rules and separate coefficient seed', async () => {
  const rulesBytes = await readFile(new URL('../data/example/dgp_fixed_before_sampling.json', import.meta.url));
  const dgp = JSON.parse(rulesBytes.toString('utf8'));
  const expectedRulesHash = '1cfb3c5d9882481393bc420d234656f7839fcca22c22bd71632a991c25ddf735';
  assert.equal(createHash('sha256').update(rulesBytes).digest('hex'), expectedRulesHash);
  assert.equal(demoMetadata.generationRulesSha256, expectedRulesHash);
  assert.deepEqual(demoMetadata.generationRules, dgp);
  assert.equal(dgp.source, 'INDEPENDENT_SYNTHETIC_COUNT_EXPOSURE');
  assert.equal(dgp.version, 'BLSD-INDEPENDENT-SYNTHETIC-20261022-v1');
  assert.equal(dgp.simulated, true);
  assert.equal(dgp.generationSeed, 20261022);
  assert.equal(dgp.coefficientSeed, 123);
  assert.equal(demoMetadata.generationSeed, dgp.generationSeed);
  assert.equal(defaultModelSettings.seed, dgp.coefficientSeed);
  assert.deepEqual(dgp.years, Array.from({ length: 34 }, (_, index) => 1990 + index));
  assert.deepEqual(dgp.ages, Array.from({ length: 13 }, (_, index) => 32.5 + index * 5));
  const fixedParameters = {
    referenceAge: 62.5, ageScale: 30, referenceYear: 2005, timeScale: 15,
    referenceRatePer100000: 250, ageLinear: 3.2, ageQuadratic: -0.9,
    timeLinear: -0.55, ageTimeInteraction: 0.12, timeCubic: 0.08,
    populationBase: 2000000, populationReferenceAge: 32.5, populationAgeSlope: -0.03,
    negativeBinomialSize: 300,
  };
  for (const [name, value] of Object.entries(fixedParameters)) assert.equal(dgp[name], value, name);
  assert.equal(dgp.etaFormula, 'log(250/100000)+3.2*x-0.9*x^2-(0.55-0.12*x)*u+0.08*u^3');
  assert.equal(dgp.x, '(age-62.5)/30');
  assert.equal(dgp.u, '(year-2005)/15');
  assert.equal(dgp.exposureFormula, 'round(2000000*exp(-0.03*(age-32.5)))');
  assert.equal(dgp.countModel, 'NB(mu=Pop*exp(eta), size=300); variance=mu+mu^2/300');
  assert.equal(dgp.rowOrder, 'Ascending year; ascending age within each year');
  assert.equal(dgp.realizations, 1);
  assert.equal(dgp.seedSearch, false);
  assert.equal(dgp.individualCountReplacement, false);
  const source = parseCsv(await readFile(new URL('../data/example/example_data.csv', import.meta.url), 'utf8'));
  assert.deepEqual(source.errors, []);
  for (const [index, row] of source.rows.entries()) {
    assert.equal(row.Year, dgp.years[Math.floor(index / dgp.ages.length)]);
    assert.equal(row.Age_Mid, dgp.ages[index % dgp.ages.length]);
    assert.equal(row.Pop, Math.round(dgp.populationBase * Math.exp(dgp.populationAgeSlope * (row.Age_Mid - dgp.populationReferenceAge))));
  }
});

test('CSV export round trips without changing observations', () => {
  const result = parseCsv(toCsv(demoRows));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, validateRows(demoRows).rows.map(({ Age_Group, ...row }) => row));
});

test('BOM, CRLF, quoted cells and reordered Chinese aliases are accepted', () => {
  const rows = grid();
  const csv = '\uFEFF"死亡数","年份","暴露人口","年龄中点"\r\n' + rows.map(row =>
    `"${row.Deaths}","${row.Year}","${row.Pop}","${row.Age_Mid}"`
  ).join('\r\n');
  const result = parseCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, rows);
});

test('blank lines are ignored and reported CSV row numbers stay accurate', () => {
  const csv = toCsv(grid()).replace('2000,2.5,10,100000', '\r\n2000,2.5,,100000');
  const result = parseCsv(csv);
  assert.ok(result.errors.some(error => error.code === 'MISSING_NUMBER' && error.row === 3 && error.column === 'Count'));
});

test('escaped quotes and commas remain a single cell and fail strict numeric validation', () => {
  const csv = toCsv(grid()).replace('2000,2.5,10,100000', '2000,2.5,"10,""hello""",100000');
  const result = parseCsv(csv);
  assert.ok(codes(result).includes('INVALID_NUMBER'));
  assert.ok(!codes(result).includes('COLUMN_COUNT'));
  assert.ok(!codes(result).includes('INVALID_CSV_QUOTE'));
});

test('line breaks inside quoted cells are parsed without corrupting later rows', () => {
  const csv = toCsv(grid()).replace('2000,2.5,10,100000', '2000,2.5,"10\r\n11",100000');
  const result = parseCsv(csv);
  assert.ok(codes(result).includes('INVALID_NUMBER'));
  assert.equal(result.rows.length, 24);
  assert.ok(!codes(result).includes('COLUMN_COUNT'));
});

test('malformed quotes and extra or missing columns are rejected', () => {
  assert.ok(codes(parseCsv('Year,Age_Mid,Deaths,Pop\n2000,2.5,"10,100000')).includes('UNCLOSED_CSV_QUOTE'));
  assert.ok(codes(parseCsv('Year,Age_Mid,Deaths,Pop\n2000,2.5,"10"abc,100000')).includes('INVALID_CSV_QUOTE'));
  assert.ok(codes(parseCsv(toCsv(grid()).replace('2000,2.5,10,100000', '2000,2.5,10'))).includes('COLUMN_COUNT'));
  assert.ok(codes(parseCsv('Year,Age_Mid,Deaths,Pop,Country\n2000,2.5,10,100000,CN')).includes('UNKNOWN_COLUMN'));
  assert.ok(codes(parseCsv('Year,Age_Mid,Deaths,Deaths\n2000,2.5,10,100000')).includes('DUPLICATE_COLUMN'));
  assert.ok(codes(parseCsv('Year,Age_Mid,Deaths\n2000,2.5,10')).includes('MISSING_COLUMN'));
});

test('empty data and header-only files cannot proceed', () => {
  for (const source of ['', '\uFEFF\r\n', 'Year,Age_Mid,Deaths,Pop\r\n']) {
    assert.ok(codes(parseCsv(source)).includes('EMPTY_DATA'));
  }
  assert.ok(codes(validateRows([])).includes('EMPTY_DATA'));
});

test('missing, non-finite, malformed, boolean and open-ended age values are rejected', () => {
  for (const value of ['', ' ', null, undefined, 'Infinity', Infinity, '-Infinity', NaN, 'NaN', '1,000', '10abc', '0x10', '85+', true, {}, '1e999']) {
    const rows = grid();
    rows[0].Age_Mid = value;
    const result = validateRows(rows);
    assert.ok(result.errors.some(error => error.column === 'Age_Mid'), `Expected rejection for ${String(value)}`);
  }
});

test('finite decimal and scientific numeric strings normalize strictly', () => {
  const rows = grid();
  rows[0] = { Year: '2e3', Age_Mid: ' +2.5 ', Deaths: '1e1', Pop: '1.0e5' };
  const result = validateRows(rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows[0], grid()[0]);
});

test('negative counts, zero exposure and negative exposure are rejected', () => {
  for (const [column, value, code] of [['Deaths', -1, 'NEGATIVE_DEATHS'], ['Pop', 0, 'NON_POSITIVE_POP'], ['Pop', -1, 'NON_POSITIVE_POP']]) {
    const rows = grid();
    rows[0][column] = value;
    assert.ok(codes(validateRows(rows)).includes(code));
  }
  const rows = grid();
  rows[0].Deaths = 0;
  assert.deepEqual(validateRows(rows).errors, []);
});

test('duplicate year and age pairs are rejected after numeric normalization', () => {
  const rows = grid();
  rows.push({ ...rows[0], Year: '2000', Age_Mid: '2.50' });
  const result = validateRows(rows);
  assert.equal(result.rows.length, 25);
  assert.ok(result.errors.some(error => error.code === 'DUPLICATE_YEAR_AGE' && error.row === 27));
});

test('five distinct years and ages are both required', () => {
  assert.ok(codes(validateRows(grid().filter(row => row.Year < 2004))).includes('TOO_FEW_YEARS'));
  assert.ok(codes(validateRows(grid().filter(row => row.Age_Mid < 22.5))).includes('TOO_FEW_AGES'));
});

test('fractional count estimates retain precision while incomplete grids still warn', () => {
  const rows = grid().slice(1);
  rows[0].Deaths = 10.5;
  const result = validateRows(rows);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 24);
  assert.equal(result.rows[0].Deaths, 10.5);
  assert.deepEqual(result.warnings.map(warning => warning.code), ['INCOMPLETE_GRID']);
  for (const warning of result.warnings) {
    assert.ok('row' in warning && 'column' in warning && 'message' in warning);
  }
});

test('CSV writer quotes and escapes arbitrary cells safely', () => {
  assert.equal(toCsv([{ Year: 'a,b', Age_Mid: 'a"b', Deaths: 'a\nb', Pop: null }]),
    'Year,Age_Mid,Deaths,Pop\r\n"a,b","a""b","a\nb",');
});

test('download helper clearly requires a browser environment', () => {
  assert.throws(() => downloadFile('demo.csv', 'data'), /only in a browser/);
});

test('optional Sex CSV preserves decimals and isolates Both, Male and Female grids', () => {
  const rows = ['Both', 'Male', 'Female'].flatMap(Sex => grid().map(row => ({ ...row, Deaths: row.Deaths + 0.125, Sex })));
  const result = parseCsv(toCsv(rows));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.rows, rows);
  assert.deepEqual(result.summary.sexes, ['Both', 'Male', 'Female']);
  assert.equal(result.summary.groupCount, 3);
  assert.deepEqual(result.groups.map(group => group.summary.count), [25, 25, 25]);
  assert.deepEqual(groupRows(result.rows, 'Male'), rows.filter(row => row.Sex === 'Male'));
  assert.deepEqual(filterRowsBySex(result.rows, 'Both'), rows.filter(row => row.Sex === 'Both'));
  assert.ok(!result.warnings.some(warning => warning.code === 'INCOMPLETE_GRID'));
});

test('Sex labels trim, accept local labels and aliases, and reject blank values', () => {
  const csv = '年份,年龄中点,死亡数,人口数,性别\n' + grid().map(row => `${row.Year},${row.Age_Mid},${row.Deaths},${row.Pop}, 女性 `).join('\n');
  const result = parseCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.summary.sexes, ['女性']);
  assert.ok(result.rows.every(row => row.Sex === '女性'));
  const blank = csv.replace(', 女性 ', ',');
  assert.ok(codes(parseCsv(blank)).includes('MISSING_SEX'));
});

test('duplicates remain errors only within the same sex group', () => {
  const rows = ['Both', 'Male'].flatMap(Sex => grid().map(row => ({ ...row, Sex })));
  assert.deepEqual(validateRows(rows).errors, []);
  rows.push({ ...rows[0] });
  assert.ok(codes(validateRows(rows)).includes('DUPLICATE_YEAR_AGE'));
});

test('minimum domain and missing cells are checked separately for each sex', () => {
  const complete = grid().map(row => ({ ...row, Sex: 'Both' }));
  const short = grid().filter(row => row.Year < 2004).map(row => ({ ...row, Sex: 'Female' }));
  assert.ok(codes(validateRows([...complete, ...short])).includes('TOO_FEW_YEARS'));
  const incomplete = grid().slice(1).map(row => ({ ...row, Sex: 'Male' }));
  assert.ok(validateRows([...complete, ...incomplete]).warnings.some(warning => warning.code === 'INCOMPLETE_GRID'));
});

test('four-column input remains a single unlabelled group; mixed labelled/unlabelled rows fail', () => {
  const rows = grid();
  assert.equal(sexGroups(rows).length, 1);
  assert.equal(sexGroups(rows)[0].sex, null);
  assert.deepEqual(groupRows(rows), rows);
  assert.deepEqual(groupRows(rows, ''), rows);
  assert.equal(toCsv(rows).split('\r\n')[0], 'Year,Age_Mid,Deaths,Pop');
  rows[0] = { ...rows[0], Sex: 'Both' };
  assert.ok(codes(validateRows(rows)).includes('MISSING_SEX'));
});

test('closed age labels accept hyphens, en dashes, spaces and only the requested years or 岁 suffixes', () => {
  for (const value of ['30–34', '30-34', ' 30 – 34 ', '30-34 years', '30-34years', '30–34 岁', '30–34岁', '30 – 34 YEARS', '030–034']) {
    assert.deepEqual(parseAgeGroup(value), { lower: 30, upper: 34, midpoint: 32.5, label: '30–34' }, value);
  }
  assert.deepEqual(parseAgeGroup('0–0'), { lower: 0, upper: 0, midpoint: 0.5, label: '0–0' });
  assert.equal(parseAgeGroup('30–39').midpoint, 35);
  assert.equal(parseAgeGroup('120–124').midpoint, 122.5);
  for (const value of ['', ' ', null, undefined, 32.5, true, {}, '30', '30+', '95+', '30–', '-1–4', '34–30', '30.5–34.5', '30–34 year', '30–34岁岁', '30—34', '30～34', '30 to 34', '30–34years old', '30–34.0', '1e1–14', '0x10–20', '9007199254740992–9007199254740993', '9007199254740991–9007199254740991']) {
    assert.equal(parseAgeGroup(value), null, String(value));
  }
});

test('new four-column CSV converts actual age bands to the same numerical observations as legacy input', () => {
  const csv = toInputCsv(closedGrid());
  assert.equal(csv.split('\r\n')[0], 'Year,Age_Group,Count,Pop');
  const result = parseCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.rows.map(({ Age_Group, ...row }) => row), grid());
  assert.ok(result.rows.every(row => parseAgeGroup(row.Age_Group).midpoint === row.Age_Mid));
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].sex, null);
  assert.deepEqual(parseCsv(toInputCsv(result.rows)).rows, result.rows);
});

test('age-group aliases and mixed suffixes preserve count/exposure precision and isolate sex groups', () => {
  const forms = ['0-4 years', '5–9岁', '10-14years', '15–19 岁', '20–24'];
  const rows = ['Male', 'Female'].flatMap(Sex => closedGrid().map((row, index) => ({ ...row, Age_Group: forms[index % 5], Deaths: row.Deaths + 0.125, Pop: row.Pop + 0.0625, Sex })));
  const csv = '\uFEFF"性别","人口数","年龄段","年份","死亡数"\r\n' + rows.map(row =>
    `"${row.Sex}","${row.Pop}","${row.Age_Group}","${row.Year}","${row.Deaths}"`
  ).join('\r\n');
  const result = parseCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.summary.sexes, ['Male', 'Female']);
  assert.deepEqual(result.groups.map(group => group.summary.count), [25, 25]);
  assert.ok(result.rows.every((row, index) => row.Deaths === rows[index].Deaths && row.Pop === rows[index].Pop));
  assert.deepEqual(result.rows.map(row => row.Age_Mid), [...grid(), ...grid()].map(row => row.Age_Mid));
  assert.ok(result.rows.every(row => !row.Age_Group.includes('years') && !row.Age_Group.includes('岁')));
  const blankSex = csv.replace('"Male"', '""');
  assert.ok(codes(parseCsv(blankSex)).includes('MISSING_SEX'));
});

test('missing, malformed and open age bands fail actionably without falling back to numeric Age_Mid', () => {
  for (const value of ['', ' ', null, undefined, '95+', '30.5–34.5', '34–30', '30—34', true]) {
    const rows = closedGrid();
    rows[0] = { ...rows[0], Age_Group: value, Age_Mid: 2.5 };
    const result = validateRows(rows);
    assert.ok(result.errors.some(error => error.column === 'Age_Group' && error.row === 2), String(value));
    assert.equal(result.rows.length, 24);
  }
  for (const source of ['Year,Age_Group,Deaths,Pop\r\n', 'Year,Age_Group,Deaths,Pop\r\n2000,,10,100000', 'Year,Deaths,Pop\r\n2000,10,100000']) {
    assert.ok(parseCsv(source).errors.length > 0);
  }
  const mixed = closedGrid();
  mixed[0] = grid()[0];
  assert.ok(codes(validateRows(mixed)).includes('MISSING_AGE_GROUP'));
});

test('supplied Age_Group and Age_Mid must agree exactly while numeric-only legacy inputs remain accepted', () => {
  const rows = closedGrid().map((row, index) => ({ ...row, Age_Mid: grid()[index].Age_Mid }));
  assert.deepEqual(validateRows(rows).errors, []);
  rows[0].Age_Mid = 2;
  assert.ok(codes(validateRows(rows)).includes('INCONSISTENT_AGE_MID'));
  rows[0].Age_Mid = '2.50';
  assert.deepEqual(validateRows(rows).errors, []);
  rows[0].Age_Mid = '';
  assert.ok(codes(validateRows(rows)).includes('MISSING_NUMBER'));
  assert.deepEqual(parseCsv(toCsv(grid())).errors, []);
});

test('canonical labels detect same-group duplicates across suffix and dash variants', () => {
  const rows = closedGrid();
  rows.push({ ...rows[0], Age_Group: '00 - 04years' });
  const result = validateRows(rows);
  assert.equal(result.rows.length, 25);
  assert.ok(result.errors.some(error => error.code === 'DUPLICATE_YEAR_AGE' && error.column === 'Year / Age_Group' && error.row === 27));
  const grouped = ['Male', 'Female'].flatMap(Sex => closedGrid().map(row => ({ ...row, Sex })));
  assert.deepEqual(validateRows(grouped).errors, []);
});

test('age domains require consistent non-overlapping ranges within each sex and allow adjacent or different sex domains', () => {
  const inconsistent = closedGrid();
  inconsistent[5].Age_Group = '1–3';
  assert.ok(codes(validateRows(inconsistent)).includes('INCONSISTENT_AGE_GROUP'));
  const overlapping = closedGrid();
  overlapping[1].Age_Group = '4–8';
  assert.ok(codes(validateRows(overlapping)).includes('OVERLAPPING_AGE_GROUPS'));
  assert.deepEqual(validateRows(closedGrid()).errors, []);
  const independent = [
    ...closedGrid().map(row => ({ ...row, Sex: 'Male' })),
    ...closedGrid().map(row => {
      const bounds = parseAgeGroup(row.Age_Group);
      return { ...row, Age_Group: `${bounds.lower + 1}–${bounds.upper + 1}`, Sex: 'Female' };
    }),
  ];
  assert.deepEqual(validateRows(independent).errors, []);
});

test('minimum domain and incomplete grid validation use derived model ages without inventing missing cells', () => {
  assert.ok(codes(validateRows(closedGrid().filter(row => row.Year < 2004))).includes('TOO_FEW_YEARS'));
  assert.ok(codes(validateRows(closedGrid().filter(row => row.Age_Group !== '20–24'))).includes('TOO_FEW_AGES'));
  const result = validateRows(closedGrid().slice(1));
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 24);
  assert.ok(result.warnings.some(warning => warning.code === 'INCOMPLETE_GRID' && warning.column === 'Year / Age_Group'));
});

test('metadata and user CSV serialization preserve true bounds and never infer an age band from a midpoint', () => {
  const rows = validateRows(closedGrid()).rows;
  const expected = Array.from({ length: 5 }, (_, index) => ({ midpoint: 2.5 + index * 5, lower: index * 5, upper: index * 5 + 4 }));
  assert.deepEqual(ageGroupsForRows(rows.reverse()), expected);
  assert.deepEqual(ageGroupsForRows(grid()), []);
  assert.deepEqual(parseCsv(toInputCsv(grid(), expected)).rows.map(({ Age_Group, ...row }) => row), grid());
  assert.equal(toInputCsv(grid()), toCsv(grid()).replace('Year,Age_Mid,Deaths,Pop', 'Year,Age_Mid,Count,Pop'));
  assert.equal(toInputCsv(grid(), expected.slice(1)), toInputCsv(grid()));
  assert.equal(toInputCsv([]), 'Year,Age_Group,Count,Pop');
  const labelled = ['A,"quoted"', 'Female'].flatMap(Sex => closedGrid().map(row => ({ ...row, Sex })));
  assert.deepEqual(parseCsv(toInputCsv(labelled)).summary.sexes, ['A,"quoted"', 'Female']);
});

test('known example age bounds change the template column without changing any observations or numerical model inputs', () => {
  const source = parseCsv(toCsv(demoRows));
  const csv = toInputCsv(demoRows, demoMetadata.ageGroups);
  assert.ok(/^[\x00-\x7F]*$/.test(csv), 'example CSV must remain readable without Unicode age units or delimiters');
  assert.ok(csv.split('\r\n').slice(1).every(line => /^\d+-\d+$/.test(line.split(',')[1])));
  const input = parseCsv(csv);
  assert.deepEqual(input.errors, []);
  assert.deepEqual(input.warnings, []);
  assert.deepEqual(input.rows.map(({ Age_Group, ...row }) => row), source.rows);
  assert.deepEqual(ageGroupsForRows(input.rows), demoMetadata.ageGroups);
  assert.equal(input.rows[0].Age_Group, '30–34');
  assert.equal(input.rows.at(-1).Age_Group, '90–94');
});
