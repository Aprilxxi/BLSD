# BLSD Tool 方法说明

[分析脚本](../BLSD_Analysis_Selectable.R) 根据计数与暴露数据拟合年龄—时期曲面，并生成七张图。[结果重绘脚本](../BLSD_Plot_Web_Download.R) 读取网页下载的结果，使用其中保存的数值、区间和屏蔽标记绘图。

## 数据与示例

输入列为 `Year`、`Age_Group`（或 `Age_Mid`）、`Count`（兼容 `Deaths`）和 `Pop`。闭合整岁组按半开区间确定中点，例如 `30-34` 对应 `[30,35)`，中点为 32.5。每个性别组独立拟合，同组的年龄—时期坐标须唯一。自备数据的计数与暴露保留原始精度。

内置示例与网页使用同一份固定 CSV：1990–2023 年、13 个年龄组（30–34 至 90–94），共 442 条观测，无 `Sex` 列。该数据为独立合成计数与暴露数据，生成种子为 `20261022`，版本为 `BLSD-INDEPENDENT-SYNTHETIC-20261022-v1`；运行脚本直接读取内嵌数据。CSV 的 SHA-256 为：

```
5d2b2edac8329cedf6b2fecb29fbb046b62b892dfba27255c9d4541575a0f46c
```

## 曲面模型与方法选择

记计数为 $Y_{a,t}$、暴露为 $E_{a,t}$，均值模型为

$$
\log\mu_{a,t}=\log E_{a,t}+\eta(a,t),\qquad
\eta(a,t)=\alpha+f(a,t).
$$

其中 $f$ 使用 `te(Year, Age_Mid, bs = c("cr", "cr"))` 的三次回归样条张量积。年龄和时期的默认基维度均为 10，并按可用坐标数调整。脚本支持以下三种组合：

| 分布与方差关系 | 平滑参数估计 |
|---|---|
| 准 Poisson：$\operatorname{Var}(Y)=\phi\mu$ | GCV，估计离散尺度 |
| 准 Poisson：$\operatorname{Var}(Y)=\phi\mu$ | REML，采用扩展准似然 |
| 负二项：$\operatorname{Var}(Y)=\mu+\mu^2/\theta$ | REML，联合估计 $\theta$ |

默认使用负二项＋REML。示例生成时的 NB size=300 与拟合得到的 $\theta$ 分开记录。脚本明确拒绝负二项＋GCV：所用 `mgcv` 实现中的 `nb()` 会转为 REML，固定 $\theta$ 的 `negbin()` 使用 UBRE，均不能标作 GCV。参见 [GAM 拟合方法](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/gam.html)与[负二项家族说明](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/negbin.html)。

预测范围限定在观测年龄和时期内。预测时取 `Pop=1`，得到每人对数率 $\eta=X\beta$；率为 $100000\exp(\eta)$。曲面图显示其自然对数 $\eta+\log(100000)$，截面和趋势图显示每十万人率。

## 中心值与逐点区间

所有中心值均由拟合系数 $\widehat\beta$ 代入指标函数计算。默认使用种子 123 生成 1,000 次相关系数抽样：

$$
\beta^{(s)}\sim N(\widehat\beta,V).
$$

协方差优先采用模型提供的 `Vc`，否则采用 `Vp`，实际来源保存在结果元数据中。`Vp` 已包含估计的离散尺度；`Vc` 提供近似的平滑参数不确定性校正。全部位置与指标共用同一组系数抽样。

对每次抽样计算指标，再取 2.5% 和 97.5% 分位数构成 95% 逐点区间。这些是系数高斯近似区间；使用 `Vp` 时条件于估计的平滑参数，准 Poisson 还条件于估计的离散尺度。它们不是同时区间或未来计数预测区间，也未完整联合抽样平滑参数和离散参数。参见 [mgcv 系数协方差](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/vcov.gam.html)。

若某指标的中心值或任一抽样非有限，该位置的显示值与区间一起屏蔽；原始值、有效抽样比例和原因保存在数值表中。

## 动态指标与筛查

在同一年龄、时期位置计算

$$
v=\frac{\partial\eta}{\partial t},\qquad
b=\frac{\partial^2\eta}{\partial t^2},\qquad
g=\frac{\partial\eta}{\partial a}.
$$

导数由预测矩阵的有限差分计算，再乘以拟合系数或同一组系数抽样。内部使用中心差分，边缘使用观测范围内的单侧差分；步长取 `min(0.01, 坐标范围/10)`。自然三次样条的时期端点二阶导数为结构性零：原始结果保留零值，展示值和区间屏蔽两端，图中省略端点列。

年度变化与年龄梯度分别显示为 $100[\exp(v)-1]$ 和 $100[\exp(g)-1]$，表示将局部斜率延伸一年或一岁的近似相对变化；加速度 $b$ 的单位为对数率／年²。非线性指标先逐抽样变换，再汇总区间，中心值始终来自拟合系数。

等死亡率年龄移动速度为

$$
u=-\frac{v}{g},
$$

单位为年龄岁／时期年，正值表示等率位置向更高年龄移动。令年龄梯度区间为 $[L_g,U_g]$、阈值为 $\varepsilon$，仅在以下任一条件成立且比值中心与全部比值抽样均有限时显示该位置：

$$
(\widehat g>\varepsilon\ \text{且}\ L_g>\varepsilon)
\quad\text{或}\quad
(\widehat g<-\varepsilon\ \text{且}\ U_g<-\varepsilon).
$$

默认 $\varepsilon=0.005$，单位为对数率／岁。这是对整点的分母稳定性筛查；不满足条件时同时屏蔽中心和上下限，保留未经截尾的原始比值结果。年龄梯度描述同一时期不同年龄的横断面差异，移动速度描述人群曲面的等率位置变化。

## 七张图与结果重绘

七图依次为曲面、年度变化、加速度、队列残差、年龄截面、年龄别时期趋势，以及年龄梯度和移动速度双面板。内置示例的默认截面时期为 1990、2005、2023；默认趋势年龄为 32.5、42.5、52.5、62.5、82.5、92.5。截面和趋势图使用保存的率、逐点区间及观测率。

队列残差图按近似出生时期 $t-a$ 排列计数偏差残差，用于检查拟合后的剩余结构；其平滑线是诊断展示，不是队列效应估计。

重绘脚本接受完整分析归档 ZIP、结果表格 ZIP、解压目录、JSON 和当前九表 Excel 工作簿。各组独立绘制七图，直接保留下载结果的数值与筛查状态，不重新拟合或抽样。完整归档保留等高线顶点、残差平滑线和默认曲线坐标；Excel 未保存这些信息，因此省略相应图层并从已有坐标选择截面和趋势。缺少曲面 ln 率的旧工作簿会提示重新下载。两份脚本均支持 PDF 和 PNG 输出，默认 PNG 为 600 dpi。

## 参考文献

1. Wood SN. Fast stable restricted maximum likelihood and marginal likelihood estimation of semiparametric generalized linear models. *Journal of the Royal Statistical Society: Series B*. 2011;73(1):3–36. [DOI: 10.1111/j.1467-9868.2010.00749.x](https://doi.org/10.1111/j.1467-9868.2010.00749.x).
2. Wood SN. *Generalized Additive Models: An Introduction with R*. 2nd ed. Chapman and Hall/CRC; 2017. [DOI: 10.1201/9781315370279](https://doi.org/10.1201/9781315370279).
3. Currie ID, Durbán M, Eilers PHC. Smoothing and forecasting mortality rates. *Statistical Modelling*. 2004;4(4):279–298. [DOI: 10.1191/1471082X04st080oa](https://doi.org/10.1191/1471082X04st080oa).
