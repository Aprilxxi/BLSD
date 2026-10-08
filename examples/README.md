# BLSD-S 示例图表

本目录展示微信原版模拟数据上的九组图，分别保存 PNG 和 PDF。默认设置为数据种子 123、1,000 次系数抽样，1990—2019 年和 18 个年龄组。实际生成信息以 [图表清单](figure_manifest.csv) 为准。

| 图 | PNG | PDF | 含义 |
|---|---|---|---|
| 01 | [死亡率曲面](fig01_mortality_surface.png) | [PDF](fig01_mortality_surface.pdf) | 每 10 万人死亡率，对数颜色；白线为等死亡率线 |
| 02 | [局部年度变化](fig02_annual_change_percent.png) | [PDF](fig02_annual_change_percent.pdf) | 时间导数逐抽样换算的局部一年变化（%） |
| 03 | [对数率加速度](fig03_log_rate_acceleration.png) | [PDF](fig03_log_rate_acceleration.pdf) | 时间二阶导数，对数率／日历年² |
| 04 | [队列残差诊断](fig04_count_residuals_by_cohort.png) | [PDF](fig04_count_residuals_by_cohort.pdf) | 计数偏差残差按近似出生年份排列，LOESS 查看拟合不足 |
| 05 | [年份年龄截面](fig05_age_profiles.png) | [PDF](fig05_age_profiles.pdf) | 1990、2005、2019 年准确截面，观测率与区间 |
| 06 | [指定年龄趋势](fig06_selected_age_trends.png) | [PDF](fig06_selected_age_trends.pdf) | 指定观测年龄的时间趋势、观测率与区间 |
| 07 | [年龄百分比与移动速度](fig07_age_percent_and_iso_velocity.png) | [PDF](fig07_age_percent_and_iso_velocity.pdf) | 横断面年龄变化（%），等死亡率移动速度（岁／年） |
| 08 | [逐点区间方向](fig08_pointwise_direction.png) | [PDF](fig08_pointwise_direction.pdf) | 年龄变化和移动速度的 95% 逐点区间是否跨零 |
| 09 | [计数拟合诊断](fig09_count_fit_diagnostics.png) | [PDF](fig09_count_fit_diagnostics.pdf) | 实际／拟合死亡数，偏差残差对拟合值 |

图 02 和图 07 使用 `100 * (exp(导数) - 1)`，先换算各系数抽样，再汇总。它们是局部一年、一岁近似，精确有限变化需比较两个时间或年龄点。

图 07 右侧正值表示同一死亡率向更高年龄移动，负值表示向更低年龄移动。年龄梯度很小时比值不稳定；保留抽样不足 95% 的位置显示为灰色。该速度不是基准年等效年龄，也不能直接解释为个人生理年龄或寿命变化。

图 04 为原版残差诊断，黑色曲线不代表独立的队列效应。图 08 未作多重比较校正；图 09 是样本内检查。

复现时在仓库根目录运行 `Rscript BLSD_Model_Analysis.R`，图保存至 `outputs/demo/figures/`。见 [M01–M14 对照](../docs/original_changes.md) 和 [方法说明](../docs/methods.md)。
