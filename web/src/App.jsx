import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartLine, DownloadSimple, CheckCircle, WarningCircle, X, FileXls, FileArchive, SlidersHorizontal, ArrowClockwise, ArrowsOut } from '@phosphor-icons/react';
import SurfaceChart, { METRIC_META, formatResultValue } from './SurfaceChart';
import { demoProvenance, demoInputCsv, validateRows, parseCsv, prepareInputData, downloadFile, defaultModelSettings, groupRows } from './data';
import { nearestResultPoint, formatResultNumber, normalizedModelSettings, filenameFromDisposition, coordinateDraftValue, formatCoordinateDraft, exportResponseMatchesFormat } from './resultHelpers';
import { metricValue, metricMaskReason } from './chartResult';
import { availableGroupSelection, minimumGroupSummary, clampGroupSettings, assertGroupFitResponse, groupCurveCoordinates, groupCurveOptions } from './groupHelpers';
import { createCsvImporter, createFileDropHandlers } from './csvImport';
import WorkspaceInput from './WorkspaceInput.jsx';
import SidebarDataPreview, { previewColumnHeading } from './SidebarDataPreview.jsx';
import SidebarFitSummary from './SidebarFitSummary.jsx';
import HeaderTools from './HeaderTools.jsx';
import ReadoutValue from './ReadoutValue.jsx';
import MetricHelp from './MetricHelp.jsx';
import { ageGroupOptions, formattedAgeLabel } from './readoutCoordinates.js';
import { nearestResidualObservation } from './residualHelpers.js';
import { taskRequest } from './taskRequest.js';
const COPY = {
  en: {
    data: 'Data',
    model: 'Model',
    explore: 'Explore',
    diagnostics: 'Diagnostics',
    metric: 'Metric',
    surface: 'Fitted surface',
    annual: 'Annual rate change',
    shift: 'Equivalent age shift',
    acceleration: 'Log-rate acceleration',
    gradient: 'Age gradient',
    more: 'More metrics',
    less: 'Fewer metrics',
    export: 'Export figure',
    selected: 'Selected location',
    year: 'Period',
    age: 'Age',
    invalidYear: 'Enter a finite period. The selected location is unchanged.',
    invalidAge: 'Enter a finite age. The selected location is unchanged.',
    interval: 'Show 95% UI',
    viewDiagnostics: 'View model diagnostics',
    historical: 'Period',
    dataTitle: 'Input data',
    source: 'Load example',
    imported: 'Imported data',
    upload: 'Choose CSV',
    paste: 'Paste CSV',
    sample: 'Download sample',
    useDemo: 'Use example data',
    csvHint: 'UTF-8 CSV · Year, Age_Group (30–34), Count, Pop · optional Sex',
    uploadTitle: 'Drop a CSV file',
    dropTitle: 'Release to import CSV',
    uploadText: 'Choose a CSV, or drag one onto this area.',
    pasteLabel: 'Paste a CSV table',
    validate: 'Validate data',
    preview: 'Data preview',
    rows: 'records',
    ageGroups: 'age groups',
    calendarYears: 'periods',
    valid: 'Data checks passed',
    exposureHint: 'Counts and exposure must match by age, period and population.',
    configure: 'Configure model',
    firstRows: 'Preview rows',
    back: 'Previous',
    next: 'Next',
    errors: 'Data needs attention',
    warnings: 'Review these items',
    row: 'Row',
    uploadLimit: 'Use a CSV smaller than 5 MB.',
    uploadOnly: 'Choose a .csv file.',
    uploadSingle: 'Import one CSV file at a time.',
    readError: 'Unable to read this file.',
    modelTitle: 'Model parameters',
    downloadTemplate: 'Download template', viewData: 'View data', viewAll: 'View all', downloadResults: 'Download results',
    rowCount: 'Records', dataTable: 'Complete results', ageBand: 'Age group', ageCoordinate: 'Age coordinate', residualTab: 'Fitted residuals',
    language: 'Language', guide: 'User guide', cite: 'Cite', citePending: 'Article link coming soon',
    residualValue: 'Deviance residual', observedRate: 'Observed rate', fittedRate: 'Fitted rate',
    modelSubtitle: 'Configure a generalized additive model (GAM) for age-by-period rates.',
    method: 'Distribution and smoothing selection',
    quasi: 'Quasi-Poisson + GCV',
    quasiReml: 'Quasi-Poisson + REML',
    nb: 'Negative binomial + REML',
    draws: 'Coefficient samples',
    seed: 'Random seed',
    advanced: 'Advanced settings',
    kAge: 'Age basis dimension',
    kYear: 'Period basis dimension',
    threshold: 'Log-rate age-gradient threshold (1/age-year)',
    run: 'Run analysis',
    running: 'Fitting…',
    reset: 'Reset data',
    runSuccess: 'Analysis complete.',
    settingsError: 'Check the sample count, seed, basis dimensions and positive threshold.',
    diagTitle: 'Model diagnostics',
    dataCheck: 'Data checks',
    countCheck: 'Required numeric fields',
    gridCheck: 'Unique age × period records',
    domainCheck: 'Age and period coverage',
    completeGrid: 'Complete observation grid',
    incompleteGrid: 'Incomplete observation grid',
    fitStatus: 'Model fit',
    convergenceStatus: 'Convergence',
    notRun: 'Not fitted yet',
    intervalStatus: 'Interval interpretation',
    illustrative: 'Approximate pointwise 95% model uncertainty intervals',
    openExplore: 'Open surface explorer',
    png: 'Online view PNG',
    publication: 'Figures',
    publicationTitle: 'Download figure bundle',
    figureFormat: 'File format',
    pdf: 'PDF',
    paperPng: 'PNG',
    paperTiff: 'TIFF',
    paperDownload: 'Download',
    paperRunning: 'Preparing figures…',
    paperFailed: 'The R figure could not be exported. Try again or run the analysis again.',
    paperExpired: 'This fitted result is no longer available in the R service. Run the analysis again before exporting.',
    fitRequired: 'Run the analysis before exporting a fitted figure.',
    csv: 'Fitted values · CSV',
    json: 'Analysis record · JSON',
    exported: 'Export downloaded.',
    figureFirst: 'Open Explore to export a PNG figure.',
    range: '95% UI',
    value: 'Fitted value',
    notFitTitle: 'Data ready for analysis',
    noInputTitle: 'Waiting for input data', noInputText: 'Import a CSV or load the example.',
    fitFailed: 'Fitting failed. Review the data and settings.',
    fitUnavailable: 'The local R service is unavailable. Start or restore the service, then try again.',
    fitTimeout: 'Fitting timed out. Reduce the draw count or basis dimensions.',
    fitMissingPackages: 'The R service is missing a required package. Check the local R installation.',
    fitInvalidResponse: 'The R service returned an incompatible result. No fitted result was displayed.',
    fitInvalidSettings: 'The R service rejected the model settings. Check the basis dimensions and sample count.',
    fitInvalidData: 'The R service rejected the input data. Review the data checks.',
    fitInsufficient: 'There are too few observations for these basis dimensions. Reduce the age and period basis dimensions.',
    fitNumerical: 'Numerical instability. Check the counts, exposure and basis dimensions.',
    fitNoConvergence: 'The model did not converge. Adjust settings and refit.',
    serviceBusy: 'The R service is busy. Wait briefly and try again.',
    rateLimited: 'Too many analysis or export requests. Wait briefly and try again.',
    requestTooLarge: 'The data request exceeds the service limit. Use a smaller data table.',
    cairoUnavailable: 'The R graphics device is unavailable. Check the local Cairo graphics support.',
    invalidExportSettings: 'The export settings are unsupported. Choose PDF or PNG and a width of 90 or 180 mm.',
    retry: 'Try again',
    fitted: 'Fitted',
    converged: 'Converged',
    notConverged: 'Did not converge',
    convergenceWarning: 'The model did not converge. Review settings before interpreting results.',
    edf: 'Effective degrees of freedom',
    scale: 'Scale parameter',
    devianceExplained: 'Deviance explained',
    coefficients: 'Coefficient draws',
    resultInvalidated: 'Data or settings changed. Run the analysis again.',
    serverErrorCode: 'Service error code',
    ageSections: 'Age sections', timeTrends: 'Time trends by age', residuals: 'Cohort-coordinate residuals',
    contours: 'Contour lines', sectionYears: 'Section periods', trendAges: 'Trend ages',
    coordinates: 'Observed coordinates', fullScreen: 'Full screen', resetZoom: 'Reset zoom',
    resultWorkbook: 'Result tables',
    resultArchive: 'Analysis archive',
    downloadRunning: 'Preparing download…', downloadError: 'Result download failed. Try again.',
    sex: 'Sex', group: 'Analysis groups', csvSexHint: 'Optional Sex column · selected groups are fitted independently', exitFullScreen: 'Exit full screen',
    selectGroups: 'Select sexes', groupSelectionHint: 'Fit selected groups independently.',
    selectGroupRequired: 'Select at least one group.', selectedGroups: 'Selected groups',
    viewGroup: 'View readouts', activeGroupSelected: 'Active for readouts and exports',
    groupPending: 'Awaiting fitted result', groupFailed: 'Fit failed', partialSuccess: 'Some groups could not be fitted. Successful results are ready.',
    groupProgress: 'Group results', allGroupsFailed: 'No selected group could be fitted. Review the group data and settings.'
  },
  zh: {
    data: '数据',
    model: '模型',
    explore: '探索',
    diagnostics: '诊断',
    metric: '指标',
    surface: '拟合曲面',
    annual: '年变化率',
    shift: '等效年龄移动',
    acceleration: '对数率加速度',
    gradient: '年龄梯度',
    more: '更多指标',
    less: '收起指标',
    export: '导出图表',
    selected: '选中位置',
    year: '时期',
    age: '年龄',
    invalidYear: '请输入有效的有限时期数值，选中位置尚未改变。',
    invalidAge: '请输入有效的有限年龄数值，选中位置尚未改变。',
    interval: '显示 95% UI',
    viewDiagnostics: '查看模型诊断',
    historical: '时期',
    dataTitle: '输入数据',
    source: '加载示例',
    imported: '已导入数据',
    upload: '选择 CSV',
    paste: '粘贴 CSV',
    sample: '下载示例',
    useDemo: '使用示例数据',
    csvHint: 'UTF-8 CSV · Year、Age_Group（30–34）、Count、Pop（可选 Sex）',
    uploadTitle: '拖入 CSV 文件',
    dropTitle: '松开以导入 CSV',
    uploadText: '选择 CSV 文件，或将文件拖到此处。',
    pasteLabel: '粘贴 CSV 数据',
    validate: '校验数据',
    preview: '数据预览',
    rows: '条记录',
    ageGroups: '个年龄组',
    calendarYears: '个时期',
    valid: '数据校验通过',
    exposureHint: '事件数与人口数需对应同一年龄、时期和人群。',
    configure: '设置模型',
    firstRows: '预览行',
    back: '上一页',
    next: '下一页',
    errors: '数据需要修正',
    warnings: '请核对以下项目',
    row: '行',
    uploadLimit: '请使用小于 5 MB 的 CSV。',
    uploadOnly: '请选择 .csv 文件。',
    uploadSingle: '请一次导入一个 CSV 文件。',
    readError: '无法读取此文件。',
    modelTitle: '模型参数',
    downloadTemplate: '下载模板', viewData: '查看数据', viewAll: '查看全部', downloadResults: '下载结果',
    rowCount: '记录数', dataTable: '全部结果', ageBand: '年龄段', ageCoordinate: '年龄坐标', residualTab: '拟合残差',
    language: '语言', guide: '使用说明', cite: '引用', citePending: '文章链接待提供',
    residualValue: '偏差残差', observedRate: '观测率', fittedRate: '拟合率',
    modelSubtitle: '配置广义加性模型（GAM），拟合年龄 × 时期率曲面。',
    method: '分布与平滑参数估计',
    quasi: '准 Poisson + GCV',
    quasiReml: '准 Poisson + REML',
    nb: '负二项 + REML',
    draws: '系数抽样次数',
    seed: '随机种子',
    advanced: '高级设置',
    kAge: '年龄基维度',
    kYear: '时期基维度',
    threshold: '对数率年龄梯度阈值（1/岁）',
    run: '运行分析',
    running: '正在拟合…',
    reset: '重置数据',
    runSuccess: '分析完成。',
    settingsError: '请检查抽样次数、随机种子、基维度和正数阈值。',
    diagTitle: '模型诊断',
    dataCheck: '数据校验',
    countCheck: '必需数值字段',
    gridCheck: '年龄 × 时期记录唯一',
    domainCheck: '年龄与时期覆盖',
    completeGrid: '观测网格完整',
    incompleteGrid: '观测网格有缺失组合',
    fitStatus: '模型拟合',
    convergenceStatus: '收敛状态',
    notRun: '尚未拟合',
    intervalStatus: '区间含义',
    illustrative: '模型的近似逐点 95% 不确定区间',
    openExplore: '打开曲面探索',
    png: '网页视图 PNG',
    publication: '图表',
    publicationTitle: '下载图表压缩包',
    figureFormat: '文件格式',
    pdf: 'PDF',
    paperPng: 'PNG',
    paperTiff: 'TIFF',
    paperDownload: '下载',
    paperRunning: '正在生成图表…',
    paperFailed: 'R 图表导出失败，请重试或重新运行分析。',
    paperExpired: 'R 服务中已没有此拟合结果，请重新运行分析后再导出。',
    fitRequired: '运行分析后即可导出拟合图表。',
    csv: '拟合数值 · CSV',
    json: '分析记录 · JSON',
    exported: '导出文件已下载。',
    figureFirst: '请在探索页导出 PNG 图表。',
    range: '95% UI',
    value: '拟合读数',
    notFitTitle: '数据已就绪',
    noInputTitle: '等待输入数据', noInputText: '导入 CSV 或加载示例。',
    fitFailed: '拟合失败，请核对数据和参数。',
    fitUnavailable: '本地 R 服务不可用，请启动或恢复服务后重试。',
    fitTimeout: '拟合超时，请降低抽样次数或基维度。',
    fitMissingPackages: 'R 服务缺少必需的软件包，请检查本地 R 环境。',
    fitInvalidResponse: 'R 服务返回的结果格式不兼容，当前未显示拟合结果。',
    fitInvalidSettings: 'R 服务拒绝了模型参数，请检查基维度和抽样次数。',
    fitInvalidData: 'R 服务拒绝了输入数据，请查看数据检查结果。',
    fitInsufficient: '观测数不足以支持当前基维度，请降低年龄和时期基维度。',
    fitNumerical: '数值不稳定，请核对计数、分母和基维度。',
    fitNoConvergence: '模型未收敛，请调整参数后重新拟合。',
    serviceBusy: 'R 服务繁忙，请稍候重试。',
    rateLimited: '分析或导出请求过于频繁，请稍候重试。',
    requestTooLarge: '数据请求超过服务限制，请使用更小的数据表。',
    cairoUnavailable: 'R 图形设备不可用，请检查本地 Cairo 图形支持。',
    invalidExportSettings: '导出参数不受支持，请选择 PDF 或 PNG，并使用 90 或 180 mm 宽度。',
    retry: '重试',
    fitted: '已拟合',
    converged: '已收敛',
    notConverged: '未收敛',
    convergenceWarning: '模型未收敛，请检查参数后再解释结果。',
    edf: '有效自由度',
    scale: '尺度参数',
    devianceExplained: '偏差解释率',
    coefficients: '系数抽样次数',
    resultInvalidated: '数据或参数已修改，请重新运行分析。',
    serverErrorCode: '服务错误代码',
    ageSections: '年龄截面', timeTrends: '分年龄时间趋势', residuals: '出生队列坐标残差',
    contours: '等高线', sectionYears: '截面时期', trendAges: '趋势年龄',
    coordinates: '观测坐标', fullScreen: '全屏', resetZoom: '重置缩放',
    resultWorkbook: '结果表格',
    resultArchive: '完整分析归档',
    downloadRunning: '正在准备下载…', downloadError: '结果下载失败，请重试。',
    sex: '性别', group: '分析组', csvSexHint: '可选 Sex 列 · 所选组分别独立拟合', exitFullScreen: '退出全屏',
    selectGroups: '选择性别', groupSelectionHint: '所选组分别拟合。',
    selectGroupRequired: '请至少勾选一组。', selectedGroups: '已选分组',
    viewGroup: '查看读数', activeGroupSelected: '当前读数与导出组',
    groupPending: '等待拟合结果', groupFailed: '拟合失败', partialSuccess: '部分组未能拟合，成功组的结果已就绪。',
    groupProgress: '各组结果', allGroupsFailed: '所选组均未能拟合，请核对各组数据和参数。'
  }
};
const CN_ERRORS = {
  EMPTY_DATA: '数据表为空。',
  MISSING_NUMBER: '缺少必需数值。',
  INVALID_NUMBER: '请填写有限数值。',
  MISSING_AGE_GROUP: '请填写年龄段，例如 30–34。',
  INVALID_AGE_GROUP: '年龄段格式应为 30–34，使用非负整数且下限不大于上限。',
  INCONSISTENT_AGE_MID: '年龄段与年龄中点不一致。',
  INCONSISTENT_AGE_GROUP: '同一性别的年龄段定义不一致。',
  OVERLAPPING_AGE_GROUPS: '同一性别的年龄段不能重叠。',
  NEGATIVE_DEATHS: 'Count 事件数不能小于零。',
  NON_POSITIVE_POP: '人口暴露必须大于零。',
  DUPLICATE_YEAR_AGE: '存在重复的年龄 × 时期记录。',
  TOO_FEW_YEARS: '至少需要 5 个不同时期。',
  TOO_FEW_AGES: '至少需要 5 个不同年龄段。',
  CONFLICTING_COUNT_COLUMNS: '计数字段重复且数值不一致，请仅保留 Count 列。',
  INCOMPLETE_GRID: '年龄 × 时期组合有缺失，请核对观测网格。',
  INVALID_CSV: 'CSV 格式无效。',
  INVALID_CSV_QUOTE: 'CSV 引号格式有误。',
  UNCLOSED_CSV_QUOTE: 'CSV 引号没有闭合。',
  UNKNOWN_COLUMN: '请保留 Year、Age_Group、Count、Pop 四列，可选添加 Sex 列。',
  MISSING_SEX: '存在 Sex 列时，每行都需要填写性别组标签。',
  BOTH_GROUP_MISMATCH: '男女数据的时期或年龄段不一致，未生成两性合计。',
  BOTH_GROUP_AMBIGUOUS: '存在多个男性或女性标签，请统一标签后生成两性合计。',
  BOTH_GROUP_INVALID_SUM: '男女事件数或人口数无法有效相加，未生成两性合计。',
  DUPLICATE_COLUMN: '列名重复。',
  MISSING_COLUMN: '缺少必需列。',
  COLUMN_COUNT: '该行列数与表头不一致。'
};
const initialData = parseCsv(demoInputCsv);
const emptyInput = prepareInputData({ ...validateRows([]), errors: [], warnings: [] });
const FIT_ERROR_KEYS = {
  NETWORK_ERROR: 'fitUnavailable', SERVICE_UNAVAILABLE: 'fitUnavailable', R_NOT_FOUND: 'fitUnavailable',
  R_UNAVAILABLE: 'fitUnavailable', R_PACKAGES_MISSING: 'fitMissingPackages',
  R_TIMEOUT: 'fitTimeout', FIT_TIMEOUT: 'fitTimeout', MISSING_R_PACKAGES: 'fitMissingPackages',
  INVALID_FIT_RESPONSE: 'fitInvalidResponse', INVALID_SETTINGS: 'fitInvalidSettings',
  INVALID_GROUP_FIT_RESPONSE: 'fitInvalidResponse', INVALID_GROUP_SELECTION: 'selectGroupRequired', TOO_MANY_GROUPS: 'fitInvalidData',
  INVALID_DATA: 'fitInvalidData', DATA_VALIDATION_ERROR: 'fitInvalidData',
  FIT_NOT_FOUND: 'paperExpired', RESULT_NOT_FOUND: 'paperExpired', FIT_EXPIRED: 'paperExpired',
  DUPLICATE_YEAR_AGE: 'fitInvalidData', INSUFFICIENT_DOMAIN: 'fitInvalidData',
  INSUFFICIENT_DATA: 'fitInsufficient', FIT_NUMERICAL_ERROR: 'fitNumerical', FIT_NOT_CONVERGED: 'fitNoConvergence',
  SERVER_BUSY: 'serviceBusy', RATE_LIMITED: 'rateLimited', BODY_TOO_LARGE: 'requestTooLarge',
  CAIRO_UNAVAILABLE: 'cairoUnavailable', INVALID_EXPORT_SETTINGS: 'invalidExportSettings',
};
function FitError({ error, t, fallback = 'fitFailed' }) {
  if (!error) return null;
  return <div className="issues error" role="alert"><strong><WarningCircle aria-hidden="true" size={18} />{t[FIT_ERROR_KEYS[error.code] || fallback]}</strong>{error.code && <small>{t.serverErrorCode}: {error.code}</small>}</div>;
}
function methodLabel(method, t) {
  return ({ 'quasi-gcv': t.quasi, 'quasi-reml': t.quasiReml, 'nb-reml': t.nb })[method] || method || '—';
}
function sexLabel(value, locale, labels = []) {
  const normalized = String(value || '').trim().toLowerCase();
  const translated = locale === 'zh' ? ({ both: '全部', male: '男性', female: '女性' })[normalized] : normalized === 'both' ? 'Both' : null;
  if (!translated) return value;
  const collision = new Set(labels.filter(item => String(item || '').trim().toLowerCase() === normalized)).size > 1;
  return collision ? `${translated} (${value})` : translated;
}
function sexFileSuffix(value) {
  return value === null || value === undefined ? '' : `_${String(value).replace(/[^\p{L}\p{N}._-]+/gu, '_')}`;
}
function IssueList({
  items,
  locale,
  warning,
  t
}) {
  if (!items?.length) return null;
  return <section className={`issues ${warning ? 'warning' : 'error'}`} role={warning ? 'status' : 'alert'}><strong><WarningCircle aria-hidden="true" size={18} />{warning ? t.warnings : t.errors}</strong><ul>{items.slice(0, 8).map((v, i) => <li key={i}>{v.row != null && `${t.row} ${v.row} · `}{v.column && `${v.column === 'Deaths' ? 'Count' : v.column}: `}{locale === 'zh' ? CN_ERRORS[v.code] || v.message : v.message}</li>)}</ul>{items.length > 8 && <span>+ {items.length - 8}</span>}</section>;
}
export function App() {
  const [locale, setLocale] = useState('en'),
    [page, setPage] = useState('explore'),
    [metric, setMetric] = useState('surface'),
    [year, setYear] = useState(null),
    [age, setAge] = useState(null),
    [yearDraft, setYearDraft] = useState(''),
    [ageDraft, setAgeDraft] = useState(''),
    [locationError, setLocationError] = useState(null),
    [showContours, setShowContours] = useState(true),
    [curveSelections, setCurveSelections] = useState([]),
    [exportOpen, setExportOpen] = useState(false);
  const [dataPreviewOpen, setDataPreviewOpen] = useState(false);
  const showIntervals = true;
  const [inputData, setData] = useState(emptyInput),
    [activeSex, setActiveSex] = useState(null),
    [fileName, setFileName] = useState(''),
    [uploaded, setUploaded] = useState(false),
    [pasteOpen, setPasteOpen] = useState(false),
    [csvText, setCsvText] = useState(''),
    [tablePage, setTablePage] = useState(0),
    [uploadError, setUploadError] = useState(''),
    [dragging, setDragging] = useState(false);
  const [model, setModel] = useState({
      ...defaultModelSettings
    }),
    [advanced, setAdvanced] = useState(false),
    [modelError, setModelError] = useState(false),
    [running, setRunning] = useState(false),
    [groupFits, setGroupFits] = useState([]),
    [fitError, setFitError] = useState(null),
    [toast, setToast] = useState(''),
    [pngPreview, setPngPreview] = useState(null),
    [paperOpen, setPaperOpen] = useState(false),
    [paperFormat, setPaperFormat] = useState('pdf'),
    [paperRunning, setPaperRunning] = useState(false),
    [paperError, setPaperError] = useState(null),
    [downloadRunning, setDownloadRunning] = useState(false),
    [downloadError, setDownloadError] = useState(null);
  const chartHandlesRef = useRef(new Map()),
    fileRef = useRef(null),
    exportRef = useRef(null),
    requestRef = useRef(null),
    paperRequestRef = useRef(null),
    revisionRef = useRef(0),
    activeSexRef = useRef(activeSex),
    downloadRequestRef = useRef(null),
    acceptDataRef = useRef(null);
  acceptDataRef.current = acceptData;
  const csvImporter = useMemo(() => createCsvImporter({
    onAccept: (validated, name) => acceptDataRef.current(validated, name),
    onError: setUploadError,
    resetInput: () => { if (fileRef.current) fileRef.current.value = ''; },
  }), []);
  const fileDrop = useMemo(() => createFileDropHandlers({
    onFiles: files => { void csvImporter.importFiles(files); },
    onActive: setDragging,
  }), [csvImporter]);
  useEffect(() => {
    window.addEventListener('dragover', fileDrop.onWindowDragOver);
    window.addEventListener('drop', fileDrop.onWindowDrop);
    window.addEventListener('dragend', fileDrop.reset);
    return () => {
      window.removeEventListener('dragover', fileDrop.onWindowDragOver);
      window.removeEventListener('drop', fileDrop.onWindowDrop);
      window.removeEventListener('dragend', fileDrop.reset);
      csvImporter.invalidate();
    };
  }, [csvImporter, fileDrop]);
  activeSexRef.current = activeSex;
  const groups = inputData.groups || [];
  const multipleGroups = groups.length > 1;
  const selectedSexes = useMemo(() => availableGroupSelection(groups), [groups]);
  const basisSummary = useMemo(() => minimumGroupSummary(groups), [groups]);
  const inputErrors = inputData.errors.filter(error => !multipleGroups || !['TOO_FEW_YEARS', 'TOO_FEW_AGES'].includes(error.code));
  const canRun = selectedSexes.length > 0 && inputErrors.length === 0;
  const successfulFits = groupFits.filter(entry => entry.status === 'fulfilled');
  const result = successfulFits.find(entry => entry.sex === activeSex)?.result || null;
  const visibleFitError = fitError || (groupFits.length === 1 ? groupFits.find(entry => entry.status === 'rejected')?.error : null);
  const groupCurves = curveSelections.find(entry => entry.sex === activeSex);
  const sectionYears = groupCurves?.sectionYears || [];
  const trendAges = groupCurves?.trendAges || [];
  function setGroupCoordinates(field, value) {
    setCurveSelections(previous => previous.map(entry => entry.sex === activeSex ? { ...entry, [field]: value } : entry));
  }
  const setSectionYears = value => setGroupCoordinates('sectionYears', value);
  const setTrendAges = value => setGroupCoordinates('trendAges', value);
  function chartHandles(value) {
    if (!chartHandlesRef.current.has(value)) chartHandlesRef.current.set(value, { chart: { current: null }, frame: { current: null } });
    return chartHandlesRef.current.get(value);
  }
  const { chart: chartRef, frame: chartFrameRef } = chartHandles(activeSex);
  const data = useMemo(() => {
    if (!(inputData.groups?.length > 1)) return inputData;
    return validateRows(groupRows(inputData.rows, activeSex));
  }, [inputData, activeSex]);
  const groupLabel = multipleGroups ? data.rows.find(row => row.Sex)?.Sex || '' : '';
  const groupDisplayLabel = sexLabel(groupLabel, locale, groups.map(item => item.sex));
  const displayedMetric = page === 'diagnostics' ? 'residuals' : metric;
  const curve = ['ageSections', 'timeTrends'].includes(metric);
  const readoutMetric = curve || metric === 'surface' ? 'rate' : metric;
  const readoutFormatMetric = metric === 'surface' ? 'ageSections' : displayedMetric;
  const t = COPY[locale],
    meta = METRIC_META[displayedMetric],
    summary = data.summary || {
      count: 0,
      years: [],
      ages: [],
      minYear: null,
      maxYear: null,
      minAge: null,
      maxAge: null
    };
  const fitYears = useMemo(() => result ? [...result.grid.years].sort((a, b) => a - b) : [], [result]);
  const fitAges = useMemo(() => result ? [...result.grid.ages].sort((a, b) => a - b) : [], [result]);
  const domain = useMemo(() => result ? {
    minYear: fitYears[0], maxYear: fitYears.at(-1), minAge: fitAges[0], maxAge: fitAges.at(-1),
  } : {
    minYear: summary.minYear ?? null,
    maxYear: summary.maxYear ?? null,
    minAge: summary.minAge ?? null,
    maxAge: summary.maxAge ?? null
  }, [result, fitYears, fitAges, summary.minYear, summary.maxYear, summary.minAge, summary.maxAge]);
  const ticks = useMemo(() => !fitYears.length ? [] : [...new Set(Array.from({ length: Math.min(7, fitYears.length) }, (_, index) => Math.round(index * (fitYears.length - 1) / Math.max(1, Math.min(7, fitYears.length) - 1))))].map(index => ({ year: fitYears[index], index })), [fitYears]);
  const point = useMemo(() => nearestResultPoint(result, year, age), [result, year, age]);
  const residualPoint = useMemo(() => nearestResidualObservation(result, year, age), [result, year, age]);
  const fitMethod = result?.settings?.method || result?.diagnostics?.method;
  const pointMask = curve ? null : metricMaskReason(point, metric, result?.grid, locale);
  const currentYearIndex = Math.max(0, fitYears.indexOf(point?.year ?? year));
  const resultCaption = meta.title[locale];
  const previewInputRows = inputData.sourceRows || inputData.rows;
  const hasInput = previewInputRows.length > 0;
  const previewRows = previewInputRows.slice(tablePage * 8, tablePage * 8 + 8);
  const hasSexColumn = multipleGroups && previewInputRows.some(row => row.Sex !== undefined);
  const previewColumns = ['Year', previewInputRows.some(row => row.Age_Group !== undefined) ? 'Age_Group' : 'Age_Mid', 'Deaths', 'Pop', ...(hasSexColumn ? ['Sex'] : [])];
  const ageOptions = useMemo(() => ageGroupOptions(result, data.rows, activeSex), [result, data.rows, activeSex]);
  const curveOptions = useMemo(() => groupCurveOptions(result), [result]);
  function navigate(next) {
    setPage(next);
    setExportOpen(false);
  }
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);
  useEffect(() => {
    setYearDraft(formatCoordinateDraft(year));
    setAgeDraft(formatCoordinateDraft(age));
    setLocationError(null);
  }, [year, age, result]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (exportOpen) exportRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  }, [exportOpen]);
  useEffect(() => {
    const listener = e => {
        if (e.key === 'Escape') {
          setExportOpen(false);
          setPngPreview(null);
          setDataPreviewOpen(false);
          closePaper();
        }
      },
      outside = e => {
        if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false);
      };
    document.addEventListener('keydown', listener);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', listener);
      document.removeEventListener('pointerdown', outside);
      revisionRef.current += 1;
      requestRef.current?.abort();
      paperRequestRef.current?.abort();
      downloadRequestRef.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!pngPreview && !paperOpen && !dataPreviewOpen) return;
    const trapFocus = event => {
      if (event.key !== 'Tab') return;
      const controls = [...document.querySelectorAll('.export-preview button:not([disabled]), .export-preview a[href], .export-preview select:not([disabled]), .export-preview input:not([disabled])')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      document.removeEventListener('keydown', trapFocus);
      if (pngPreview) setTimeout(() => URL.revokeObjectURL(pngPreview.url), 60000);
      exportRef.current?.querySelector('button')?.focus();
    };
  }, [pngPreview, paperOpen, dataPreviewOpen]);
  function selectLocation({
    year: y,
    age: a
  }) {
    const selected = page === 'diagnostics' ? nearestResidualObservation(result, y, a) : nearestResultPoint(result, y, a);
    if (!selected) return;
    setYear(selected.year);
    setAge(selected.age);
    setYearDraft(formatCoordinateDraft(selected.year));
    setAgeDraft(formatCoordinateDraft(selected.age));
    setLocationError(null);
  }
  function commitLocationDraft(field) {
    const value = coordinateDraftValue(field === 'year' ? yearDraft : ageDraft);
    if (value === null) {
      setLocationError(field);
      return;
    }
    // Blurring a rounded display must not replace the exact selected grid point.
    const currentDisplay = formatCoordinateDraft(field === 'year' ? year : age);
    if (value === coordinateDraftValue(currentDisplay)) {
      if (field === 'year') setYearDraft(currentDisplay); else setAgeDraft(currentDisplay);
      setLocationError(null);
      return;
    }
    selectLocation({ year: field === 'year' ? value : year, age: field === 'age' ? value : age });
  }
  function locationDraftKey(event, field) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitLocationDraft(field);
  }
  function invalidateResult() {
    revisionRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    paperRequestRef.current?.abort();
    paperRequestRef.current = null;
    downloadRequestRef.current?.abort();
    downloadRequestRef.current = null;
    setGroupFits([]);
    setCurveSelections([]);
    setFitError(null);
    setRunning(false);
    setExportOpen(false);
    setPngPreview(null);
    setPaperOpen(false);
    setPaperRunning(false);
    setPaperError(null);
    setDownloadError(null);
    setDownloadRunning(false);
  }
  function acceptData(validated, name, isUpload = true) {
    csvImporter.invalidate();
    fileDrop.reset();
    invalidateResult();
    const prepared = prepareInputData(validated);
    setData(prepared);
    setActiveSex(prepared.groups?.[0]?.sex ?? null);
    activeSexRef.current = prepared.groups?.[0]?.sex ?? null;
    setTablePage(0);
    setFileName(name);
    setUploaded(isUpload);
    setUploadError('');
    setDataPreviewOpen(false);
    const acceptedSummary = prepared.groups?.[0]?.summary || prepared.summary;
    if (prepared.groups?.length) setModel(prev => clampGroupSettings(prev, prepared.groups));
    if (!prepared.errors.length && acceptedSummary?.years?.length && acceptedSummary?.ages?.length) {
      setYear(Math.max(acceptedSummary.minYear, Math.min(acceptedSummary.maxYear, 2005)));
      setAge(Math.max(acceptedSummary.minAge, Math.min(acceptedSummary.maxAge, 62.5)));
    } else {
      setYear(null);
      setAge(null);
    }
  }
  function activateGroup(value, location) {
    const entry = successfulFits.find(item => item.sex === value);
    if (!entry) return;
    if (value !== activeSex) {
      setPngPreview(null);
      setExportOpen(false);
    }
    activeSexRef.current = value;
    setActiveSex(value);
    const selected = page === 'diagnostics' ? nearestResidualObservation(entry.result, location?.year ?? year, location?.age ?? age) : nearestResultPoint(entry.result, location?.year ?? year, location?.age ?? age);
    if (selected) { setYear(selected.year); setAge(selected.age); }
  }
  async function runAnalysis(event) {
    event?.preventDefault();
    const settings = normalizedModelSettings(clampGroupSettings(model, groups), basisSummary);
    setModelError(!settings);
    if (!settings || !canRun || running) return;
    invalidateResult();
    const revision = revisionRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    setRunning(true);
    setGroupFits(selectedSexes.map(value => ({ sex: value, status: 'pending' })));
    try {
      const payload = await taskRequest('/api/fit-groups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: inputData.sourceRows || inputData.rows, selectedSexes, settings, provenance: uploaded ? { source: 'STANDARD_COUNT_EXPOSURE_CSV', filename: fileName } : demoProvenance }), signal: controller.signal,
      }, { consume: async response => {
        let payload;
        try { payload = await response.json(); } catch {
          const error = new Error('INVALID_FIT_RESPONSE');
          error.code = response.ok ? 'INVALID_FIT_RESPONSE' : 'SERVICE_UNAVAILABLE';
          throw error;
        }
        if (!response.ok) {
          const error = new Error(payload?.error?.message || payload?.message || 'R_FIT_ERROR');
          error.code = payload?.error?.code || payload?.code || 'R_FIT_ERROR';
          throw error;
        }
        assertGroupFitResponse(payload, selectedSexes);
        return payload;
      } });
      if (revision !== revisionRef.current) return;
      setGroupFits(payload.results);
      const fulfilled = payload.results.filter(entry => entry.status === 'fulfilled');
      setCurveSelections(fulfilled.map(entry => ({ sex: entry.sex, ...groupCurveCoordinates(entry.result, uploaded) })));
      const activeEntry = fulfilled.find(entry => entry.sex === activeSexRef.current) || fulfilled[0];
      if (activeEntry) {
        setActiveSex(activeEntry.sex);
        activeSexRef.current = activeEntry.sex;
        const selected = nearestResultPoint(activeEntry.result, year, age);
        if (selected) { setYear(selected.year); setAge(selected.age); }
      }
      setPage('explore');
      setToast(fulfilled.length === payload.results.length ? 'runSuccess' : fulfilled.length ? 'partialSuccess' : 'allGroupsFailed');
    } catch (error) {
      if (error.name === 'AbortError' || revision !== revisionRef.current) return;
      setGroupFits([]);
      setFitError({ code: error.code || (error.message === 'INVALID_FIT_RESPONSE' ? error.message : error instanceof TypeError ? 'NETWORK_ERROR' : 'R_FIT_ERROR') });
    } finally {
      if (revision === revisionRef.current) {
        setRunning(false);
        requestRef.current = null;
      }
    }
  }
  async function exportData(kind) {
    if (kind === 'paper') {
      if (!result?.meta?.fitId) { setToast('fitRequired'); setExportOpen(false); return; }
      setPaperError(null);
      setPaperOpen(true);
      setExportOpen(false);
      return;
    }
    if (!result) {
      setToast('notRun');
      setExportOpen(false);
      return;
    }
    if (kind === 'png') {
      if (!chartRef.current) {
        setToast('figureFirst');
        setExportOpen(false);
        return;
      }
      const encoded = chartRef.current.getDataURL({
        type: 'png',
        pixelRatio: 2,
        backgroundColor: '#ffffff',
        excludeComponents: ['toolbox', 'dataZoom']
      }).split(',')[1];
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      setPngPreview({
        url: URL.createObjectURL(new Blob([bytes], {
          type: 'image/png'
        })),
        filename: `BLSD_${displayedMetric}${sexFileSuffix(activeSex)}_fitted.png`
      });
    } else {
      if (downloadRunning || !result?.meta?.fitId) return;
      const revision = revisionRef.current;
      const controller = new AbortController();
      downloadRequestRef.current = controller;
      setDownloadRunning(true);
      setDownloadError(null);
      setExportOpen(false);
      try {
        const query = new URLSearchParams({ format: 'zip', layout: 'readable-v1', scope: 'analysis', contents: kind === 'workbooks' ? 'excel' : 'archive', locale });
        const { blob, filename } = await taskRequest(`/api/results/${encodeURIComponent(result.meta.fitId)}/download?${query}`, { signal: controller.signal }, { consume: async response => {
          if (!response.ok || !exportResponseMatchesFormat(response.headers.get('content-type'), 'zip')) {
            const payload = await response.json().catch(() => null);
            const error = new Error('RESULT_DOWNLOAD_ERROR');
            error.code = payload?.error?.code || payload?.code || 'RESULT_DOWNLOAD_ERROR';
            throw error;
          }
          const blob = await response.blob();
          if (!blob.size) throw new Error('RESULT_DOWNLOAD_ERROR');
          return { blob, filename: filenameFromDisposition(response.headers.get('content-disposition'), `BLSD_${kind === 'workbooks' ? 'tables' : 'archive'}_all_sexes.zip`) };
        } });
        if (controller.signal.aborted || revision !== revisionRef.current) return;
        downloadFile(filename, blob, blob.type);
        setToast('exported');
      } catch (error) {
        if (error.name !== 'AbortError' && revision === revisionRef.current) setDownloadError({ code: error.code || 'RESULT_DOWNLOAD_ERROR' });
      } finally {
        if (downloadRequestRef.current === controller) { setDownloadRunning(false); downloadRequestRef.current = null; }
      }
    }
    setExportOpen(false);
  }
  function setNumber(name, value) {
    invalidateResult();
    setModel(prev => ({
      ...prev,
      [name]: value
    }));
  }
  function resetData() {
    csvImporter.invalidate();
    fileDrop.reset();
    invalidateResult();
    setData(emptyInput);
    setActiveSex(null);
    activeSexRef.current = null;
    setFileName('');
    setUploaded(false);
    setCsvText('');
    setPasteOpen(false);
    setTablePage(0);
    setUploadError('');
    setDataPreviewOpen(false);
    setYear(null);
    setAge(null);
    setYearDraft('');
    setAgeDraft('');
    setLocationError(null);
    setAdvanced(false);
    setModelError(false);
    setToast('');
    if (fileRef.current) fileRef.current.value = '';
  }
  function closePaper() {
    paperRequestRef.current?.abort();
    paperRequestRef.current = null;
    setPaperOpen(false);
    setPaperRunning(false);
  }
  async function exportPublication(event) {
    event.preventDefault();
    if (!result?.meta?.fitId || paperRunning) return;
    const revision = revisionRef.current;
    const controller = new AbortController();
    paperRequestRef.current = controller;
    setPaperError(null);
    setPaperRunning(true);
    try {
      const groupSelections = successfulFits.map(entry => {
        const selections = curveSelections.find(item => item.sex === entry.sex) ?? groupCurveCoordinates(entry.result);
        return { fitId: entry.result.meta.fitId, sectionYears: selections.sectionYears, trendAges: selections.trendAges };
      });
      const { blob, filename } = await taskRequest('/api/export-bundle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fitId: result.meta.fitId, showContours, showIntervals, groupSelections,
          format: paperFormat, locale, widthMm: 180, dpi: 600 }),
        signal: controller.signal,
      }, { consume: async response => {
        if (!response.ok || !exportResponseMatchesFormat(response.headers.get('content-type'), 'zip')) {
          let payload;
          try { payload = await response.json(); } catch { payload = null; }
          const error = new Error('R_EXPORT_ERROR');
          error.code = payload?.error?.code || payload?.code || 'R_EXPORT_ERROR';
          throw error;
        }
        const blob = await response.blob();
        if (!blob.size || !exportResponseMatchesFormat(blob.type, 'zip')) {
          const error = new Error('INVALID_EXPORT_RESPONSE'); error.code = 'INVALID_EXPORT_RESPONSE'; throw error;
        }
        return { blob, filename: filenameFromDisposition(response.headers.get('content-disposition'), `BLSD_figures_all_sexes.${paperFormat}.zip`) };
      } });
      if (controller.signal.aborted || revision !== revisionRef.current) return;
      downloadFile(filename, blob, blob.type);
      setToast('exported');
      setPaperOpen(false);
    } catch (error) {
      if (error.name === 'AbortError' || revision !== revisionRef.current) return;
      setPaperError({ code: error.code || (error instanceof TypeError ? 'NETWORK_ERROR' : 'R_EXPORT_ERROR') });
    } finally {
      if (revision === revisionRef.current && paperRequestRef.current === controller) {
        setPaperRunning(false);
        paperRequestRef.current = null;
      }
    }
  }
  function activeGroupControl() {
    if (!multipleGroups || !successfulFits.length) return null;
    return <label className="active-group-control">{t.sex}<select aria-label={t.sex} value={activeSex ?? ''} onChange={event => activateGroup(event.target.value)}>
      {groupFits.map(entry => <option key={entry.sex} value={entry.sex} disabled={entry.status !== 'fulfilled'}>{sexLabel(entry.sex, locale, groups.map(item => item.sex))}{entry.status === 'rejected' ? ` · ${t.groupFailed}` : ''}</option>)}
    </select></label>;
  }
  const diagnosticMetric = displayedMetric === 'residuals';
  function navigateDownloadMenu(event) {
    if (event.key === 'Escape') {
      setExportOpen(false);
      exportRef.current?.querySelector('.export-button')?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  const downloadControl = <div className="export-control" ref={exportRef}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExportOpen(false); }}>
    <button type="button" className="secondary export-button" disabled={!result || downloadRunning} onClick={() => setExportOpen(!exportOpen)}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setExportOpen(true); } }}
      aria-expanded={exportOpen} aria-haspopup="menu" aria-controls="download-results-menu" aria-busy={downloadRunning}><DownloadSimple aria-hidden="true" size={17} /><span role={downloadRunning ? 'status' : undefined}>{t[downloadRunning ? 'downloadRunning' : 'downloadResults']}</span></button>
    {exportOpen && <div className="export-menu" id="download-results-menu" role="menu" aria-label={t.downloadResults} onKeyDown={navigateDownloadMenu}>
      <button type="button" role="menuitem" className="data-export-option" disabled={!result?.meta?.fitId} onClick={() => exportData('paper')}><DownloadSimple aria-hidden="true" size={19} /><span><strong>{t.publication}</strong></span></button>
      <button type="button" role="menuitem" className="data-export-option" disabled={!result?.meta?.fitId || downloadRunning} onClick={() => exportData('workbooks')}><FileXls aria-hidden="true" size={19} /><span><strong>{t.resultWorkbook}</strong></span></button>
      <button type="button" role="menuitem" className="data-export-option" disabled={!result?.meta?.fitId || downloadRunning} onClick={() => exportData('zip')}><FileArchive aria-hidden="true" size={19} /><span><strong>{t.resultArchive}</strong></span></button>
      {!result && <small className="export-menu-note">{t.fitRequired}</small>}
    </div>}
  </div>;
  return <div className="studio workbench">
    <a className="skip-link" href="#main-content">{locale === 'zh' ? '跳到主要内容' : 'Skip to content'}</a>
    <header className="topbar"><a className="wordmark" href="#main-content">BLSD Tool</a><div className="header-actions"><HeaderTools locale={locale} onLocaleChange={setLocale} t={t} /></div></header>
    <main id="main-content" className="main-content workspace-layout">
      <div className="workspace-sidebar"><WorkspaceInput t={t} locale={locale} dragging={dragging} fileDrop={fileDrop} fileRef={fileRef}
        onImportFiles={files => csvImporter.importFiles(files)} pasteOpen={pasteOpen} onTogglePaste={() => setPasteOpen(!pasteOpen)}
        csvText={csvText} onCsvTextChange={setCsvText} onAcceptCsv={text => acceptData(parseCsv(text), 'pasted_data.csv')}
        onDownloadTemplate={() => downloadFile('example_data.csv', demoInputCsv, 'text/csv;charset=utf-8')}
        onUseDemo={() => acceptData(initialData, 'example_data.csv', false)}
        uploadError={uploadError} dataIssues={<><IssueList items={inputData.errors} locale={locale} t={t} /><IssueList items={inputData.warnings} locale={locale} warning t={t} /></>}
        model={model} onModelChange={setNumber} advanced={advanced} onToggleAdvanced={() => setAdvanced(!advanced)} basisSummary={basisSummary}
        modelError={modelError} fitIssues={<FitError error={visibleFitError} t={t} />} running={running} canRun={canRun} onRunAnalysis={runAnalysis} onResetData={resetData}
        hasInput={hasInput} downloadControl={downloadControl} />
        <SidebarDataPreview rows={previewInputRows} columns={previewColumns} locale={locale} t={t} onViewAll={() => setDataPreviewOpen(true)} sexLabel={sexLabel} groupLabels={groups.map(group => group.sex)} layoutKey={`${result?.meta?.fitId || ''}:${displayedMetric}`} />
        <SidebarFitSummary result={result} locale={locale} methodLabel={methodLabel(fitMethod, t)} groupLabel={groupDisplayLabel} titleGroupLabel="" />
      </div>
      <section className="workspace-results" aria-label={locale === 'zh' ? '分析结果' : 'Analysis results'}>
        <div className="metric-tabs" role="tablist" aria-label={t.metric}>{['surface', 'annual', 'acceleration', 'ageSections', 'timeTrends', 'gradient', 'shift', 'residuals'].map(key => <button type="button" key={key} id={`metric-${key}`} role="tab" aria-selected={displayedMetric === key} aria-controls="result-panel" className={`metric-item${displayedMetric === key ? ' selected' : ''}`} onClick={() => { if (key !== 'residuals') setMetric(key); else if (residualPoint) { setYear(residualPoint.year); setAge(residualPoint.age); } navigate(key === 'residuals' ? 'diagnostics' : 'explore'); }}>{key === 'residuals' ? t.residualTab : t[key]}</button>)}</div>
        <div id="result-panel" role="tabpanel" aria-labelledby={`metric-${displayedMetric}`}>
          <div className="result-heading"><div className="result-title"><h1>{resultCaption}</h1>{meta.help && <MetricHelp key={`${displayedMetric}-${locale}`} metric={displayedMetric} locale={locale} />}</div>
            {result && <div className="chart-actions"><button type="button" className="text-link" onClick={() => chartRef.current?.dispatchAction({type:'dataZoom',start:0,end:100})}><ArrowClockwise aria-hidden="true" size={16} />{t.resetZoom}</button><button type="button" className="text-link" onClick={() => chartFrameRef.current?.requestFullscreen?.()}><ArrowsOut aria-hidden="true" size={16} />{t.fullScreen}</button></div>}
          </div>
          {result && <>
            <div className="readout-bar" aria-label={t.selected}>
              {activeGroupControl()}
              <div className="location-fields">
                <label htmlFor="year-input">{t.year}<input id="year-input" aria-label={t.year} aria-invalid={locationError === 'year'} aria-describedby={locationError === 'year' ? 'location-error' : undefined} disabled={!result} type="number" min={domain.minYear} max={domain.maxYear} step="any" value={yearDraft} onChange={e => {setYearDraft(e.target.value); if (locationError === 'year') setLocationError(null);}} onBlur={() => commitLocationDraft('year')} onKeyDown={e => locationDraftKey(e,'year')} /></label>
                <label htmlFor="age-input">{t.age}<input id="age-input" aria-label={t.age} aria-invalid={locationError === 'age'} aria-describedby={locationError === 'age' ? 'location-error' : undefined} disabled={!result} type="number" min={domain.minAge} max={domain.maxAge} step="any" value={ageDraft} onChange={e => {setAgeDraft(e.target.value); if (locationError === 'age') setLocationError(null);}} onBlur={() => commitLocationDraft('age')} onKeyDown={e => locationDraftKey(e,'age')} /></label>
              </div>
              <div className="point-details" aria-live="polite">{diagnosticMetric ? <>
                <ReadoutValue label={t.residualValue} value={formatResultValue(residualPoint?.devianceResidual, 'residuals')} />
                <ReadoutValue label={t.fittedRate} value={formatResultNumber(residualPoint?.fittedRate, 2)} unit={METRIC_META.ageSections.readoutUnit[locale]} />
                <ReadoutValue label={t.observedRate} value={formatResultNumber(residualPoint?.observedRate, 2)} unit={METRIC_META.ageSections.readoutUnit[locale]} />
              </> : <><ReadoutValue label={METRIC_META[readoutFormatMetric].readoutLabel[locale]} value={formatResultValue(metricValue(point, readoutMetric), readoutFormatMetric)} unit={METRIC_META[readoutFormatMetric].readoutUnit[locale]} />{pointMask && <small>{pointMask}</small>}</>}</div>
              {!diagnosticMetric && ['surface','annual'].includes(metric) && <div className="display-switches"><label className="interval-toggle"><span>{t.contours}</span><input type="checkbox" role="switch" disabled={!result} checked={showContours} onChange={e=>setShowContours(e.target.checked)} /></label></div>}
            </div>
            {locationError && <p id="location-error" className="error-line" role="alert">{t[locationError === 'year' ? 'invalidYear' : 'invalidAge']}</p>}
            {!diagnosticMetric && curve && <details className="curve-settings" open><summary>{metric === 'ageSections' ? t.sectionYears : t.trendAges}</summary><div className="coordinate-options">{(metric === 'ageSections' ? curveOptions.sectionYears : curveOptions.trendAges).map(coordinate => {
              const chosen = metric === 'ageSections' ? sectionYears : trendAges;
              const setChosen = metric === 'ageSections' ? setSectionYears : setTrendAges;
              return <label key={coordinate}><input type="checkbox" disabled={!result} checked={chosen.includes(coordinate)} onChange={e=>setChosen(e.target.checked ? [...chosen,coordinate].sort((a,b)=>a-b) : chosen.length > 1 ? chosen.filter(value=>value!==coordinate) : chosen)} />{metric === 'timeTrends' ? formattedAgeLabel(coordinate,ageOptions) : coordinate}</label>;
            })}</div></details>}
          </>}
          <FitError error={downloadError} t={t} fallback="downloadError" />
          {result?.diagnostics?.converged === false && <p className="issues warning" role="status">{t.convergenceWarning}</p>}
          {multipleGroups && groupFits.filter(entry => entry.status === 'rejected').map(entry => <section key={entry.sex} className="group-fit-error" aria-label={`${t.sex}: ${sexLabel(entry.sex, locale, groups.map(item => item.sex))}`}><strong>{t.sex}: {sexLabel(entry.sex, locale, groups.map(item => item.sex))}</strong><FitError error={entry.error} t={t} /></section>)}
          <div className={`chart-frame${result ? ' scientific-frame' : ''}${diagnosticMetric ? ' residual-chart' : ''}${!diagnosticMetric && metric === 'timeTrends' && result ? ' facet-frame' : ''}`} ref={chartFrameRef}>
            <button type="button" className="exit-fullscreen secondary" onClick={()=>document.exitFullscreen?.()}><X aria-hidden="true" size={16} />{t.exitFullScreen}</button>
            {result ? <SurfaceChart result={result} metric={displayedMetric} year={year} age={age} locale={locale} showIntervals={showIntervals} showContours={showContours} sectionYears={sectionYears} trendAges={trendAges} onSelect={selectLocation} chartRef={chartRef} /> : <section className="upload-zone fit-empty" aria-busy={running}><ChartLine aria-hidden="true" size={36} weight="light" /><h2>{running ? t.running : hasInput ? t.notFitTitle : t.noInputTitle}</h2>{!hasInput && <p>{t.noInputText}</p>}</section>}
          </div>
        </div>
      </section>
    </main>
    {dataPreviewOpen && hasInput && <div className="modal-backdrop"><section className="export-preview data-preview" role="dialog" aria-modal="true" aria-label={t.preview}>
      <div className="preview-heading"><h2>{t.preview}</h2><button type="button" autoFocus aria-label={locale==='zh' ? '关闭数据预览' : 'Close data preview'} onClick={()=>setDataPreviewOpen(false)}><X aria-hidden="true" size={22}/></button></div>
      <div className="table-scroll"><table><thead><tr>{previewColumns.map(key=><th key={key}>{locale === 'zh' || key === 'Year' ? previewColumnHeading(key, locale) : key === 'Deaths' ? 'Count' : key}</th>)}</tr></thead><tbody>{previewRows.map((row,index)=><tr key={index}>{previewColumns.map(key=><td key={key}>{typeof row[key] === 'number' ? key === 'Year' ? String(row[key]) : row[key].toLocaleString(locale==='zh' ? 'zh-CN':'en-US',{maximumFractionDigits:8}) : key==='Sex' ? sexLabel(row[key],locale,groups.map(item=>item.sex)) : row[key]}</td>)}</tr>)}</tbody></table></div>
      <div className="pagination"><small>{t.firstRows} {previewInputRows.length ? tablePage*8+1 : 0}–{Math.min(previewInputRows.length,tablePage*8+8)} / {previewInputRows.length}</small><div><button type="button" className="secondary" disabled={!tablePage} onClick={()=>setTablePage(tablePage-1)}>{t.back}</button><button type="button" className="secondary" disabled={(tablePage+1)*8>=previewInputRows.length} onClick={()=>setTablePage(tablePage+1)}>{t.next}</button></div></div>
    </section></div>}
{paperOpen && <div className="modal-backdrop"><form className="export-preview paper-export" role="dialog" aria-modal="true" aria-label={t.publicationTitle} onSubmit={exportPublication}>
  <div className="preview-heading"><h2>{t.publicationTitle}</h2><button autoFocus type="button" aria-label={locale === 'zh' ? '关闭导出' : 'Close export'} onClick={closePaper}><X aria-hidden="true" size={22} /></button></div>
  <div className="paper-options"><strong>{locale === 'zh' ? `共 ${successfulFits.length} 个性别组，${successfulFits.length * 8} 张图表` : `${successfulFits.length} sex group${successfulFits.length === 1 ? '' : 's'} · ${successfulFits.length * 8} figures`}</strong>
  {multipleGroups && <p className="figure-bundle-groups">{successfulFits.map(entry => sexLabel(entry.sex, locale, groups.map(item => item.sex))).join(' / ')}</p>}
  <ul className="figure-bundle-list">{['surface', 'annual', 'acceleration', 'ageSections', 'timeTrends', 'gradient', 'shift', 'residuals'].map(key => <li key={key}>{METRIC_META[key].title[locale]}</li>)}</ul>
  {groupFits.some(entry => entry.status === 'rejected') && <p className="error-line">{t.groupFailed}: {groupFits.filter(entry => entry.status === 'rejected').map(entry => sexLabel(entry.sex, locale, groups.map(item => item.sex))).join(' / ')}</p>}
  <div className="paper-format-field">
    <label htmlFor="paper-format">{t.figureFormat}</label><select id="paper-format" disabled={paperRunning} value={paperFormat} onChange={e => setPaperFormat(e.target.value)}><option value="png">{t.paperPng}</option><option value="pdf">{t.pdf}</option><option value="tiff">{t.paperTiff}</option></select>
  </div><FitError error={paperError} t={t} fallback="paperFailed" /></div>
  <div className="preview-actions"><span>{methodLabel(fitMethod, t)}</span><button className="primary" type="submit" disabled={paperRunning || !result?.meta?.fitId}><DownloadSimple aria-hidden="true" size={18} />{t[paperRunning ? 'paperRunning' : 'paperDownload']}</button></div>
</form></div>}
{pngPreview && <div className="modal-backdrop"><section className="export-preview" role="dialog" aria-modal="true" aria-label={locale === 'zh' ? 'PNG 图表预览' : 'PNG figure preview'}><div className="preview-heading"><h2>{locale === 'zh' ? 'PNG 图表预览' : 'PNG figure preview'}</h2><button autoFocus aria-label={locale === 'zh' ? '关闭预览' : 'Close preview'} onClick={() => setPngPreview(null)}><X aria-hidden="true" size={22} /></button></div><img src={pngPreview.url} alt={resultCaption} /><div className="preview-actions"><span>{resultCaption}</span><a className="primary" href={pngPreview.url} download={pngPreview.filename}><DownloadSimple aria-hidden="true" size={18} />{locale === 'zh' ? '下载 PNG' : 'Download PNG'}</a></div></section></div>}
{toast && <div className="toast" role="status"><CheckCircle aria-hidden="true" size={20} /><span>{t[toast] || toast}</span><button aria-label={locale === 'zh' ? '关闭提示' : 'Dismiss notification'} onClick={() => setToast('')}><X aria-hidden="true" size={17} /></button></div>}
</div>;
}
