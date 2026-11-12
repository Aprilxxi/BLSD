import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { resultWorkbook } from '../server/results-workbook.mjs';

function unzip(bytes) {
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString('utf8');
    const start = offset + 30 + length + extra;
    files.set(name, inflateRawSync(bytes.subarray(start, start + size)).toString('utf8'));
    offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  return files;
}

function fixture() {
  const sex = '=2+2<&"\' _x0041_';
  const rate = 1.2345678901234567;
  return {
    schemaVersion: '1', fitId: '=unsafe<&>', meta: { sex, fitted: true }, settings: { seed: 0 },
    diagnostics: { converged: false, devianceExplained: 0.9996191575767747, smoothTests: [{ term: 'te(Year,Age_Mid)', pValue: 0 }] },
    input: [{ Year: 2000, Age_Mid: 32.5, Age_Group: '30–34', Count: 0.125, Pop: 10.5, Sex: sex }],
    points: [{ year: 2000, age: 32.5, rate, surface: -4.394449154672439, annual: 0,
      acceleration: null, gradient: -0.000000000123456789, shift: null,
      intervals: { rate: [0.125, 3.141592653589793], surface: [-5, -4], annual: [0, 0], acceleration: null, gradient: [-0.1, 0.1], shift: null },
      raw: { rate, surface: -4.394449154672439, annual: 0, acceleration: 0, gradient: -0.000000000123456789, shift: -0.12345678901234567 },
      rawIntervals: { rate: [0.125, 3.141592653589793], surface: [-5, -4], annual: [0, 0], acceleration: [0, 0], gradient: [-0.1, 0.1], shift: [-0.5, 0.5] },
      metricMasks: { rate: false, surface: false, annual: false, acceleration: true, gradient: false, shift: true },
      metricMaskReasons: { acceleration: 'NATURAL_SPLINE_BOUNDARY', shift: 'UNSTABLE_AGE_GRADIENT' },
      metricValidFractions: { rate: 1, surface: 1, annual: 1, acceleration: 1, gradient: 1, shift: 0.75 },
    }],
    residuals: [{ year: 2000, age: 32.5, count: 0.125, pop: 10.5, fittedCount: 0.12, devianceResidual: -0.02 }],
    cohortSmooth: [{ cohort: 1967.5, estimate: 0, lower95: -0.1, upper95: 0.1 }],
    contours: { rate: [{ level: 1.5, points: [[2000, 32.5], [2001, 33.5]] }] },
    provenance: { filename: '@source.csv', details: undefined },
  };
}

const sheet = (files, index) => files.get(`xl/worksheets/sheet${index}.xml`);
function cell(xml, ref) { return xml.match(new RegExp(`<c r="${ref}"[^>]*>.*?</c>`))?.[0]; }

test('XLSX package has valid workbook relationships and nine focused, localized, legal worksheet names', () => {
  const english = unzip(resultWorkbook(fixture(), 'en'));
  assert.match(english.get('docProps/core.xml'), /<dc:creator>BLSD Tool<\/dc:creator>/);
  assert.match(english.get('docProps/app.xml'), /<Application>BLSD Tool<\/Application>/);
  for (const path of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'docProps/core.xml', 'docProps/app.xml']) assert.ok(english.has(path), path);
  const names = [...english.get('xl/workbook.xml').matchAll(/<sheet name="([^"]+)"/g)].map(match => match[1]);
  assert.equal(names.length, 9);
  assert.deepEqual(names.slice(0, 1), ['Overview']);
  assert.deepEqual(names.slice(2, 7), ['Fitted rate', 'Annual rate change', 'Log-rate acceleration', 'Age gradient', 'Equivalent age shift']);
  assert.equal(names[8], 'Field dictionary');
  assert.ok(!names.includes('Raw values and screening'));
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length);
  for (const name of names) { assert.ok(name.length <= 31); assert.doesNotMatch(name, /[\\/*?:\[\]]/); }
  for (let index = 1; index <= names.length; index++) {
    assert.ok(english.has(`xl/worksheets/sheet${index}.xml`));
    assert.ok(english.get('xl/_rels/workbook.xml.rels').includes(`Target="worksheets/sheet${index}.xml"`));
    assert.ok(english.get('[Content_Types].xml').includes(`PartName="/xl/worksheets/sheet${index}.xml"`));
  }
  const chinese = unzip(resultWorkbook(fixture(), 'zh'));
  assert.match(chinese.get('docProps/core.xml'), /<dc:creator>BLSD Tool<\/dc:creator>/);
  assert.match(chinese.get('docProps/app.xml'), /<Application>BLSD Tool<\/Application>/);
  assert.match(chinese.get('xl/workbook.xml'), /name="概览"/);
  assert.match(chinese.get('xl/workbook.xml'), /name="拟合率"/);
  assert.match(chinese.get('xl/workbook.xml'), /name="等效年龄移动速度"/);
  assert.doesNotMatch(chinese.get('xl/workbook.xml'), /name="原始值与筛选"/);
  assert.match(sheet(chinese, 3), /时期/);
  assert.match(sheet(english, 3), /Period/);
});

test('all values use real Excel scalar types, keep full decimal precision and distinguish blank, zero and false', () => {
  const result = fixture(), original = structuredClone(result);
  const files = unzip(resultWorkbook(result));
  const rate = sheet(files, 3), annual = sheet(files, 4), acceleration = sheet(files, 5), shift = sheet(files, 7);
  assert.match(cell(rate, 'D2'), /t="n"><v>1\.2345678901234567<\/v>/);
  assert.match(cell(rate, 'B2'), /t="n"><v>2000<\/v>/);
  assert.match(cell(rate, 'E2'), /t="n"><v>0\.125<\/v>/);
  assert.match(cell(rate, 'F2'), /t="n"><v>3\.141592653589793<\/v>/);
  assert.match(cell(annual, 'D2'), /t="n"><v>0<\/v>/);
  assert.equal(cell(acceleration, 'D2'), undefined);
  assert.equal(cell(acceleration, 'E2'), undefined);
  assert.equal(cell(shift, 'D2'), undefined);
  assert.match(cell(sheet(files, 2), 'G2'), /t="n"><v>0\.125<\/v>/);
  assert.match(sheet(files, 1), /t="b"><v>0<\/v>/);
  assert.match(sheet(files, 1), /<v>0\.9996191575767747<\/v>/);
  assert.match(cell(acceleration, 'H2'), /Screened/);
  assert.match(cell(acceleration, 'I2'), /Period boundary/);
  assert.match(cell(shift, 'I2'), /Unstable age gradient/);
  assert.match(cell(rate, 'H2'), /Available/);
  assert.deepEqual(result, original);
});

test('fitted-rate sheets append retained ln-rate centres, intervals and localized units at matching year-age coordinates', () => {
  const result = fixture();
  // Deliberately unlike log(rate), and with repeated years and ages: the
  // workbook must use the retained surface at the full coordinate pair.
  result.points = [
    { year: 2001, age: 42.5, rate: 2, surface: -1.2345678901234567,
      intervals: { rate: [1, 3], surface: [-2.345678901234567, -0.012345678901234567] } },
    { year: 2000, age: 42.5, rate: 4, surface: 0,
      intervals: { rate: [2, 6], surface: [-0.125, 0.25] } },
    { year: 2001, age: 32.5, rate: 8, surface: null,
      intervals: { rate: [4, 12], surface: [null, 0] },
      raw: { surface: 123 }, rawIntervals: { surface: [100, 150] } },
    { year: 2000, age: 32.5, rate: 16, surface: 9.876543210987654,
      intervals: { rate: [8, 24], surface: [8.765432109876543, null] } },
  ];
  const original = structuredClone(result);
  const expected = [
    [2001, 42.5, 2, 1, 3, -1.2345678901234567, -2.345678901234567, -0.012345678901234567],
    [2000, 42.5, 4, 2, 6, 0, -0.125, 0.25],
    [2001, 32.5, 8, 4, 12, null, null, 0],
    [2000, 32.5, 16, 8, 24, 9.876543210987654, 8.765432109876543, null],
  ];
  for (const locale of ['en', 'zh']) {
    const files = unzip(resultWorkbook(result, locale)), rate = sheet(files, 3);
    assert.match(rate, /<dimension ref="A1:M5"/);
    for (const [column, label] of locale === 'zh'
      ? [['J', 'ln率'], ['K', 'ln率95% UI下限'], ['L', 'ln率95% UI上限'], ['M', 'ln率单位']]
      : [['J', 'ln rate'], ['K', 'ln rate 95% UI lower'], ['L', 'ln rate 95% UI upper'], ['M', 'ln rate unit']]) {
      assert.ok(cell(rate, `${column}1`).includes(`<t xml:space="preserve">${label}</t>`));
    }
    expected.forEach((values, index) => {
      const row = index + 2;
      ['B', 'C', 'D', 'E', 'F', 'J', 'K', 'L'].forEach((column, valueIndex) => {
        const ref = `${column}${row}`, value = values[valueIndex];
        if (value === null) assert.equal(cell(rate, ref), undefined, `${locale}: ${ref} stays blank`);
        else assert.ok(cell(rate, ref)?.includes(`t="n"><v>${String(value)}</v>`), `${locale}: ${ref} retains ${value}`);
      });
      const unit = locale === 'zh' ? 'ln(每10万人率)' : 'ln(rate per 100000)';
      assert.ok(cell(rate, `M${row}`)?.includes(`<t xml:space="preserve">${unit}</t>`));
      assert.ok(cell(rate, `G${row}`)?.includes(locale === 'zh' ? '每10万人' : 'per 100000'));
    });
    assert.match(sheet(files, 9), /ln_rate/);
  }
  assert.deepEqual(result, original);
});

test('source strings are inert inline text and XML special characters and OOXML escapes remain literal', () => {
  const files = unzip(resultWorkbook(fixture()));
  const rate = sheet(files, 3);
  assert.match(cell(rate, 'A2'), /t="inlineStr"/);
  assert.match(rate, /=2\+2&lt;&amp;&quot;&apos;/);
  assert.match(rate, /_x005F_x0041_/);
  for (const content of files.values()) {
    assert.doesNotMatch(content, /<f(?:\s|>)/);
    assert.doesNotMatch(content, /<externalLink|<hyperlink|<oleObject|<vbaProject/);
  }
  assert.doesNotMatch(files.get('xl/_rels/workbook.xml.rels'), /TargetMode="External"/);
});

test('missing source coordinates remain blank and control characters use valid OOXML text escapes', () => {
  const result = fixture();
  delete result.meta.sex;
  result.input[0].Sex = undefined;
  result.input[0].Age_Group = null;
  result.fitId = 'tabs\tnewlines\nreturn\rcontrol\u0001';
  const files = unzip(resultWorkbook(result));
  assert.equal(cell(sheet(files, 3), 'A2'), undefined);
  assert.equal(cell(sheet(files, 2), 'C2'), undefined);
  assert.ok(sheet(files, 1).includes('tabs\tnewlines\nreturn_x000D_control_x0001_'));
  assert.doesNotMatch(sheet(files, 1), /[\u0000-\u0008\u000b-\u001f]/);
});

test('all worksheets contain plain cells with no custom formatting, sizes, filtering, panes or print settings', () => {
  for (const locale of ['en', 'zh']) {
    const files = unzip(resultWorkbook(fixture(), locale));
    assert.equal(files.has('xl/styles.xml'), false);
    assert.doesNotMatch(files.get('[Content_Types].xml'), /styles/);
    assert.doesNotMatch(files.get('xl/_rels/workbook.xml.rels'), /styles/);
    for (let index = 1; index <= 9; index++) {
      const content = sheet(files, index);
      assert.match(content, /<row r="1">/);
      assert.match(content, /<c r="A1" t="inlineStr">/);
      assert.doesNotMatch(content, /<c\b[^>]*\ss=/);
      assert.doesNotMatch(content, /<row\b[^>]*(?:ht|customHeight|s|customFormat)=/);
      assert.doesNotMatch(content, /<(?:styleSheet|numFmts?|fonts?|fills?|borders?|cols?|sheetPr|sheetFormatPr|sheetViews?|pane|selection|autoFilter|pageSetup|pageSetUpPr|pageMargins|printOptions|conditionalFormatting|mergeCells?|tableParts?)\b/);
    }
    assert.match(sheet(files, 3), /<dimension ref="A1:M2"/);
  }
});

test('overview uses everyday labels and units; advanced raw information has a clear archive destination', () => {
  const files = unzip(resultWorkbook(fixture(), 'zh'));
  assert.match(sheet(files, 1), /随机种子/);
  assert.match(sheet(files, 1), /系数抽样次数/);
  assert.match(sheet(files, 1), /偏差解释率/);
  assert.match(sheet(files, 1), /平滑项检验P/);
  assert.match(sheet(files, 1), /不受当前图表筛选或曲线勾选限制/);
  assert.match(sheet(files, 1), /按时期或年龄筛选/);
  assert.match(sheet(files, 9), /原始值、原始区间、原始导数、等高线/);
  assert.match(sheet(files, 9), /fit\.rds/);
  assert.match(cell(sheet(files, 3), 'G2'), /每10万人/);
  assert.match(cell(sheet(files, 4), 'G2'), /%\/年/);
  assert.match(cell(sheet(files, 5), 'G2'), /对数率\/年²/);
  assert.match(cell(sheet(files, 6), 'G2'), /%\/岁/);
  assert.match(cell(sheet(files, 7), 'G2'), /岁\/年/);
  assert.match(cell(sheet(files, 5), 'H2'), /已屏蔽/);
  assert.match(cell(sheet(files, 5), 'I2'), /时期边界/);
  assert.doesNotMatch(sheet(files, 1), /covarianceMinimumEigenvalue|maskedShiftPoints|defaultSectionYears/);
  assert.match(sheet(files, 1), /95% UI/);
});

test('empty result tables remain valid, named worksheets with complete headers and no fabricated values', () => {
  const files = unzip(resultWorkbook({}));
  assert.match(sheet(files, 3), /<dimension ref="A1:M1"/);
  assert.doesNotMatch(sheet(files, 3), /<autoFilter\b/);
  assert.equal([...sheet(files, 3).matchAll(/<row /g)].length, 1);
  assert.doesNotMatch(sheet(files, 3), /NaN|undefined|Infinity|\[object Object\]/);
});
