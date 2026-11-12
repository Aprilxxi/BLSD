import { zipFiles } from './results-download.mjs';
import { readableResultTables } from './readable-results.mjs';

// SpreadsheetML uses typed cells and relationships between the workbook and
// worksheet parts. Text is always inlineStr, never a formula. No formatting is added.
// https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document
// https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cell
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const METRICS = {
  rate: ['拟合率', 'Fitted rate'],
  annual: ['年变化率', 'Annual rate change'],
  acceleration: ['对数率加速度', 'Log-rate acceleration'],
  gradient: ['年龄梯度', 'Age gradient'],
  shift: ['等效年龄移动速度', 'Equivalent age shift'],
};
const ZH_UNITS = new Map([
  ['per 100000', '每10万人'], ['%/year', '%/年'], ['%/age-year', '%/岁'],
  ['age-years/year', '岁/年'], ['ln(rate per 100000)', 'ln(每10万人率)'],
  ['log-rate/year', '对数率/年'], ['log-rate/year^2', '对数率/年²'],
  ['log-rate/age-year', '对数率/岁'], ['deviance residual', '偏差残差'],
]);
const MASK_REASONS = new Map([
  ['NATURAL_SPLINE_BOUNDARY', ['时期边界', 'Period boundary']],
  ['UNSTABLE_AGE_GRADIENT', ['年龄梯度不稳定', 'Unstable age gradient']],
  ['NON_FINITE_RATIO', ['抽样比值非有限', 'Non-finite draw ratio']],
]);
const METHOD_NAMES = new Map([
  ['quasi-gcv', ['准泊松 + GCV', 'Quasi-Poisson + GCV']],
  ['quasi-reml', ['准泊松 + REML', 'Quasi-Poisson + REML']],
  ['nb-reml', ['负二项 + REML', 'Negative binomial + REML']],
]);

function overviewTable(result, catalog, zh) {
  const rows = [], text = (chinese, english) => zh ? chinese : english;
  const add = (section, item, value, unit = null) => rows.push({ section, item, value, unit });
  const identity = text('分析范围', 'Analysis scope'), model = text('模型参数', 'Model settings');
  const diagnostics = result.diagnostics ?? {}, settings = result.settings ?? {}, input = catalog.get('input').rows;
  add(identity, text('性别', 'Sex'), result.meta?.sex ?? result.input?.[0]?.Sex ?? null);
  add(identity, text('观测记录数', 'Observation count'), diagnostics.n ?? input.length);
  const range = key => {
    const numbers = input.map(row => row[key]).filter(value => typeof value === 'number' && Number.isFinite(value));
    if (!numbers.length) return null;
    const bounds = numbers.reduce(([low, high], value) => [Math.min(low, value), Math.max(high, value)], [Infinity, -Infinity]);
    return bounds[0] === bounds[1] ? String(bounds[0]) : `${bounds[0]}–${bounds[1]}`;
  };
  add(identity, text('观测时期范围', 'Observed period range'), range('year'));
  add(identity, text('观测年龄范围', 'Observed age range'), range('age'));
  const method = settings.method ?? diagnostics.method;
  add(model, text('拟合方法', 'Fitting method'), METHOD_NAMES.get(method)?.[zh ? 0 : 1] ?? method ?? null);
  for (const [key, chinese, english, unit] of [
    ['draws', '系数抽样次数', 'Coefficient draws'], ['seed', '随机种子', 'Random seed'],
    ['kAge', '年龄基维度', 'Age basis dimension'], ['kYear', '时期基维度', 'Period basis dimension'],
    ['threshold', '对数率年龄梯度阈值', 'Log-rate age-gradient threshold', zh ? '1/岁' : '1/age-year'],
  ]) add(model, text(chinese, english), settings[key] ?? null, unit);
  const fit = text('拟合信息', 'Fit summary');
  for (const [key, chinese, english] of [
    ['converged', '已收敛', 'Converged'], ['edf', '有效自由度', 'Effective degrees of freedom'],
    ['devianceExplained', '偏差解释率', 'Deviance explained'],
    ['scale', '离散尺度估计', 'Estimated dispersion'], ['theta', '负二项分布参数', 'Negative binomial theta'],
    ['residualDf', '残差自由度', 'Residual degrees of freedom'], ['warningCount', '拟合警告数', 'Fit warning count'],
  ]) if (Object.hasOwn(diagnostics, key)) add(fit, text(chinese, english), diagnostics[key]);
  for (const [key, chinese, english] of [
    ['smoothTests', '平滑项检验P', 'Smooth-term P'], ['basisChecks', '基维度检验P', 'Basis-check P'],
  ]) {
    const entries = diagnostics[key] == null ? [] : Array.isArray(diagnostics[key]) ? diagnostics[key] : [diagnostics[key]];
    for (const entry of entries) add(fit, `${text(chinese, english)}${entry.term ? ` · ${entry.term}` : ''}`, entry.pValue ?? null);
  }
  const notes = text('阅读说明', 'Reading notes');
  add(notes, text('表格范围', 'Workbook scope'), text(
    '本表包含当前性别的全部可用坐标，不受当前图表筛选或曲线勾选限制。',
    'The workbook includes every available coordinate for the current sex, regardless of current chart filters or selected curves.'));
  add(notes, text('年龄截面与时间趋势', 'Age sections and time trends'), text(
    '在拟合率表按时期或年龄筛选，即可读取年龄截面或分年龄趋势。',
    'Filter the Fitted rate sheet by Period or Age to read age sections or age-specific time trends.'));
  add(notes, text('拟合曲面的ln率', 'Fitted-surface ln rate'), text(
    '拟合率表同时列出每10万人率、ln率及各自95% UI。ln率直接取同一坐标的保留拟合曲面数据，定义为ln(每10万人率)，与网页及下载拟合曲面的色标一致。',
    'The Fitted rate sheet includes rate per 100,000, ln rate and their respective 95% UI. Ln rate comes directly from the retained fitted surface at the same coordinates, defined as ln(rate per 100,000), matching the webpage and downloaded fitted-surface colour scales.'));
  const ui = catalog.get('analysis_summary').rows.find(row => row.item === '95% UI');
  if (ui) add(notes, '95% UI', ui.value);
  add(notes, text('空值和状态', 'Blank values and status'), text(
    '空值不是零。状态和屏蔽原因单独列出；原始值及原始区间保存在完整分析归档。',
    'A blank is not zero. Status and screening reasons are separate columns; raw values and intervals are in the complete analysis archive.'));
  add(notes, text('高级数据与复现', 'Advanced data and reproducibility'), text(
    '原始值、原始导数、等高线、出生时期残差平滑及模型抽样保存在完整分析归档中。',
    'Raw values, raw derivatives, contour vertices, cohort residual smooth and model draws are in the complete analysis archive.'));
  add(notes, text('拟合标识', 'Fit ID'), result.fitId ?? result.meta?.fitId ?? null);
  return { ...catalog.get('analysis_summary'), key: 'analysis_summary', name: text('概览', 'Overview'), rows };
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function textXml(value) {
  // Preserve literal OOXML escape sequences and XML-disallowed control codes.
  // Excel decodes _xHHHH_ escapes inside string values after parsing the XML.
  const safe = String(value).replace(/_x[\da-f]{4}_/gi, match => `_x005F_${match.slice(1)}`)
    .replace(/[\u0000-\u0008\u000b-\u001f\ufffe\uffff]/g,
      character => `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
    .toWellFormed();
  if (String(value).length > 32767) throw new RangeError('A result text value exceeds the Excel cell limit of 32767 characters. Use the complete analysis archive for this result.');
  return xml(safe);
}

function columnAddress(index) {
  let name = '';
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) name = String.fromCharCode(65 + (number - 1) % 26) + name;
  return name;
}

function safeSheetNames(sheets) {
  const used = new Set();
  return sheets.map(sheet => {
    const base = String(sheet.name || 'Results').replace(/[\\/*?:\[\]\u0000-\u001f]/g, ' ').replace(/^'+|'+$/g, '').trim() || 'Results';
    let name = base.slice(0, 31).toWellFormed(), suffix = 1;
    while (used.has(name.toLowerCase())) {
      const ending = ` (${++suffix})`;
      name = base.slice(0, 31 - ending.length).toWellFormed() + ending;
    }
    used.add(name.toLowerCase());
    return { ...sheet, name };
  });
}

function workbookTables(result, locale) {
  const zh = locale === 'zh';
  const tables = readableResultTables(result, zh ? 'zh' : 'en');
  const catalog = new Map(tables.map(table => [table.key, table]));
  const predictions = catalog.get('predictions');
  const surfaces = new Map(predictions.rows.filter(row => row.metric === 'surface')
    .map(row => [`${row.year}|${row.age}`, row]));
  const predictionColumns = new Map(predictions.columns.map(column => [column.key, column]));
  const pickColumns = keys => keys.map(key => predictionColumns.get(key));
  const dailyColumns = [...pickColumns(['sex', 'year', 'age', 'estimate', 'lower95', 'upper95', 'unit']),
    { key: 'status', label: zh ? '状态' : 'Status' },
    { key: 'mask_reason', label: zh ? '屏蔽原因' : 'Screening reason' }];
  const lnRateColumns = [
    { key: 'ln_rate', label: zh ? 'ln率' : 'ln rate' },
    { key: 'ln_rate_lower95', label: zh ? 'ln率95% UI下限' : 'ln rate 95% UI lower' },
    { key: 'ln_rate_upper95', label: zh ? 'ln率95% UI上限' : 'ln rate 95% UI upper' },
    { key: 'ln_rate_unit', label: zh ? 'ln率单位' : 'ln rate unit' },
  ];
  const daily = Object.entries(METRICS).map(([metric, names]) => ({
    key: metric, name: names[zh ? 0 : 1], columns: metric === 'rate' ? [...dailyColumns, ...lnRateColumns] : dailyColumns,
    rows: predictions.rows.filter(row => row.metric === metric).map(row => {
      const surface = metric === 'rate' ? surfaces.get(`${row.year}|${row.age}`) : null;
      return { ...row,
        ...(metric === 'rate' ? { ln_rate: surface?.estimate ?? null, ln_rate_lower95: surface?.lower95 ?? null,
          ln_rate_upper95: surface?.upper95 ?? null, ln_rate_unit: surface?.unit ?? null } : {}),
        status: row.masked === true ? (zh ? '已屏蔽' : 'Screened')
          : row.estimate == null ? (zh ? '不可用' : 'Unavailable') : (zh ? '可用' : 'Available'),
        mask_reason: row.mask_reason == null ? null : MASK_REASONS.get(row.mask_reason)?.[zh ? 0 : 1] ?? row.mask_reason,
      };
    }),
  }));
  const dictionary = {
    ...catalog.get('field_dictionary'),
    rows: catalog.get('field_dictionary').rows.filter(row => [
      'sex', 'year / age', 'count / pop', 'estimate / lower95 / upper95', 'annual', 'gradient', 'shift', 'rate', 'surface', 'acceleration',
    ].includes(row.field)).concat([
      { field: 'ln_rate / ln_rate_lower95 / ln_rate_upper95', unit: 'ln(rate per 100000)', description: zh
        ? '拟合率表中同一时期和年龄的ln率及95% UI，直接保留surface及其区间的数值，与拟合曲面图一致；不从已显示或舍入的率重新取对数。'
        : 'Ln rate and 95% UI at the same Period and Age in the Fitted rate sheet, taken directly from the retained surface and its interval to match the fitted-surface figure, without taking logs of displayed or rounded rates.' },
      { field: zh ? '状态与屏蔽原因' : 'Status and screening reason', unit: null, description: zh
        ? '状态表示该指标显示值是否可用。时期边界、年龄梯度不稳定或非有限抽样比值可造成屏蔽；各指标独立判断。'
        : 'Status reports whether the displayed metric is available. Period boundaries, unstable age gradients or non-finite draw ratios may cause screening; each metric is assessed separately.' },
      { field: zh ? '完整分析归档' : 'Complete analysis archive', unit: null, description: zh
        ? '原始值、原始区间、原始导数、等高线、出生时期残差平滑及模型抽样保存在完整分析归档；模型抽样位于fit.rds。'
        : 'Raw values and intervals, raw derivatives, contour vertices, cohort residual smooth and model draws are preserved in the complete analysis archive. Model draws are in fit.rds.' },
    ]),
  };
  const sheets = [
    overviewTable(result, catalog, zh),
    catalog.get('input'), ...daily,
    catalog.get('observations'), dictionary,
  ].map(table => ({ ...table, rows: table.rows.map(row => ({ ...row,
    unit: zh ? ZH_UNITS.get(row.unit) ?? row.unit : row.unit,
    ...(Object.hasOwn(row, 'ln_rate_unit') ? { ln_rate_unit: zh ? ZH_UNITS.get(row.ln_rate_unit) ?? row.ln_rate_unit : row.ln_rate_unit } : {}),
  })) }));
  return safeSheetNames(sheets);
}

function valueCell(value, address) {
  if (value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) return '';
  if (typeof value === 'number') return `<c r="${address}" t="n"><v>${String(value)}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${address}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value !== 'string') throw new TypeError(`Expected a scalar result cell at ${address}.`);
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${textXml(value)}</t></is></c>`;
}

function sheetXml(table) {
  const columns = table.columns;
  if (!columns.length || columns.length > 16384 || table.rows.length > 1048575) throw new RangeError('Result table exceeds an Excel worksheet limit.');
  const lastColumn = columnAddress(columns.length - 1), lastRow = table.rows.length + 1;
  const header = `<row r="1">${columns.map((column, columnIndex) => valueCell(column.label, `${columnAddress(columnIndex)}1`)).join('')}</row>`;
  const rows = table.rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    return `<row r="${rowNumber}">${columns.map((column, columnIndex) =>
      valueCell(row[column.key], `${columnAddress(columnIndex)}${rowNumber}`)).join('')}</row>`;
  }).join('');
  return `${XML_HEADER}<worksheet xmlns="${MAIN}"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetData>${header}${rows}</sheetData></worksheet>`;
}

/** A genuine, self-contained XLSX built solely from the retained result. */
export function resultWorkbook(result, locale = 'en') {
  const tables = workbookTables(result, locale);
  const files = {
    '[Content_Types].xml': `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${tables.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `${XML_HEADER}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'docProps/core.xml': `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>BLSD Tool</dc:creator><dc:title>${locale === 'zh' ? 'BLSD 分析结果' : 'BLSD analysis results'}</dc:title></cp:coreProperties>`,
    'docProps/app.xml': `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>BLSD Tool</Application></Properties>`,
    'xl/workbook.xml': `${XML_HEADER}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${tables.map((table, index) => `<sheet name="${xml(table.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML_HEADER}<Relationships xmlns="${PKG_REL}">${tables.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`,
  };
  tables.forEach((table, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(table); });
  return zipFiles(files);
}
