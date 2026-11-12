import { zipFiles } from './results-download.mjs';
import { resultWorkbook } from './results-workbook.mjs';
import { readableResultFiles } from './readable-results.mjs';

export const MAX_ANALYSIS_EXPORT_BYTES = 256 * 1024 * 1024;

function exportError(code, message) {
  const error = new Error(message); error.code = code; return error;
}

function checkSize(bytes) {
  if (bytes > MAX_ANALYSIS_EXPORT_BYTES) throw exportError('EXPORT_TOO_LARGE',
    'The combined result export exceeds the 256 MiB limit.');
}

/** Prefixes keep labels that sanitize to the same name distinct, without
 * changing the actual sex recorded in each retained result or the manifest.
 */
export function analysisGroupPath(entry, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw exportError('INVALID_ANALYSIS_EXPORT', 'Invalid result group index.');
  const sex = entry?.sex;
  const label = sex == null || String(sex).trim() === '' ? 'Unlabelled'
    : Array.from(String(sex).normalize('NFC')
      .replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\.{2,}/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, '').replace(/_+/g, '_')).slice(0, 60).join('') || 'Group';
  return `${String(index + 1).padStart(2, '0')}_${label}`;
}

function validatedEntries(entries, requireRds) {
  if (!Array.isArray(entries) || !entries.length) throw exportError('INVALID_ANALYSIS_EXPORT', 'No retained result groups are available.');
  const analysisIds = new Set(); let inputBytes = 0;
  for (const entry of entries) {
    if (!entry || !entry.result || typeof entry.result !== 'object' || Array.isArray(entry.result) ||
        (requireRds && !Buffer.isBuffer(entry.rds))) throw exportError('INVALID_ANALYSIS_EXPORT', 'A retained group result or model is unavailable.');
    const id = entry.analysisId ?? entry.result.analysisId ?? entry.result.meta?.analysisId;
    if (id != null) analysisIds.add(id);
    // Bound retained input payloads before building workbooks or CSV copies.
    inputBytes += Buffer.byteLength(JSON.stringify(entry.result));
    if (requireRds) inputBytes += entry.rds.length;
    checkSize(inputBytes);
  }
  if (analysisIds.size > 1) throw exportError('INVALID_ANALYSIS_EXPORT', 'Retained groups must belong to the same analysis.');
  return entries;
}

function fileCollector() {
  const files = {}; let bytes = 0;
  return {
    add(name, data) {
      bytes += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
      checkSize(bytes);
      files[name] = data;
    },
    zip() {
      const zipped = zipFiles(files);
      checkSize(zipped.length);
      return zipped;
    },
  };
}

/** One plain, typed nine-sheet workbook per successfully retained group.
 * Excel exports do not need to load the R snapshots.
 */
export function analysisWorkbookZip(entries, locale = 'en') {
  const files = fileCollector();
  validatedEntries(entries, false).forEach((entry, index) =>
    files.add(`${analysisGroupPath(entry, index)}.xlsx`, resultWorkbook(entry.result, locale)));
  return files.zip();
}

function analysisReadme(locale) {
  return locale === 'zh' ? [
    'BLSD Tool 全部性别分析归档', '',
    '本归档包含本次分析中全部成功保留的性别组；每组独立拟合，按编号和实际性别分别存入目录。未成功拟合的组没有可归档的模型。',
    'analysis.json列出共同analysisId，以及各组目录、实际sex、fitId和拟合方法；无Sex输入保持null，目录使用Unlabelled，不补造Both。',
    '每组目录：01_tables为窄CSV表格；02_analysis为参数、完整诊断、单位和来源元数据；03_reproducibility为完整results.json和包含实际模型/系数抽样的fit.rds。',
    '分组Excel包为每组一个.xlsx，每个工作簿包含9张普通数据表；保留表头、数值类型和空值，不添加单元格格式。Excel用于日常阅读，原始值、原始区间、遮罩及全部复现信息保存在本分析归档。',
    '95% UI是联合高斯系数抽样产生的近似逐点模型不确定性区间，不包含输入估计误差或未来观测变异；不是预测区间或同时区间，也不主张所有派生指标具有精确的频率学覆盖率。',
    '空值不是零；筛选后的显示值与原始值/原始UI及各指标遮罩、原因分别保留。每组结果、JSON和模型不与其他组混合。',
    '导出包含各组全部可用坐标，不受当前图表或曲线勾选限制；不重新拟合、不重新抽样、不舍入数值。',
    'CSV使用UTF-8 BOM。可能被电子表格执行的来源字符串前加单引号；完整JSON保留原始字符串。fitId是临时拟合标识，不是永久分享链接。', '',
  ].join('\r\n') : [
    'BLSD Tool all-sex analysis archive', '',
    'This archive contains all successfully retained sex groups in the analysis. Each group was fitted independently and has its own numbered directory. Failed fits have no retained model to archive.',
    'analysis.json lists the shared analysisId and each directory, actual sex, fitId and method. Unlabelled input keeps sex=null and uses Unlabelled in its directory name; Both is never invented.',
    'Within each group: 01_tables holds focused CSV tables; 02_analysis holds settings, complete diagnostics, units and provenance; 03_reproducibility holds complete results.json and fit.rds with the actual model and coefficient draws.',
    'The separate Excel ZIP contains one .xlsx per group, with nine plain data worksheets per workbook. Headers, numeric types and blanks are retained without cell formatting. Excel supports everyday reading; this analysis archive preserves raw values, raw intervals, masks and complete reproducibility information.',
    '95% UI denotes approximate pointwise model uncertainty intervals from joint Gaussian coefficient draws. It excludes input-estimation uncertainty and future-observation variation; it is not a prediction interval or simultaneous band, and exact frequentist coverage is not asserted for all derived quantities.',
    'A blank is not zero. Screened display values, raw values/raw UI and independent metric masks/reasons are retained separately. No group result, JSON or model is mixed with another group.',
    'Exports contain every available coordinate for every group, regardless of current chart or curve selections. They do not refit, resample or round numerical values.',
    'CSV uses UTF-8 BOM. Potential spreadsheet-formula source strings receive a leading apostrophe; complete JSON preserves original strings. fitId is a temporary fit identifier, not a permanent sharing link.', '',
  ].join('\r\n');
}

/** Merge retained group files directly, without recompressing nested ZIPs. */
export function analysisResultZip(entries, locale = 'en') {
  const groups = validatedEntries(entries, true), files = fileCollector();
  const manifest = { exportLayout: 'readable-v1', scope: 'analysis',
    locale: locale === 'zh' ? 'zh' : 'en',
    analysisId: groups[0].analysisId ?? groups[0].result.analysisId ?? groups[0].result.meta?.analysisId ?? null,
    groups: [] };
  groups.forEach((entry, index) => {
    const path = analysisGroupPath(entry, index);
    for (const [name, data] of Object.entries(readableResultFiles(entry.result, entry.rds, locale))) {
      if (name === 'README_zh.txt' || name === 'README_en.txt') continue;
      files.add(`${path}/${name}`, data);
    }
    manifest.groups.push({ path, sex: entry.sex ?? null,
      fitId: entry.fitId ?? entry.result.fitId ?? entry.result.meta?.fitId ?? null,
      method: entry.method ?? entry.result.settings?.method ?? entry.result.diagnostics?.method ?? null });
  });
  files.add('analysis.json', JSON.stringify(manifest, null, 2));
  files.add('README_zh.txt', analysisReadme('zh'));
  files.add('README_en.txt', analysisReadme('en'));
  return files.zip();
}
