export const METRIC_META = {
  surface: {
    title: { en: 'Fitted surface', zh: '拟合曲面' },
    unit: { en: 'ln(rate per 100,000)', zh: 'ln（每10万人率）' },
    decimals: 3,
    description: {
      en: 'Fitted log rate S(age, period), with rate per 100,000.',
      zh: '年龄 × 时期上的拟合对数率 S，率以每10万人计。',
    },
  },
  annual: {
    title: { en: 'Annual rate change', zh: '年变化率' },
    unit: { en: '% / year', zh: '% / 年份' },
    decimals: 2,
    description: {
      en: 'Local annualized rate change: 100 × (exp(∂S/∂t) − 1).',
      zh: '局部年变化率：100 × (exp(∂S/∂t) − 1)。',
    },
  },
  acceleration: {
    title: { en: 'Log-rate acceleration', zh: '对数率加速度' },
    unit: { en: 'Log-rate / year²', zh: '对数率 / 年份²' },
    decimals: 5,
    description: {
      en: 'Second period derivative of the fitted log rate: ∂²S/∂t².',
      zh: '拟合对数率关于时期的二阶导数：∂²S/∂t²。',
    },
    help: {
      en: ['At a fixed age, measures how the yearly change in the fitted log rate changes over time.',
        'Positive values mean the log-rate trend is becoming more positive; negative values mean it is becoming more negative.',
        'Formula: ∂²ln(r)/∂t². Unit: 1/year².'],
      zh: ['在同一年龄，衡量拟合对数率随时期变化的速度如何改变。',
        '正值表示对数率的年变化速度增大，负值表示减小。',
        '计算：∂²ln(r)/∂t²；单位：1/年²。'],
    },
  },
  gradient: {
    title: { en: 'Age gradient', zh: '年龄梯度' },
    unit: { en: '% / age-year', zh: '% / 岁' },
    decimals: 2,
    description: {
      en: 'Local relative rate change per age-year: 100 × (exp(∂S/∂a) − 1).',
      zh: '局部年龄相对梯度：100 × (exp(∂S/∂a) − 1)。',
    },
    help: {
      en: ['At a fixed period, the local relative change in the fitted rate per additional year of age.',
        'Positive values indicate higher rates at older ages; negative values indicate lower rates.',
        'Formula: 100 × [exp(∂ln(r)/∂a) − 1]. Unit: %/age-year.'],
      zh: ['在同一时期，衡量年龄每增加一岁时拟合率的局部相对变化。',
        '正值表示率随年龄增长而升高，负值表示降低。',
        '计算：100 × [exp(∂ln(r)/∂a) − 1]；单位：%/岁。'],
    },
  },
  shift: {
    title: { en: 'Equivalent age shift', zh: '等效年龄移动速度' },
    unit: { en: 'Age-years / year', zh: '年龄岁 / 年份' },
    decimals: 3,
    description: {
      en: 'Equivalent age shift at the same fitted rate: −(∂S/∂t) / (∂S/∂a).',
      zh: '相同拟合率对应的等效年龄移动速度：−(∂S/∂t) / (∂S/∂a)。',
    },
    help: {
      en: ['The speed at which the age corresponding to the same fitted rate changes as period increases.',
        'Positive values mean movement toward older ages; negative values mean movement toward younger ages. Results are shown only when stability checks pass.',
        'Formula: −(∂ln(r)/∂t)/(∂ln(r)/∂a). Unit: age-years/year.'],
      zh: ['衡量保持相同拟合率时，等效年龄位置随时期移动的速度。',
        '正值表示移向较高年龄，负值表示移向较低年龄。结果通过稳定性检查后才显示。',
        '计算：−(∂ln(r)/∂t)/(∂ln(r)/∂a)；单位：岁/年。'],
    },
  },
  ageSections: {
    title: { en: 'Age sections', zh: '年龄截面' },
    unit: { en: 'Rate per 100,000', zh: '率（每10万人）' },
    decimals: 2,
    description: { en: 'Age profiles at selected periods.', zh: '指定时期的年龄率曲线。' },
  },
  timeTrends: {
    title: { en: 'Time trends by age', zh: '分年龄时间趋势' },
    unit: { en: 'Rate per 100,000', zh: '率（每10万人）' },
    decimals: 2,
    description: { en: 'Calendar-time profiles at selected ages.', zh: '指定年龄的时间率曲线。' },
  },
  residuals: {
    title: { en: 'Fitted residuals', zh: '拟合残差' },
    unit: { en: 'Deviance residual', zh: '偏差残差' },
    decimals: 3,
    description: { en: 'Deviance residuals against the fitted rate per 100,000.', zh: '偏差残差与拟合率（每10万人）的关系。' },
  },
};

const RATE_READOUT = { label: { en: 'Rate', zh: '率' }, unit: { en: 'per 100,000', zh: '每10万人' } };
const READOUT_META = {
  surface: RATE_READOUT,
  ageSections: RATE_READOUT,
  timeTrends: RATE_READOUT,
  annual: { unit: { en: '% / year', zh: '% / 年' } },
  acceleration: { unit: { en: '1 / year²', zh: '1 / 年²' } },
  gradient: { unit: { en: '% / age-year', zh: '% / 岁' } },
  shift: { unit: { en: 'age-years / year', zh: '岁 / 年' } },
  residuals: { label: { en: 'Deviance residual', zh: '偏差残差' }, unit: { en: '', zh: '' } },
};
for (const [metric, meta] of Object.entries(METRIC_META)) {
  meta.name = meta.title;
  meta.readoutLabel = READOUT_META[metric].label ?? meta.title;
  meta.readoutUnit = READOUT_META[metric].unit;
}

export function formatResultValue(value, metric = 'shift') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const decimals = METRIC_META[metric]?.decimals ?? 3;
  if (value !== 0 && Math.abs(value) < 10 ** -decimals) return value.toExponential(2);
  return value.toFixed(decimals);
}
