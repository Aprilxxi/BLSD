# BLSD 示例的方法说明

本文件说明发布脚本的数据生成、曲面拟合、动态指标及 APC 分解。BLSD-S 估计整体年龄—时期死亡率曲面；BLSD-APC 对这张曲面的每次抽样进行结构分解。两者共享同一组系数抽样，APC 阶段不重新拟合死亡计数。

## 1. 原示例数据的复现

数据采用 `set.seed(123)`，包含 1990—2019 年、18 个年龄组，共 540 个年龄—年份观测。年龄组为 `0-4`、`5-9`、…、`80-84` 和 `85+`；原脚本采用的连续年龄为 2.5、7.5、…、82.5 和 90 岁。90 岁是开放年龄组的演示代表值，而非由真实人口计算得到。

按照原脚本的行顺序生成随机数。人口为：

\[
E_{a,t}=\operatorname{round}\left[U_{a,t}\{1+(a/100)^2\}\right],
\qquad U_{a,t}\sim\operatorname{Uniform}(10000,50000).
\]

令 $\tau=t-1990$，模拟对数死亡率为：

\[
\eta_{\mathrm{sim}}(a,t)
=-12+0.12a-0.02\tau-0.0005a\tau
+0.05(t-2010)\,\mathbf{1}(a<50,\ t>2010)
+\varepsilon_{a,t},
\qquad \varepsilon_{a,t}\sim N(0,0.05^2).
\]

其中年龄项使死亡率随年龄上升；时间项与年龄—时间交互使死亡率总体下降，且较高年龄下降较快；2010 年后、50 岁以下增加反弹项。死亡数按原脚本生成：

\[
Y_{a,t}\mid\eta_{\mathrm{sim}},E_{a,t}
\sim\operatorname{Poisson}\left[E_{a,t}\exp\{\eta_{\mathrm{sim}}(a,t)\}\right].
\]

因此，这是含单元格随机扰动的 Poisson 模拟示例。后续使用负二项拟合是分析选择，不意味着模拟死亡数由负二项生成。该数据用于运行演示，不能单凭一次模拟证明方法准确性、区间覆盖率或适用于某种实际疾病。

## 2. BLSD-S：估计完整死亡率曲面

默认模型为：

\[
Y_{a,t}\sim\operatorname{NegBin}(\mu_{a,t},\theta),
\qquad
\operatorname{Var}(Y_{a,t})=\mu_{a,t}+\mu_{a,t}^2/\theta,
\]

\[
\log\mu_{a,t}=\log E_{a,t}+\eta(a,t),
\qquad
\eta(a,t)=\alpha+f(a,t).
\]

$\log E_{a,t}$ 为已知偏置项，$f(a,t)$ 为年龄与时期的三次回归样条张量积。代码通过 `mgcv::gam()` 与 `te(Age_Mid, Year, bs = c("cr", "cr"))` 拟合，采用 REML 选择平滑参数。张量积曲面和平滑估计均属于既有方法；相关定义见 [mgcv 张量积文档](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/te.html) 与 [负二项模型文档](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/negbin.html)。死亡率为 $r(a,t)=\exp\{\eta(a,t)\}$；图中率统一乘以 100,000。

样条将曲面表示为 $\eta=X\beta$，通过二次惩罚限制粗糙程度。惩罚可以解释为受惩罚系数方向上的高斯先验结构；其强度由数据估计。当前实现未为全部超参数指定先验后开展联合贝叶斯推断。REML 平滑估计的依据见 Wood (2011)。

二维曲面拟合没有同时引入三个独立的线性年龄、时期和队列斜率。队列结构可通过年龄—时期曲面的对角方向表现出来，后续 APC 分解再选择一个明确的结构摘要。二维死亡率平滑已有先例，例如 Currie 等 (2004)，并非本示例新提出的概念。

## 3. 系数抽样与不确定性传播

由拟合模型取得系数均值 $\widehat\beta$ 与协方差 $V$，生成：

\[
\beta^{(s)}\sim N(\widehat\beta,V),\qquad s=1,\ldots,S.
\]

代码优先使用 `Vc`，即可用的平滑参数不确定性修正协方差；缺失时使用 `Vp`。协方差检查包括有限性、对称性与特征值检查，仅截断数值舍入产生的微小负特征值。各次抽样保留系数相关性，不能把每个网格点视为独立抽样。

同一组系数抽样依次用于曲面、动态指标、百分比换算及 APC 分量：

\[
\eta^{(s)}=X\beta^{(s)},\qquad
r^{(s)}=\exp\{\eta^{(s)}\}.
\]

采用抽样均值及 2.5%、97.5% 分位数汇总。非线性换算先对每次抽样计算，再汇总，故平均死亡率一般不等于平均对数率取指数后的数值。`predict.gam` 的官方示例给出了预测矩阵及系数抽样用于导数与非线性函数的做法：[预测与衍生量文档](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/predict.gam.html)。

这些区间描述逐点的近似系数不确定性。它们不是整张曲面的同时区间，也不是未来观测死亡数的预测区间。当前抽样没有联合传播全部超参数与离散参数的不确定性，模型身份应表述为经验贝叶斯近似。

## 4. 动态指标与百分比展示

连续指标定义为：

\[
v(a,t)=\frac{\partial\eta}{\partial t},\qquad
b(a,t)=\frac{\partial^2\eta}{\partial t^2},\qquad
g(a,t)=\frac{\partial\eta}{\partial a}.
\]

| 指标 | 单位 | 含义 |
|---|---|---|
| $v$ | 对数率／日历年 | 固定年龄的时间变化速度 |
| $b$ | 对数率／日历年² | 时间变化速度的变化 |
| $g$ | 对数率／年龄岁 | 同一年份的横断面年龄梯度 |

通过预测矩阵的有限差分计算导数，再乘以同一组 $\beta^{(s)}$。网格内部使用中心差分，边界附近使用范围内的单侧差分。二阶导数在自然三次样条的端点受边界条件影响；端点接近零不能直接理解为数据证明了“没有加速度”。

另提供相邻年份的区间速度和区间加速度，其定义依据时间间隔，而非直接对展开后的向量做差。区间指标与连续指标描述不同对象，时间标签须按相应定义阅读。

为便于解释，展示图采用：

\[
v_{\%}^{(s)}=100\left[\exp\{v^{(s)}\}-1\right],
\qquad
g_{\%}^{(s)}=100\left[\exp\{g^{(s)}\}-1\right].
\]

这是分别把局部时间斜率延伸一个日历年、把局部年龄斜率延伸一岁得到的相对变化近似。严格的有限年度变化应计算 $100[\exp\{\eta(a,t+1)-\eta(a,t)\}-1]$，严格的相邻年龄变化应计算 $100[\exp\{\eta(a+1,t)-\eta(a,t)\}-1]$。本示例图中的导数百分比不应混称为上述精确有限变化。

加速度仍按对数率／日历年²展示。正加速度意味着时间速度在增加；当速度为负时，它可能表示死亡率下降逐渐放慢，而非死亡率已经上升。横断面年龄梯度也不是追踪同一人的衰老速度；沿出生队列路径变化的导数是 $\eta_t+\eta_a$。

## 5. 等死亡率年龄移动速度

沿同一对数死亡率的等高线有 $d\eta=0$，因此：

\[
0=\eta_a\,da+\eta_t\,dt,
\qquad
u(a,t)=\frac{da}{dt}=-\frac{\eta_t}{\eta_a}.
\]

$u$ 的单位为年龄岁／日历年。正值表示同一死亡率水平向更高年龄移动，负值表示向更低年龄移动。当 $g>0$ 时，固定年龄死亡率下降对应正移动速度。该指标由曲面推导而来，不增加独立观测信息。

代码在每次抽样中计算比值，并将 $|g^{(s)}|<0.005$ 或非有限结果标记为缺失。均值、区间及方向概率针对保留下来的抽样；保留比例不是有效样本量，也不是显著性指标。图中保留比例不足 95% 的位置会单独标记，避免将不稳定比值当作可靠极值。

区间版本以区间对数率速度为分子，年龄梯度两端均值为分母。连续版本的两项导数来自同一年龄、同一时期。该速度不等于基准年等效年龄：若要得到后者，需要指定 $t_0$ 并求解 $r(a_{\mathrm{eq}},t_0)=r(a,t)$，还须处理无解或多解。当前示例未加入这种反求年龄功能。

## 6. BLSD-APC：曲面的受约束投影

令出生队列 $c=t-a$。三个线性 APC 项满足：

\[
b_Aa+b_Pt+b_C(t-a)
=(b_A-b_C)a+(b_P+b_C)t.
\]

因此数据不能唯一分开三条线性斜率。先估计曲面不会消除这个问题；分解阶段仍需明确约束。APC 的参数化和解释边界参见 Carstensen (2007)。

当前实现构造自然样条基函数，去除各自的常数项及线性趋势，并用 QR 保留线性独立列。设计矩阵 $D$ 包括截距、中心化年龄线性项、中心化时期线性项及年龄、时期、队列曲率基。每次抽样求解：

\[
\widehat\gamma^{(s)}
=\arg\min_\gamma\|\eta^{(s)}-D\gamma\|_2^2.
\]

这是预测网格上的等权、无新增惩罚的最小二乘投影。每个年龄—时期格点权重相同；同一队列出现的频数由网格决定。曲率列对自身的常数和线性趋势正交，不代表所有 APC 分量彼此正交。

分解结果为：

\[
\eta^{(s)}(a,t)
=\alpha^{(s)}+A^{(s)}(a)
+d^{(s)}(t-\bar t)
+P_{\perp}^{(s)}(t)
+C_{\perp}^{(s)}(t-a)
+R^{(s)}(a,t).
\]

$A$ 包括年龄线性项与年龄曲率，$d$ 为该约束下的净时期线性漂移；$P_\perp$ 与 $C_\perp$ 为去掉常数及线性趋势后的非线性贡献。这里的“曲率分量”是样条贡献，不是二阶导数数组。

剩余面 $R^{(s)}=\eta^{(s)}-D\widehat\gamma^{(s)}$ 与所保留的设计列在该网格上正交，表示当前 APC 表示未能概括的对数率结构。它不同于实际死亡数相对于拟合死亡数的偏差残差；图 04 和图 09 展示的是后者。

图 13 展示 $\exp\{R^{(s)}\}$ 的汇总。每次抽样中，它等于完整死亡率与 APC 部分死亡率之比。例如，倍数 1.25 表示完整死亡率比 APC 部分高 25%。分别求均值后再相除通常不等于这个倍数的均值。

APC 分量随网格、基函数维度和约束而变化。重新拼回完整曲面属于代数检查，不证明 APC 摘要更准确，也不提供唯一的因果年龄、时期或队列效应。

## 7. 诊断与使用范围

发布脚本保留计数拟合诊断、系数协方差检查、导数抽样检查及 APC 重建／正交检查。逐点区间排除零的分类用于展示方向不确定性，不能作为整张图同时显著的结论。密集网格只提供曲面的插值位置，年龄与年份不得超出数据范围。

本示例仅演示一个已知生成机制。实际分析仍需检查匹配人口、过度离散、残差结构、平滑维度和导数步长，并评价 APC 投影设置的敏感性。方法学性能应通过多个生成机制、重复模拟与外部数据评价；本次示例图不承担这些验证任务。

## 参考文献与官方说明

1. Wood SN. Fast stable restricted maximum likelihood and marginal likelihood estimation of semiparametric generalized linear models. *Journal of the Royal Statistical Society: Series B*. 2011;73(1):3–36. [DOI: 10.1111/j.1467-9868.2010.00749.x](https://doi.org/10.1111/j.1467-9868.2010.00749.x).
2. Wood SN. *Generalized Additive Models: An Introduction with R*. 2nd ed. Chapman and Hall/CRC; 2017. [DOI: 10.1201/9781315370279](https://doi.org/10.1201/9781315370279).
3. Currie ID, Durbán M, Eilers PHC. Smoothing and forecasting mortality rates. *Statistical Modelling*. 2004;4(4):279–298. [DOI: 10.1191/1471082X04st080oa](https://doi.org/10.1191/1471082X04st080oa).
4. Carstensen B. Age–period–cohort models for the Lexis diagram. *Statistics in Medicine*. 2007;26:3018–3045. [DOI: 10.1002/sim.2764](https://doi.org/10.1002/sim.2764). [作者全文](https://www.bendixcarstensen.com/APC/Carstensen.2007a.pdf).
5. `mgcv` 官方文档：[张量积平滑](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/te.html)、[负二项分布](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/negbin.html)、[预测矩阵与衍生量抽样](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/predict.gam.html)、[系数协方差](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/vcov.gam.html)。
