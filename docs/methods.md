# BLSD Tool 方法说明

本文按 2026-10-25 稿件 *Bayesian Lexis Surface Dynamics for Age–Period Rate Analysis and Its Implementation in a Web Tool* 的方法、符号和图形定义整理。[分析脚本](../BLSD_Analysis_Selectable.R) 从计数与暴露数据拟合年龄—时期曲面并生成七张图；[结果重绘脚本](../BLSD_Plot_Web_Download.R) 使用网页下载中保存的估计值、区间与屏蔽标记绘图。

## 数据与固定示例

输入列为 `Year`、`Age_Group`（或 `Age_Mid`）、`Count`（兼容 `Deaths`）和 `Pop`。封闭整岁组按半开区间确定中点，例如 `30-34` 对应 `[30,35)`，中点为 32.5。可选 `Sex` 列中的每个组独立拟合，同组的年龄—时期坐标须唯一。自备数据的计数与暴露保留原始精度。

内置示例与稿件及网页使用同一份固定 CSV：1990–2023 年、13 个五岁年龄组（30–34 至 90–94），共 442 条观测，无 `Sex` 列。令年龄中点为 $a$、时期为 $t$，生成机制为

$$
x=\frac{a-62.5}{30},\qquad u=\frac{t-2005}{15},
$$

$$
r(a,t)=\frac{250}{100000}\exp\!\left[3.2x-0.9x^2-(0.55-0.12x)u+0.08u^3\right],
$$

$$
P(a)=\operatorname{round}\!\left[2000000\exp\{-0.03(a-32.5)\}\right],\qquad
\mu_{a,t}=P(a)r(a,t).
$$

各单元计数独立生成于负二项分布，方差为 $\mu_{a,t}+\mu_{a,t}^2/300$。生成种子为 `20261022`，数据版本为 `BLSD-INDEPENDENT-SYNTHETIC-20261022-v1`。这里的生成 size=300 与分析中估计的 $\theta$ 分开处理。

脚本直接读取内嵌的固定观测，不在运行时重新生成样本。该示例用于展示曲面及衍生指标的解释。固定 CSV 的 SHA-256 为：

```
5d2b2edac8329cedf6b2fecb29fbb046b62b892dfba27255c9d4541575a0f46c
```

## 曲面模型与方法选择

记计数为 $Y_{a,t}$、匹配的人口或暴露为 $E_{a,t}$。BLSD 使用计数广义加性模型，采用 log 链接和 $\log E_{a,t}$ 偏置项 [14,15]：

$$
\log\mu_{a,t}=\log E_{a,t}+\eta(a,t),\qquad
\eta(a,t)=\mathbf{x}(a,t)^\mathsf{T}\boldsymbol\beta.
$$

$\mathbf{x}(a,t)$ 包含截距及年龄、时期自然三次回归样条的张量积基函数，对两个方向施加独立粗糙度惩罚 [7,17]。实现使用 `te(Year, Age_Mid, bs = c("cr", "cr"))`，默认年龄和时期基维度均为 10，并按可用坐标数调整。分母视为固定；给定曲面后，各单元计数条件独立。

| 分布与方差关系 | 平滑参数估计 | 稿件依据 |
|---|---|---|
| 准 Poisson：$\operatorname{Var}(Y)=\phi\mu$ | GCV，估计离散尺度 | [18,21] |
| 准 Poisson：$\operatorname{Var}(Y)=\phi\mu$ | 基于扩展准似然的 REML | [18,20] |
| 负二项：$\operatorname{Var}(Y)=\mu+\mu^2/\theta$ | REML，同时估计 $\theta$ | [16,19] |

默认采用稿件示例的负二项＋REML。负二项＋GCV 不属于所支持的组合；脚本拒绝该组合，避免 `mgcv` 转用 REML 或 UBRE 后仍标作 GCV。

预测范围限定在观测年龄和时期内。预测时取 `Pop=1`，得到每个分母单位的对数率 $\eta=X\boldsymbol\beta$。报告率为 $R(a,t)=100000\exp\{\eta(a,t)\}$；常数缩放不改变对数导数与年龄移动速度。曲面图显示 $\log R$，截面和趋势图显示每十万人率。

## 局部导数与百分比表示

符号与稿件保持一致：

$$
g_t=\frac{\partial\eta}{\partial t},\qquad
g_a=\frac{\partial\eta}{\partial a},\qquad
c_t=\frac{\partial^2\eta}{\partial t^2},
$$

$$
A_t=100\{\exp(g_t)-1\},\qquad
A_a=100\{\exp(g_a)-1\}.
$$

$g_t$ 是固定年龄的时间斜率，$g_a$ 是同期年龄斜率，$c_t$ 是时间对数率曲率。$A_t$ 和 $A_a$ 分别报告为每年和每一岁年龄的局部百分比变化，表示局部 log 斜率恒定时的一单位变化近似。$c_t$ 的单位为年$^{-2}$；在率下降期间，负曲率表示相对下降加快。

导数由模型预测矩阵的有限差分计算，再乘以拟合系数或同一组系数抽样。每个坐标的步长取 `min(0.01, 观测范围/10)`；内部使用中心差分，边缘使用范围内的单侧差分。自然三次时期样条的端点曲率被约束为零 [22]：原始结果保留结构性零，报告值和区间屏蔽首尾时期，曲率图省略这两列。

## 年龄移动与稳定性筛查

沿局部等率线对 $\eta(a(t),t)$ 隐式求导，得到稿件定义的 equivalent age movement：

$$
v(a,t)=\frac{da}{dt}=-\frac{g_t(a,t)}{g_a(a,t)},\qquad g_a(a,t)\ne0.
$$

单位为年龄岁／日历年。正值表示相同率的位置向更高年龄移动，负值表示向更低年龄移动。比值使用 log 斜率 $g_t,g_a$，而不是百分比变换 $A_t,A_a$。

令年龄斜率的逐点区间为 $[L_{g_a},U_{g_a}]$，阈值为 $\varepsilon$。仅在以下任一条件成立，且拟合系数给出的比值与全部抽样比值均有限时报告该位置：

$$
(\widehat g_a>\varepsilon\ \text{且}\ L_{g_a}>\varepsilon)
\quad\text{或}\quad
(\widehat g_a<-\varepsilon\ \text{且}\ U_{g_a}<-\varepsilon).
$$

默认 $\varepsilon=0.005$，单位为每一岁年龄的对数率变化。筛查以整个年龄—时期位置为单位：不满足条件时同时屏蔽中心值及上下限；保留位置的区间使用全部比值抽样，不截除个别小分母抽样。年龄移动描述人群曲面上等率位置的局部变化。

## 不确定性传播与逐点区间

点估计直接由拟合系数 $\widehat{\boldsymbol\beta}$ 计算。默认使用种子 123 生成 $B=1000$ 次联合系数抽样，遵循惩罚 GAM 的近似贝叶斯高斯分布 [23]：

$$
\boldsymbol\beta^{(b)}\sim N(\widehat{\boldsymbol\beta},V),\qquad b=1,\ldots,B.
$$

协方差优先采用含平滑参数不确定性近似校正的 `Vc` [24]，否则采用 `Vp`；实际来源保存在结果元数据中。`Vp` 已包含估计的离散尺度。每次抽样的率、导数与年龄移动均从相同系数计算，以保留时间和年龄斜率之间的相关性。

各指标逐抽样计算后，以 2.5% 和 97.5% 分位数构成近似 95% 逐点模型区间。它们描述单个坐标的模型不确定性，不是未来计数预测区间或整张曲面的同时带。若某指标的中心值或任一抽样非有限，该位置的显示值及区间一起屏蔽；数值表保留原始值、有效抽样比例和原因。

## 诊断与七张图

稿件使用计数偏差残差和基维度检查评价模型。残差图与稿件 Figure 3D 一致：横轴为拟合率（每十万人，对数刻度），纵轴为偏差残差，散点按年龄着色，保留残差为零的参考线。

分析脚本对每组拟合运行 `mgcv::k.check`，报告平滑项的 k′、EDF、k-index 与置换 P 值，结果位于每组的 `diagnostics$basis_checks`。诊断使用独立固定种子 `20261015`、400 次置换及最多 5,000 条观测的子样本，并保存和恢复调用前的随机数状态；诊断不改变拟合系数、用于区间的 1,000 次系数抽样或任何指标数值。诊断不适用或失败时报告原因。

七张图依次为拟合曲面、年度变化、时间对数率曲率、拟合率—偏差残差、年龄截面、年龄别时期趋势，以及年龄梯度和年龄移动双面板。该编排将稿件 Figures 2–3 的面板展开为七图；统计量定义相同。内置示例的默认截面时期为 1990、2005、2023，趋势年龄为 32.5、42.5、52.5、62.5、82.5、92.5。图形使用保存的估计值、逐点区间及观测率，由 ggplot2 绘制 [26]。

重绘脚本接受完整分析归档 ZIP、结果表格 ZIP、解压目录、JSON 和当前九表 Excel 工作簿。各组独立绘图，直接使用下载数据；残差图使用其中保存的拟合率。完整归档保存等高线顶点；Excel 未保存这些顶点，因此省略等高线。缺少必需结果字段的旧文件会明确提示。重绘脚本不重新拟合、抽样或执行基维度检查；可用诊断来自下载文件。两份脚本均支持 PDF 和 600 dpi PNG 输出。

## 参考文献

以下为稿件中与本方法和绘图实现直接相关的 13 条文献，沿用稿件最终编号。作者、题名、年份、卷页及 DOI 均与 2026-10-25 投稿稿一致。

[7] Wood SN. Low-rank scale-invariant tensor product smooths for generalized additive mixed models. Biometrics. 2006;62(4):1025-36. [doi:10.1111/j.1541-0420.2006.00574.x](https://doi.org/10.1111/j.1541-0420.2006.00574.x).

[14] Frome EL, Checkoway H. Use of Poisson regression models in estimating incidence rates and ratios. Am J Epidemiol. 1985;121(2):309-23. [doi:10.1093/oxfordjournals.aje.a114001](https://doi.org/10.1093/oxfordjournals.aje.a114001).

[15] Nelder JA, Wedderburn RWM. Generalized linear models. J R Stat Soc Ser A (General). 1972;135(3):370-84. [doi:10.2307/2344614](https://doi.org/10.2307/2344614).

[16] Lawless JF. Negative binomial and mixed Poisson regression. Can J Stat. 1987;15(3):209-25. [doi:10.2307/3314912](https://doi.org/10.2307/3314912).

[17] Wood SN. Modelling and smoothing parameter estimation with multiple quadratic penalties. J R Stat Soc Series B Stat Methodol. 2000;62(2):413-28. [doi:10.1111/1467-9868.00240](https://doi.org/10.1111/1467-9868.00240).

[18] Wedderburn RWM. Quasi-likelihood functions, generalized linear models, and the Gauss-Newton method. Biometrika. 1974;61(3):439-47. [doi:10.1093/biomet/61.3.439](https://doi.org/10.1093/biomet/61.3.439).

[19] Wood SN. Fast stable restricted maximum likelihood and marginal likelihood estimation of semiparametric generalized linear models. J R Stat Soc Series B Stat Methodol. 2011;73(1):3-36. [doi:10.1111/j.1467-9868.2010.00749.x](https://doi.org/10.1111/j.1467-9868.2010.00749.x).

[20] Nelder JA, Pregibon D. An extended quasi-likelihood function. Biometrika. 1987;74(2):221-32. [doi:10.1093/biomet/74.2.221](https://doi.org/10.1093/biomet/74.2.221).

[21] Wood SN. Fast stable direct fitting and smoothness selection for generalized additive models. J R Stat Soc Series B Stat Methodol. 2008;70(3):495-518. [doi:10.1111/j.1467-9868.2007.00646.x](https://doi.org/10.1111/j.1467-9868.2007.00646.x).

[22] Reinsch CH. Smoothing by spline functions. Numer Math. 1967;10(3):177-83. [doi:10.1007/BF02162161](https://doi.org/10.1007/BF02162161).

[23] Marra G, Wood SN. Coverage properties of confidence intervals for generalized additive model components. Scand J Stat. 2012;39(1):53-74. [doi:10.1111/j.1467-9469.2011.00760.x](https://doi.org/10.1111/j.1467-9469.2011.00760.x).

[24] Wood SN, Pya N, Säfken B. Smoothing parameter and model selection for general smooth models. J Am Stat Assoc. 2016;111(516):1548-63. [doi:10.1080/01621459.2016.1180986](https://doi.org/10.1080/01621459.2016.1180986).

[26] Wickham H. A layered grammar of graphics. J Comput Graph Stat. 2010;19(1):3-28. [doi:10.1198/jcgs.2009.07098](https://doi.org/10.1198/jcgs.2009.07098).

## 软件实现补充链接

以下官方手册用于核对函数行为，单列于稿件参考文献之外：

- [mgcv::gam 拟合方法](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/gam.html)
- [mgcv 负二项家族](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/negbin.html)
- [mgcv 系数协方差](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/vcov.gam.html)
- [mgcv::k.check 基维度检查](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/k.check.html)
