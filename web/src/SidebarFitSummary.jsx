import { formatPValue, jointSmoothDiagnostics } from './fitSummaryHelpers.js';

const COPY = {
  zh: {
    title: '模型拟合信息', model: '模型', method: '分布与平滑参数估计', group: '性别', converged: '已收敛', notConverged: '未收敛', convergence: '收敛状态', n: '记录数', edf: '模型 EDF', scale: '尺度参数', deviance: '偏差解释率', theta: '负二项 θ', aic: 'AIC', details: '检验与参数', draws: '系数抽样次数', seed: '随机种子', kAge: '年龄基维度', kYear: '时期基维度', threshold: '对数率年龄梯度阈值', years: '时期范围', ages: '年龄中点范围', gridPoints: '预测网格点数', covariance: '系数协方差', conditional: '条件于平滑参数', corrected: '含平滑参数不确定性校正', formula: '模型公式', versions: '软件版本', coefficientCount: '系数数目',
    smoothP: '平滑项近似 P', basisP: '基维度诊断 P', smoothTitle: '年龄—时期联合平滑项的近似检验', basisTitle: '基维度充分性诊断：结合 k-index、EDF 和增大基维度后的拟合结果判断', unavailable: '不可用', smoothTests: '平滑项检验', smoothEdf: '平滑项 EDF', referenceDf: '参考自由度', p: '近似 P 值', basisTests: '基维度诊断', kPrime: '最大平滑项 EDF', kIndex: 'k-index', permutationP: '置换 P 值', permutations: '置换次数', diagnosticSeed: '诊断种子', interceptTests: '截距检验', estimate: '估计值', se: '标准误', modelSettings: '模型与参数', residualDf: '残差自由度', adjustedR2: '调整 R²', note: '平滑项 P 值为近似检验，未计入平滑参数估计的不确定性；基维度 P 值用于残差结构诊断。', zeroPermutation: '置换中未出现更小的 k-index；显示置换分辨率，下载结果保留原始 P 估计值。',
  },
  en: {
    title: 'Model fit', model: 'Model', method: 'Distribution and smoothing selection', group: 'Sex', converged: 'Converged', notConverged: 'Not converged', convergence: 'Convergence', n: 'Records', edf: 'Model EDF', scale: 'Scale parameter', deviance: 'Deviance explained', theta: 'Negative binomial θ', aic: 'AIC', details: 'Tests and parameters', draws: 'Coefficient draws', seed: 'Random seed', kAge: 'Age basis dimension', kYear: 'Period basis dimension', threshold: 'Log-rate age-gradient threshold', years: 'Period range', ages: 'Age midpoint range', gridPoints: 'Prediction grid points', covariance: 'Coefficient covariance', conditional: 'Conditional on smoothing parameters', corrected: 'Corrected for smoothing uncertainty', formula: 'Model formula', versions: 'Software versions', coefficientCount: 'Coefficients',
    smoothP: 'Smooth P (approx.)', basisP: 'Basis check P', smoothTitle: 'Approximate test of the joint age–period smooth', basisTitle: 'Basis adequacy diagnostic: assess with k-index, EDF and a refit using a larger basis', unavailable: 'Unavailable', smoothTests: 'Smooth-term test', smoothEdf: 'Smooth EDF', referenceDf: 'Reference degrees of freedom', p: 'Approximate P value', basisTests: 'Basis diagnostic', kPrime: 'Maximum smooth EDF', kIndex: 'k-index', permutationP: 'Permutation P value', permutations: 'Permutations', diagnosticSeed: 'Diagnostic seed', interceptTests: 'Intercept test', estimate: 'Estimate', se: 'Standard error', modelSettings: 'Model and parameters', residualDf: 'Residual degrees of freedom', adjustedR2: 'Adjusted R²', note: 'Smooth P values are approximate and omit smoothing-parameter uncertainty. Basis-check P values diagnose residual structure.', zeroPermutation: 'No shuffled k-index was lower; the display uses permutation resolution. Downloads retain the raw P estimate.',
  },
};

function number(value, locale, digits = 3) {
  return Number.isFinite(value) ? value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: digits }) : null;
}
function range(values, locale, calendarYears = false) {
  const finite = (values || []).filter(Number.isFinite);
  if (!finite.length) return null;
  const label = value => calendarYears ? String(value) : number(value, locale);
  return `${label(Math.min(...finite))}–${label(Math.max(...finite))}`;
}
function statisticLabel(type) {
  return ({ 'Chi-sq': 'χ²', 'Chi.sq': 'χ²', F: 'F', t: 't', z: 'z' })[type] || type;
}

/** The overview and tests all describe the active retained fit. */
export default function SidebarFitSummary({ result, locale, methodLabel, groupLabel, titleGroupLabel = groupLabel }) {
  if (!result?.meta?.fitted) return null;
  const copy = COPY[locale] || COPY.en;
  const diagnostics = result.diagnostics || {}, settings = result.settings || {}, parameters = result.parameters || {};
  const { smooth, basis } = jointSmoothDiagnostics(diagnostics);
  const smoothP = formatPValue(smooth?.pValue);
  const basisP = formatPValue(basis?.pValue, { permutations: basis?.replicates });
  const primary = [
    [copy.convergence, typeof diagnostics.converged === 'boolean' ? (diagnostics.converged ? copy.converged : copy.notConverged) : null],
    [copy.n, number(diagnostics.n, locale, 0)],
    [copy.deviance, Number.isFinite(diagnostics.devianceExplained) ? `${number(diagnostics.devianceExplained * 100, locale, 2)}%` : null],
    [copy.edf, number(diagnostics.edf, locale)],
    [copy.smoothP, smoothP ?? copy.unavailable, copy.smoothTitle],
    [copy.basisP, basisP ?? copy.unavailable, basis?.pValue === 0 ? copy.zeroPermutation : copy.basisTitle],
  ];
  const detailValues = [
    [copy.model, 'GAM'], [copy.method, methodLabel], [copy.group, groupLabel],
    [copy.scale, number(diagnostics.scale, locale)], [copy.theta, number(diagnostics.theta, locale)],
    [copy.aic, number(diagnostics.aic, locale, 2)], [copy.residualDf, number(diagnostics.residualDf, locale)],
    [copy.adjustedR2, number(diagnostics.adjustedRSquared, locale)],
    [copy.draws, number(parameters.draws ?? settings.draws, locale, 0)],
    [copy.seed, Number.isFinite(parameters.seed ?? settings.seed) ? String(parameters.seed ?? settings.seed) : null],
    [copy.kAge, number(settings.kAge, locale, 0)], [copy.kYear, number(settings.kYear, locale, 0)],
    [copy.threshold, number(settings.threshold, locale, 6)],
    [copy.years, range(result.grid?.observedYears, locale, true)], [copy.ages, range(result.grid?.observedAges, locale)],
    [copy.gridPoints, number(diagnostics.gridPoints, locale, 0)],
    [copy.coefficientCount, parameters.coefficients && typeof parameters.coefficients === 'object' ? number(Object.keys(parameters.coefficients).length, locale, 0) : null],
    [copy.covariance, diagnostics.covarianceSource === 'Vc' ? copy.corrected : diagnostics.covarianceSource === 'Vp' ? copy.conditional : diagnostics.covarianceSource],
  ];
  const readouts = entries => <dl>{entries.filter(([, value]) => value !== null && value !== undefined && value !== '').map(([label, value, title]) => <div key={label} title={title}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
  return <section className="sidebar-fit-summary" aria-label={copy.title}>
    <h2>{copy.title}{titleGroupLabel && <span className="sidebar-fit-group"> · {titleGroupLabel}</span>}</h2>
    {readouts(primary)}
    <details className="sidebar-fit-details"><summary>{copy.details}</summary>
      {smooth && <section className="sidebar-fit-test"><h3>{copy.smoothTests}</h3>{readouts([
        [copy.smoothEdf, number(smooth.edf, locale)], [copy.referenceDf, number(smooth.referenceDf, locale)],
        [statisticLabel(smooth.statisticType), number(smooth.statistic, locale)], [copy.p, smoothP ?? copy.unavailable],
      ])}</section>}
      {basis && <section className="sidebar-fit-test"><h3>{copy.basisTests}</h3>{readouts([
        [copy.kPrime, number(basis.kPrime, locale)], [copy.kIndex, number(basis.kIndex, locale)],
        [copy.permutationP, basisP ?? copy.unavailable], [copy.permutations, number(basis.replicates, locale, 0)],
        [copy.diagnosticSeed, Number.isFinite(basis.seed) ? String(basis.seed) : null],
      ])}</section>}
      {diagnostics.parametricTests?.length > 0 && <section className="sidebar-fit-test"><h3>{copy.interceptTests}</h3>{diagnostics.parametricTests.map(test => <div key={test.term}>{readouts([
        [copy.estimate, number(test.estimate, locale, 5)], [copy.se, number(test.stdError, locale, 5)],
        [statisticLabel(test.statisticType), number(test.statistic, locale)], [copy.p, formatPValue(test.pValue) ?? copy.unavailable],
      ])}</div>)}</section>}
      {(smooth || basis) && <p className="sidebar-fit-test-note">{copy.note}</p>}
      <section className="sidebar-fit-test"><h3>{copy.modelSettings}</h3>{readouts(detailValues)}</section>
      {parameters.formula && <div className="sidebar-fit-formula"><span>{copy.formula}</span><code>{parameters.formula}</code></div>}
      {(result.meta.rVersion || result.meta.mgcvVersion) && <p className="sidebar-fit-versions"><span>{copy.versions}</span>{[result.meta.rVersion, result.meta.mgcvVersion ? `mgcv ${result.meta.mgcvVersion}` : null].filter(Boolean).join(' · ')}</p>}
    </details>
  </section>;
}
