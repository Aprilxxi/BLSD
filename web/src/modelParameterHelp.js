export const MODEL_PARAMETER_HELP = {
  draws: {
    zh: ['从拟合系数的联合近似高斯分布中抽样，用于计算95% UI和稳定性筛选。',
      '默认1000次，范围100–10000次。增加次数可减少区间与筛选的抽样波动，同时增加计算时间；拟合系数保持不变。'],
    en: ['Number of joint approximate Gaussian coefficient draws used to calculate 95% UI and stability screening.',
      'Default: 1,000; range: 100–10,000. More draws reduce sampling variation in intervals and screening, with longer computation. Fitted coefficients remain unchanged.'],
  },
  seed: {
    zh: ['控制系数抽样的随机序列，默认123，允许整数0–2147483647。',
      '相同数据、参数和运行环境下，使用相同种子可复现抽样。更换种子可能改变95% UI和稳定性筛选，拟合系数保持不变。'],
    en: ['Controls the random sequence for coefficient draws. Default: 123; integer range: 0–2147483647.',
      'The same seed reproduces draws with the same data, settings and runtime environment. Changing it may affect 95% UI and stability screening; fitted coefficients remain unchanged.'],
  },
  kAge: {
    zh: ['年龄方向的样条基函数数量，用于设定曲面可用的灵活程度。实际有效自由度（EDF）由惩罚平滑决定。',
      '默认10，整数范围4–40，上限随各组实际年龄数自动限制。增大可容纳更细的年龄变化，也需要更多观测支持。'],
    en: ['Spline basis dimension for age, setting the available surface flexibility. Penalization determines the fitted effective degrees of freedom (EDF).',
      'Default: 10; integer range: 4–40, further limited by the distinct ages in each group. Larger values allow finer age patterns and require more observations.'],
  },
  kYear: {
    zh: ['时期方向的样条基函数数量，用于设定曲面可用的灵活程度。实际有效自由度（EDF）由惩罚平滑决定。',
      '默认10，整数范围4–40，上限随各组实际时期数自动限制。增大可容纳更细的时间变化，也需要更多观测支持。'],
    en: ['Spline basis dimension for period, setting the available surface flexibility. Penalization determines the fitted effective degrees of freedom (EDF).',
      'Default: 10; integer range: 4–40, further limited by the distinct periods in each group. Larger values allow finer temporal patterns and require more observations.'],
  },
  threshold: {
    zh: ['用于等效年龄移动稳定性筛选的对数率年龄导数阈值，默认0.005（1/岁）。',
      '点估计和整个95% UI均高于正阈值，或均低于负阈值时，才通过梯度检查；还需满足抽样比值有限等条件。增大阈值会使筛选更严格。'],
    en: ['Threshold for the log-rate age derivative used in equivalent-age-shift stability screening. Default: 0.005 (1/age-year).',
      'The estimate and its entire 95% UI must lie above the positive threshold or below the negative threshold to pass the gradient check. Finite draw ratios are also required. A larger threshold makes screening stricter.'],
  },
};
