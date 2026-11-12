import { publicCountResult, tableCsv, zipFiles } from './results-download.mjs';
import { parseAgeGroup } from '../src/ageGroups.js';

export const READABLE_RESULT_LAYOUT = 'readable-v1';
const METRICS = [
  ['rate', '率', 'Rate', 'per 100000'],
  ['surface', '对数率', 'Log rate', 'ln(rate per 100000)'],
  ['annual', '年变化率', 'Annual rate change', '%/year'],
  ['acceleration', '对数率加速度', 'Log-rate acceleration', 'log-rate/year^2'],
  ['gradient', '年龄梯度', 'Age gradient', '%/age-year'],
  ['shift', '等效年龄移动速度', 'Equivalent age shift', 'age-years/year'],
];
const DERIVATIVES = [
  ['logAnnual', '对数率时期一阶导数', 'First period derivative of log rate', 'log-rate/year'],
  ['logGradient', '对数率年龄一阶导数', 'First age derivative of log rate', 'log-rate/age-year'],
  ['logAcceleration', '对数率时期二阶导数', 'Second period derivative of log rate', 'log-rate/year^2'],
];
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const own = (value, key) => value != null && Object.hasOwn(value, key);
// R encodes some empty named lists as []; metric keys such as "shift" must
// never resolve to inherited Array.prototype methods.
const field = (value, key) => own(value, key) ? value[key] : undefined;
const cell = value => value === undefined ? null : value;
const pair = value => Array.isArray(value) ? [cell(value[0]), cell(value[1])] : [null, null];
const localeOf = locale => locale === 'zh' ? 'zh' : 'en';
const text = (locale, zh, en) => locale === 'zh' ? zh : en;
const sexOf = result => own(result.meta, 'sex') ? result.meta.sex : cell(result.input?.[0]?.Sex);
const unitOf = (result, key, fallback) => field(result.units, key) ?? field(result.meta?.units, key) ?? fallback;

const coordinatesOf = values => [...new Set(array(values).filter(value => typeof value === 'number' && Number.isFinite(value)))].sort((a, b) => a - b);
function availableCurves(result) {
  const select = (observed, input, grid) => {
    const retained = coordinatesOf(grid), permitted = new Set(retained);
    const observedValues = coordinatesOf(observed), inputValues = coordinatesOf(input);
    const candidates = observedValues.length ? observedValues : inputValues.length ? inputValues : retained;
    return candidates.filter(value => permitted.has(value));
  };
  return {
    sectionYears: select(result.grid?.observedYears, array(result.input).map(row => row.Year), result.grid?.years),
    trendAges: select(result.grid?.observedAges, array(result.input).map(row => row.Age_Mid), result.grid?.ages),
  };
}

function table(locale, key, zh, en, definitions, rows) {
  const columns = definitions.map(([key, zh, en, width = 18, format = 'number']) =>
    ({ key, label: text(locale, zh, en), width, format }));
  return { key, name: text(locale, zh, en), columns,
    rows: rows.map(row => Object.fromEntries(columns.map(column => [column.key, cell(row[column.key])]))),
  };
}

const coordinates = [
  ['sex', '性别', 'Sex', 14, 'text'], ['year', '时期', 'Period', 12], ['age', '年龄', 'Age', 12],
];
const bounds = [
  ['estimate', '估计值', 'Estimate', 20], ['lower95', '95% UI下限', '95% UI lower', 20],
  ['upper95', '95% UI上限', '95% UI upper', 20],
];
const unit = ['unit', '单位', 'Unit', 25, 'text'];

function inputRows(result) {
  const sex = sexOf(result), groups = array(result.provenance?.ageGroups);
  return array(result.input).map(row => {
    const supplied = parseAgeGroup(row.Age_Group);
    const known = groups.find(group => group?.midpoint === row.Age_Mid &&
      (group.sex == null || group.sex === (row.Sex ?? sex)));
    const group = supplied ?? known;
    return { sex: cell(row.Sex ?? sex), year: row.Year, age: row.Age_Mid,
      age_group: row.Age_Group ?? (group ? `${group.lower}–${group.upper}` : null),
      age_lower: group?.lower, age_upper: group?.upper, count: row.Count, pop: row.Pop };
  });
}

function predictionRows(result) {
  const sex = sexOf(result);
  return array(result.points).flatMap(point => METRICS.map(([metric, , , fallback]) => {
    const [lower95, upper95] = pair(field(point.intervals, metric));
    const [raw_lower95, raw_upper95] = pair(field(point.rawIntervals, metric));
    // The top-level mask aliases refer only to shift, never to every quantity.
    return { sex, year: point.year, age: point.age, metric,
      estimate: field(point, metric), lower95, upper95, raw_estimate: field(point.raw, metric), raw_lower95, raw_upper95,
      masked: own(point.metricMasks, metric) ? point.metricMasks[metric] : metric === 'shift' ? point.masked : null,
      mask_reason: field(point.metricMaskReasons, metric) ?? (metric === 'shift' ? point.maskReason : null),
      valid_draw_fraction: own(point.metricValidFractions, metric) ? point.metricValidFractions[metric]
        : metric === 'shift' ? point.validFraction : null,
      unit: unitOf(result, metric, fallback) };
  }));
}

function derivativeRows(result) {
  return array(result.points).flatMap(point => DERIVATIVES.map(([metric, , , fallback]) => {
    const [lower95, upper95] = pair(field(point.rawDerivatives?.intervals, metric));
    return { sex: sexOf(result), year: point.year, age: point.age, metric,
      estimate: field(point.rawDerivatives, metric), lower95, upper95, unit: unitOf(result, metric, fallback) };
  }));
}

function observationRows(result) {
  // These retained values are evaluated at observations; do not recreate them
  // from grid values, whose floating-point evaluation may differ slightly.
  return array(result.residuals).map(row => {
    const [rate_lower95, rate_upper95] = pair(row.intervals?.rate);
    const [log_rate_lower95, log_rate_upper95] = pair(row.intervals?.logRate);
    return { sex: sexOf(result), year: row.year, age: row.age, count: row.count, pop: row.pop,
      cohort: row.cohort, observed_rate: row.observedRate, fitted_rate: row.fittedRate,
      fitted_count: row.fittedCount, rate_lower95, rate_upper95, log_rate: row.logRate,
      log_rate_lower95, log_rate_upper95, deviance_residual: row.devianceResidual,
      pearson_residual: row.pearsonResidual };
  });
}

function contourRows(result) {
  const rows = []; let pathId = 0;
  for (const [metric, lines] of Object.entries(result.contours ?? {})) {
    for (const line of array(lines)) {
      pathId += 1;
      for (const [index, point] of array(line.points).entries()) rows.push({
        sex: sexOf(result), metric, path_id: pathId, level: line.level, point_order: index + 1,
        year: point[0], age: point[1], unit: unitOf(result, metric, METRICS.find(entry => entry[0] === metric)?.[3] ?? '') });
    }
  }
  return rows;
}

function summaryRows(result, locale) {
  const rows = [], add = (section, item, value, unit = null) => rows.push({ section, item, value: cell(value), unit });
  const flatten = (section, value, prefix = '') => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => flatten(section, entry, `${prefix}[${index + 1}]`));
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) flatten(section, entry, prefix ? `${prefix}.${key}` : key);
    } else add(section, prefix, value);
  };
  const identity = text(locale, '分析标识', 'Analysis identity');
  for (const [key, value] of Object.entries({ fitId: result.fitId ?? result.meta?.fitId,
    analysisId: result.analysisId ?? result.meta?.analysisId, sex: sexOf(result), schemaVersion: result.schemaVersion }))
    add(identity, key, value);
  flatten(text(locale, '实际参数', 'Applied settings'), result.settings ?? {});
  add(text(locale, '模型', 'Model'), 'formula', result.parameters?.formula);
  add(text(locale, '模型', 'Model'), 'covarianceSource', result.parameters?.covarianceSource ?? result.meta?.covarianceSource);
  add(text(locale, '模型', 'Model'), 'coefficientCount', Object.keys(result.parameters?.coefficients ?? {}).length);
  flatten(text(locale, '诊断与检验', 'Diagnostics and tests'), result.diagnostics ?? {});
  const curves = text(locale, '曲线坐标', 'Curve coordinates');
  const available = availableCurves(result);
  for (const [key, value] of Object.entries({ availableSectionYears: available.sectionYears,
    availableTrendAges: available.trendAges, defaultSectionYears: array(result.defaults?.sectionYears),
    defaultTrendAges: array(result.defaults?.trendAges) })) add(curves, key, JSON.stringify(value));
  const notes = text(locale, '阅读说明', 'Reading notes');
  add(notes, '95% UI', text(locale,
    '近似逐点模型不确定性区间：联合高斯系数抽样结果的2.5%和97.5%分位数；不包含输入估计误差或未来观测变异，不是PI或同时区间。',
    'Approximate pointwise model uncertainty interval: 2.5% and 97.5% quantiles from joint Gaussian coefficient draws. It excludes input-estimation uncertainty and future-observation variation; it is not a PI or simultaneous band.'));
  add(notes, 'estimates', text(locale,
    '可读指标表列出率、对数率、年变化率、对数率加速度、年龄梯度和等效年龄移动速度；Excel拟合率表同时保留率和对应拟合曲面的ln率及各自95% UI。原始值及完整筛选信息见完整归档中的预测长表。',
    'Readable metric sheets cover rate, log rate, annual rate change, log-rate acceleration, age gradient and equivalent age shift. The Excel Fitted rate sheet includes both rate and the corresponding fitted-surface ln rate with their respective 95% UI. Raw values and complete screening details are retained in the archive prediction table.'));
  add(notes, 'masked', text(locale,
    '筛选后的估计值或UI可为空；原始值、原始UI、各指标遮罩和原因分别保留。空值不是零。',
    'Displayed estimates or UI may be blank after screening. Raw estimates, raw UI, per-metric masks and reasons are retained separately. A blank is not zero.'));
  add(notes, 'curves', text(locale,
    '年龄截面和时间趋势是预测网格及观测表的坐标子集，不重复存储；默认坐标不是用户当前手动选择。',
    'Age sections and time trends are coordinate subsets of the predictions and observations, without duplicate tables. Defaults do not describe the current manual selection.'));
  add(notes, 'workbook', text(locale,
    'Excel包含当前性别的全部可用坐标，不受当前图表筛选或曲线勾选限制；在拟合率表按时期或年龄筛选，即可读取年龄截面或分年龄趋势。',
    'Excel includes every available coordinate for the current sex, regardless of current chart filters or selected curves. Filter the fitted-rate sheet by Period or Age to read age sections or age-specific trends.'));
  add(notes, 'cohort', text(locale, '近似出生时期坐标为Year−Age_Mid；平滑线用于描述残差。',
    'The approximate birth-period coordinate is Year−Age_Mid; the smooth describes residuals.'));
  for (const [key, zh, en, fallback] of METRICS) add(text(locale, '指标单位', 'Metric units'),
    `${key}: ${text(locale, zh, en)}`, null, unitOf(result, key, fallback));
  return rows;
}

function dictionaryRows(result, locale) {
  const entry = (field, zh, en, unit = null) => ({ field, description: text(locale, zh, en), unit });
  return [
    entry('sex', '实际性别组标签；无性别输入保持空值。每次导出仅含当前保留拟合。',
      'Actual group label, blank for unlabelled input. Each export contains only the selected retained fit.'),
    entry('year / age', '实际模型坐标；年龄为输入中点，不从中点推断年龄范围。',
      'Actual model coordinates; age is the input midpoint. Age bounds are never inferred from a midpoint.'),
    entry('count / pop', '原始计数及人口或暴露量，保留小数精度。',
      'Original count and exposure/population, with fractional precision preserved.'),
    entry('estimate / lower95 / upper95', '筛选后的拟合中心及95% UI上下限；中心由拟合系数代入计算。',
      'Screened fitted centre and 95% UI bounds. Centres use the fitted coefficients, not draw medians.'),
    entry('raw_estimate / raw_lower95 / raw_upper95', '筛选前保留的中心及95% UI，不因显示隐藏而删除。',
      'Retained centre and 95% UI before display screening; hidden display values remain available here.'),
    entry('masked / mask_reason', '每个指标独立的显示遮罩及原因。加速度端点隐藏与年龄梯度稳定性筛选分别记录。',
      'Independent display mask and reason for each metric, distinguishing acceleration endpoints from age-gradient stability screening.'),
    entry('valid_draw_fraction', '有限系数抽样结果的比例，范围0–1。',
      'Fraction of finite draw-derived values, from 0 to 1.'),
    entry('surface', '对数率为ln(每10万人率)，并非直接率。',
      'Log rate is ln(rate per 100,000), not the rate itself.', unitOf(result, 'surface', METRICS[1][3])),
    entry('annual', '固定年龄的局部年变化率：100×expm1(∂ln率/∂年份)。',
      'Local period change at fixed age: 100×expm1(∂ln(rate)/∂year).', unitOf(result, 'annual', '%/year')),
    entry('gradient', '固定时期的局部年龄变化：100×expm1(∂ln率/∂年龄)。',
      'Local age change at fixed period: 100×expm1(∂ln(rate)/∂age).', unitOf(result, 'gradient', '%/age-year')),
    entry('shift', '等拟合率对应年龄的移动速度−S_t/S_a；正值移向高龄，负值移向低龄。',
      'Age movement at the same fitted rate, −S_t/S_a; positive moves to older ages and negative to younger ages.',
      unitOf(result, 'shift', 'age-years/year')),
    entry('threshold', '对数率年龄导数的点估计及整个95% UI须同在正阈值以上或负阈值以下，且比值有限；这是稳定性阈值。',
      'The log-rate age derivative and its entire 95% UI must both exceed the positive threshold or fall below the negative threshold; ratios must be finite. This is a stability threshold.', '1/age-year'),
    entry('observations', '观测率、拟合率及率UI单位均为每10万人；保留观测坐标处的原有计数、UI及残差，不从预测网格重新计算。',
      'Observed/fitted rates and their rate UI are per 100,000. Original counts, UI and residuals at observation coordinates are retained without recalculation from the prediction grid.'),
    entry('contours.path_id / point_order / level', '按线段ID和点序号连接等高线；surface等高线level保持对数率。',
      'Connect vertices by path ID and point order. Surface contour levels remain on the log-rate scale.'),
    ...METRICS.filter(([key]) => ['rate', 'acceleration'].includes(key)).map(([key, zh, en, fallback]) =>
      entry(key, key === 'rate' ? '拟合率：每10万人。' : '固定年龄的对数率时期二阶导数。',
        key === 'rate' ? 'Fitted rate per 100,000.' : 'Second period derivative of log rate at fixed age.', unitOf(result, key, fallback))),
    ...DERIVATIVES.map(([key, zh, en, fallback]) => entry(key, `${zh}；保留筛选前数值及95% UI。`,
      `${en}; values and 95% UI are retained before display screening.`, unitOf(result, key, fallback))),
  ];
}

/** Stable data contract shared by readable CSV archives and Excel workbooks.
 * Keys are locale-independent; cells retain numbers/null/booleans without rounding.
 */
export function readableResultTables(retained, language = 'en') {
  const result = publicCountResult(retained), locale = localeOf(language);
  return [
    table(locale, 'input', '输入数据', 'Input data', [coordinates[0], coordinates[1],
      ['age_group', '年龄组', 'Age group', 17, 'text'], coordinates[2],
      ['age_lower', '年龄下界', 'Age lower bound', 16], ['age_upper', '年龄上界', 'Age upper bound', 16],
      ['count', '计数', 'Count', 22], ['pop', '人口或暴露量', 'Population or exposure', 24]], inputRows(result)),
    table(locale, 'predictions', '预测长表', 'Predictions', [...coordinates,
      ['metric', '指标', 'Metric', 20, 'text'], ...bounds,
      ['raw_estimate', '原始估计值', 'Raw estimate', 20], ['raw_lower95', '原始95% UI下限', 'Raw 95% UI lower', 22],
      ['raw_upper95', '原始95% UI上限', 'Raw 95% UI upper', 22], ['masked', '已遮罩', 'Masked', 12, 'text'],
      ['mask_reason', '遮罩原因', 'Mask reason', 30, 'text'],
      ['valid_draw_fraction', '有效抽样比例', 'Valid draw fraction', 22, 'percent'], unit], predictionRows(result)),
    table(locale, 'derivatives', '原始导数', 'Raw derivatives', [...coordinates,
      ['metric', '导数', 'Derivative', 24, 'text'], ...bounds, unit], derivativeRows(result)),
    table(locale, 'observations', '观测与残差', 'Observations and residuals', [...coordinates,
      ['count', '计数', 'Count', 22], ['pop', '人口或暴露量', 'Population or exposure', 24],
      ['cohort', '近似出生时期', 'Approximate birth period', 23], ['observed_rate', '观测率（每10万人）', 'Observed rate (per 100,000)', 30],
      ['fitted_rate', '拟合率（每10万人）', 'Fitted rate (per 100,000)', 30], ['fitted_count', '拟合计数', 'Fitted count', 22],
      ['rate_lower95', '率95% UI下限', 'Rate 95% UI lower', 22], ['rate_upper95', '率95% UI上限', 'Rate 95% UI upper', 22],
      ['log_rate', '对数率', 'Log rate', 20], ['log_rate_lower95', '对数率95% UI下限', 'Log rate 95% UI lower', 24],
      ['log_rate_upper95', '对数率95% UI上限', 'Log rate 95% UI upper', 24],
      ['deviance_residual', '偏差残差', 'Deviance residual', 22], ['pearson_residual', '皮尔逊残差', 'Pearson residual', 22]], observationRows(result)),
    table(locale, 'cohort_smooth', '出生时期残差平滑', 'Cohort residual smooth', [coordinates[0],
      ['cohort', '近似出生时期', 'Approximate birth period', 23], ['value', '平滑残差', 'Smoothed residual', 22]],
      array(result.cohortSmooth).map(row => ({ sex: sexOf(result), cohort: row.cohort, value: row.value }))),
    table(locale, 'contours', '等高线坐标', 'Contour vertices', [coordinates[0], ['metric', '指标', 'Metric', 20, 'text'],
      ['path_id', '线段ID', 'Path ID', 12, 'integer'], ['level', '等高线值', 'Contour level', 20],
      ['point_order', '点序号', 'Point order', 12, 'integer'], coordinates[1], coordinates[2], unit], contourRows(result)),
    table(locale, 'analysis_summary', '分析概览', 'Analysis summary', [
      ['section', '类别', 'Section', 24, 'text'], ['item', '项目', 'Item', 38, 'text'],
      ['value', '内容', 'Value', 80, 'text'], unit], summaryRows(result, locale)),
    table(locale, 'field_dictionary', '字段说明', 'Field dictionary', [
      ['field', '字段或指标', 'Field or metric', 48, 'text'], ['description', '说明', 'Description', 100, 'text'], unit],
      dictionaryRows(result, locale)),
  ];
}

function fixedTableCsv(table) {
  const rows = table.rows.map(row => Object.fromEntries(table.columns.map(column => [column.label, row[column.key]])));
  if (rows.length) return tableCsv(rows);
  // Retain an explicit schema even when a scientific table has no observations.
  return tableCsv([Object.fromEntries(table.columns.map(column => [column.label, null]))]).split('\r\n')[0] + '\r\n';
}

/** A single homogeneous prediction table, rather than concatenated table types. */
export function readableResultCsv(result, locale = 'en') {
  return fixedTableCsv(readableResultTables(result, locale).find(table => table.key === 'predictions'));
}

function readme(locale) {
  return locale === 'zh' ? [
    'BLSD Tool 完整分析归档（readable-v1）', '',
    '01_tables：用途明确的CSV表格。预测长表每个坐标、每个指标一行；原始导数、观测残差和等高线分别存储。',
    '02_analysis/metadata.json：分析标识、实际参数、系数、诊断检验、单位、来源及默认/可用曲线坐标。',
    '03_reproducibility/results.json：完整保留结果；fit.rds：实际拟合模型及同一组系数抽样。',
    '每份归档仅含所选性别的独立拟合。Both若由Male/Female合并，其来源保存在元数据中，不混入其他拟合。',
    '95% UI是来自联合高斯系数抽样的近似逐点模型不确定性区间，不包括输入估计误差或未来观测变异；不是预测区间或同时区间，也不主张所有派生指标具有精确的频率学覆盖率。',
    '空值不是零；原始值、原始UI及每指标的遮罩/原因保留。加速度端点及等效年龄移动稳定性筛选不删除原始结果。',
    '年龄截面和时间趋势复用预测与观测表，不重复CSV；默认曲线坐标不是当前手动选择的记录。',
    '数值不重新拟合、不重新抽样、不四舍五入。CSV为UTF-8 BOM；可能被电子表格执行的来源字符串前加单引号，JSON保留原始字符串。',
    'fitId是临时保留拟合的标识，不是永久分享链接。', '',
  ].join('\r\n') : [
    'BLSD Tool complete analysis archive (readable-v1)', '',
    '01_tables: focused CSV tables. Predictions have one row per coordinate and metric; derivatives, observations/residuals and contour vertices have separate tables.',
    '02_analysis/metadata.json: analysis identity, applied settings, coefficients, diagnostics/tests, units, provenance and default/available curve coordinates.',
    '03_reproducibility/results.json: the complete retained result; fit.rds: the actual fitted model and the same coefficient draws.',
    'Each archive contains only the selected independently fitted sex group. For a derived Both, source groups are recorded in metadata without mixing in their fits.',
    '95% UI denotes approximate pointwise model uncertainty intervals from joint Gaussian coefficient draws. It excludes input-estimation uncertainty and future-observation variation; it is not a prediction interval or simultaneous band, and exact frequentist coverage is not asserted for all derived quantities.',
    'A blank is not zero. Raw values, raw UI and per-metric masks/reasons are retained. Acceleration endpoint hiding and equivalent-age-shift stability screening do not remove raw results.',
    'Age sections and time trends reuse the prediction and observation tables without duplicate CSVs. Default curve coordinates do not record the current manual selection.',
    'Exports do not refit, resample or round numerical values. CSV uses UTF-8 BOM; source strings that could execute as spreadsheet formulas receive a leading apostrophe, while JSON preserves original strings.',
    'fitId is a temporary retained-fit identifier, not a permanent sharing link.', '',
  ].join('\r\n');
}

/** Uncompressed archive entries, also reusable inside an all-group archive. */
export function readableResultFiles(retained, rds, language = 'en') {
  const result = publicCountResult(retained), locale = localeOf(language), files = {};
  for (const table of readableResultTables(result, locale)) files[`01_tables/${table.key}.csv`] = fixedTableCsv(table);
  files['02_analysis/metadata.json'] = JSON.stringify({ exportLayout: READABLE_RESULT_LAYOUT, locale,
    schemaVersion: result.schemaVersion, fitId: result.fitId ?? result.meta?.fitId,
    analysisId: result.analysisId ?? result.meta?.analysisId, meta: result.meta, settings: result.settings,
    parameters: result.parameters, diagnostics: result.diagnostics, provenance: result.provenance ?? null,
    defaults: result.defaults, grid: result.grid, units: result.units ?? result.meta?.units,
    availableCurves: availableCurves(result) }, null, 2);
  files['03_reproducibility/results.json'] = JSON.stringify(result);
  files['03_reproducibility/fit.rds'] = rds;
  files['README_zh.txt'] = readme('zh');
  files['README_en.txt'] = readme('en');
  return files;
}

export function readableResultZip(retained, rds, language = 'en') {
  return zipFiles(readableResultFiles(retained, rds, language));
}
