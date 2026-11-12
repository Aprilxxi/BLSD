# Independent simulated example / 独立模拟示例

Year, Age_Group, Count, Pop; 442 fixed observations, 1990–2023, 13 closed five-year age groups from 30-34 through 90-94; no Sex column. These mortality counts and exposures were generated independently of real data. Generation seed: 20261022; one negative-binomial realization with generating size=300. This generating parameter is distinct from the fitted model theta. Counts are imported unchanged, without resampling. Source and fixed rules are recorded in metadata.json.

这是独立生成的模拟死亡率计数与人口/暴露示例，不代表真实人群。只保留一次既定抽样的全部观测，不重新抽样；数据生成参数 size=300 与拟合 theta 不同。网页初始为空，加载示例后仍需运行分析；所有图表和区间均来自实际保留的 R 拟合。
