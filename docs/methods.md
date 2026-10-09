# BLSD-S 示例的方法说明

本示例在微信原版基础上保留数据生成机制，用年龄—时期平滑曲面估计死亡率，计算动态指标并在 RStudio 中显示七组图。[准 Poisson＋GCV 版本](../BLSD_Model_Analysis_QuasiPoisson_GCV.R) 与 [负二项＋REML 版本](../BLSD_Model_Analysis.R) 均为可独立运行的单脚本，使用相同模拟数据和绘图流程。

## 1. 数据与模型

使用 `set.seed(123)`，包含 1990—2019 年、18 个年龄组，共 540 个观测。年龄中点为 2.5、7.5、…、82.5 和 90 岁；90 岁是原版为 `85+` 指定的演示值。

人口为 $E_{a,t}=\operatorname{round}[U_{a,t}\{1+(a/100)^2\}]$，其中 $U_{a,t}\sim\operatorname{Uniform}(10000,50000)$。令 $\tau=t-1990$，模拟对数死亡率为：

$$
\eta_{\mathrm{sim}}(a,t)=-12+0.12a-0.02\tau-0.0005a\tau
+0.05(t-2010)\mathbf{1}(a<50,t>2010)+\varepsilon_{a,t},
\qquad\varepsilon_{a,t}\sim N(0,0.05^2).
$$

死亡数按原版生成：$Y_{a,t}\sim\operatorname{Poisson}[E_{a,t}\exp\{\eta_{\mathrm{sim}}(a,t)\}]$。随机数调用顺序与人口取整均保留。

负二项＋REML 版本采用：

$$
Y_{a,t}\sim\operatorname{NegBin}(\mu_{a,t},\theta),\qquad
\operatorname{Var}(Y_{a,t})=\mu_{a,t}+\mu_{a,t}^2/\theta,
$$

$$
\log\mu_{a,t}=\log E_{a,t}+\eta(a,t),\qquad
\eta(a,t)=\alpha+f(a,t).
$$

$\log E_{a,t}$ 是已知人口偏置项，$f$ 是年龄和时期的三次回归样条张量积，两个方向基维度均为 10。负二项版本使用 `mgcv::gam()` 和 REML 估计平滑程度。[负二项说明](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/negbin.html)

准 Poisson＋GCV 版本保留相同的对数均值模型，指定：

$
\mathrm{E}(Y_{a,t})=\mu_{a,t},\qquad
\operatorname{Var}(Y_{a,t})=\phi\mu_{a,t}.
$

使用 `family = quasipoisson(link = "log")` 和 `method = "GCV.Cp"`；离散尺度未知并由数据估计，因此实际采用 GCV 选择平滑程度，与微信原版的默认拟合方法一致。准 Poisson 指定均值—方差关系，未指定完整计数概率分布；更换拟合方式不意味着必然改善拟合。[gam 拟合方法](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/gam.html)

预测网格限定在数据年龄和年份范围内，人口取 1。预测矩阵得到对数死亡率 $\eta=X\beta$，图中死亡率为 $100000\exp(\eta)$。二维死亡率平滑已有研究基础；张量积构造和 REML 分别参见 [mgcv 文档](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/te.html)、Wood (2011) 和 Currie 等 (2004)。

## 2. 不确定性

生成 1,000 次相关系数抽样：

$$
\beta^{(s)}\sim N(\widehat\beta,V),\qquad
\eta^{(s)}=X\beta^{(s)}.
$$

负二项版本优先采用平滑参数不确定性修正协方差 `Vc`，没有该矩阵时采用 `Vp`。准 Poisson＋GCV 版本采用 `Vp`；该矩阵已包含估计的离散尺度 $\widehat\phi$，不再重复乘以离散尺度，其区间条件于估计的平滑参数和离散尺度。同一次抽样在全部预测位置使用同一组系数，从而保留位置间和指标间的相关性。[系数协方差说明](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/vcov.gam.html)

死亡率、导数、百分比和比值逐抽样计算，再汇总均值和 2.5%、97.5% 分位数。区间是逐点的系数高斯近似区间；准 Poisson 版本不将其称为完整计数似然下的贝叶斯后验。二者均未联合抽样全部平滑参数及离散参数，不是同时区间或未来死亡数的预测区间。[衍生量抽样示例](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/predict.gam.html)

## 3. 动态指标

在同一年龄、时期位置计算：

$$
v=\frac{\partial\eta}{\partial t},\qquad
b=\frac{\partial^2\eta}{\partial t^2},\qquad
g=\frac{\partial\eta}{\partial a}.
$$

对预测矩阵做有限差分后乘以系数抽样。内部使用中心差分，边界使用范围内的单侧差分，分别计算一、二阶导数。自然三次样条端点二阶导数受边界条件影响。原版对展开后的时间导数向量直接做 `diff()`，可能跨年龄相减且未按时间间隔归一化；本版只保留这一套同点导数计算。

年度和年龄变化逐抽样换算为：

$$
v_{\%}^{(s)}=100[\exp\{v^{(s)}\}-1],\qquad
g_{\%}^{(s)}=100[\exp\{g^{(s)}\}-1].
$$

这是局部斜率延伸一年或一岁的近似。精确有限变化需比较两个位置的率，例如 $100[\exp\{\eta(a+1,t)-\eta(a,t)\}-1]$。先换算再汇总，因为非线性变换的均值一般不等于均值的非线性变换。

加速度仍以对数率／年²表示。正加速度表示时间斜率增加；当速度为负时，通常表示下降放慢。年龄梯度为同年不同年龄人群的横断面差异。

## 4. 等死亡率年龄移动速度

沿等死亡率线 $d\eta=0$，有：

$$
u(a,t)=\frac{da}{dt}=-\frac{\eta_t}{\eta_a}.
$$

单位为年龄岁／日历年。正值表示相同死亡率的位置向更高年龄移动，负值表示向更低年龄移动。当年龄梯度为正时，死亡率下降对应正移动速度。

每次抽样分别计算比值，$|g^{(s)}|<0.005$ 时设为缺失，汇总保留抽样中的均值与区间。该阈值用于减少小分母引起的不稳定；它不表示统计显著性。基准年等效年龄须另行求解 $r(a_{\mathrm{eq}},t_0)=r(a,t)$，本示例未实现。

## 5. 图表与解释

七组图按曲面、年度百分比、加速度、队列残差、指定年份截面、指定年龄趋势、年龄百分比与移动速度的顺序显示。截面直接选取 1990、2005、2019 年，不将邻近年份四舍五入后混入截面；截面与趋势图叠加观测率及逐点区间。

按出生队列 $t-a$ 排列计数偏差残差的图保留原版形式。LOESS 仅用于探索拟合不足，不能据此估计队列效应或作因果归因。死亡率曲面指标也不能直接解释为个人生理年龄或寿命变化。一次模拟用于展示流程，不足以证明方法准确性或区间覆盖率。

## 参考文献

1. Wood SN. Fast stable restricted maximum likelihood and marginal likelihood estimation of semiparametric generalized linear models. *Journal of the Royal Statistical Society: Series B*. 2011;73(1):3–36. [DOI: 10.1111/j.1467-9868.2010.00749.x](https://doi.org/10.1111/j.1467-9868.2010.00749.x).
2. Wood SN. *Generalized Additive Models: An Introduction with R*. 2nd ed. Chapman and Hall/CRC; 2017. [DOI: 10.1201/9781315370279](https://doi.org/10.1201/9781315370279).
3. Currie ID, Durbán M, Eilers PHC. Smoothing and forecasting mortality rates. *Statistical Modelling*. 2004;4(4):279–298. [DOI: 10.1191/1471082X04st080oa](https://doi.org/10.1191/1471082X04st080oa).
