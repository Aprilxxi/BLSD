# BLSD-S 示例的方法说明

本文件说明微信示例数据复现、年龄—时期死亡率曲面拟合、系数抽样、动态指标和九组图表。代码中 `[修改 M01]` 至 `[修改 M14]` 对应 [原版修改说明](original_changes.md)。

## 1. 原示例数据的复现

使用 `set.seed(123)`，包含 1990—2019 年、18 个年龄组，共 540 个观测。年龄组为 `0-4`、`5-9`、…、`80-84` 和 `85+`；连续年龄为 2.5、7.5、…、82.5 和 90 岁。90 岁是原例为开放年龄组指定的演示代表值，并非真实人口的平均年龄。

按原脚本行顺序生成随机数。人口为：

\[
E_{a,t}=\operatorname{round}[U_{a,t}\{1+(a/100)^2\}],
\qquad U_{a,t}\sim\operatorname{Uniform}(10000,50000).
\]

令 $\tau=t-1990$，模拟对数死亡率为：

\[
\eta_{\mathrm{sim}}(a,t)
=-12+0.12a-0.02\tau-0.0005a\tau
+0.05(t-2010)\mathbf{1}(a<50,\ t>2010)
+\varepsilon_{a,t},
\qquad \varepsilon_{a,t}\sim N(0,0.05^2).
\]

年龄项使率随年龄上升；时间项和交互项使死亡率总体下降且高龄下降较快；2010 年后、50 岁以下增加反弹项。死亡数为：

\[
Y_{a,t}\mid\eta_{\mathrm{sim}},E_{a,t}
\sim\operatorname{Poisson}[E_{a,t}\exp\{\eta_{\mathrm{sim}}(a,t)\}].
\]

生成式、随机数调用顺序及人口取整均保留（M02）。它是含单元格随机扰动的 Poisson 示例。后续负二项拟合是分析选择，不改变生成分布。一次模拟用于展示流程，不足以评价准确性或区间覆盖率。

## 2. 年龄—时期死亡率曲面

默认模型为：

\[
Y_{a,t}\sim\operatorname{NegBin}(\mu_{a,t},\theta),
\qquad \operatorname{Var}(Y_{a,t})=\mu_{a,t}+\mu_{a,t}^2/\theta,
\]

\[
\log\mu_{a,t}=\log E_{a,t}+\eta(a,t),
\qquad \eta(a,t)=\alpha+f(a,t).
\]

$\log E_{a,t}$ 为已知人口偏置项，$f(a,t)$ 为年龄和时期的三次回归样条张量积。通过 `mgcv::gam()` 与 `te(Age_Mid, Year, bs = c("cr", "cr"))` 拟合，采用 REML 估计平滑参数（M03）。示例两个方向的基维度均设为 10；一般函数检查可用年龄、年份数并调整过大的维度。

负二项提供完整计数分布且允许过度离散。原版准 Poisson 同样可以描述过度离散，方差形式不同；更换分布不能自动证明模型更优。[负二项官方说明](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/negbin.html)

死亡率为 $r(a,t)=\exp\{\eta(a,t)\}$，图中率乘以 100,000。预测时人口取 1，从不含偏置项的预测矩阵得到 $\eta=X\beta$，避免混用预测死亡数与死亡率（M05）。网格限定在观测范围内：原例延伸至 92.5 岁，而最高示例代表年龄为 90 岁，当前删除这段外推。

样条惩罚限制粗糙程度，可以解释为受惩罚方向上的高斯先验结构；平滑强度由数据估计，未对全部超参数做联合后验抽样。REML 的依据见 Wood (2011)，张量积平滑见 [mgcv 文档](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/te.html)。二维死亡率平滑已有先例，例如 Currie 等 (2004)。

## 3. 相关系数抽样与区间

从拟合模型取得系数均值 $\widehat\beta$ 和协方差 $V$，生成：

\[
\beta^{(s)}\sim N(\widehat\beta,V),\qquad s=1,\ldots,S.
\]

优先使用可用的平滑参数不确定性修正协方差 `Vc`，缺失时使用 `Vp`。检查有限性、对称性和特征值，仅截断舍入误差产生的微小负特征值（M04）。抽样保留系数相关性，同一次抽样在全部预测位置使用同一组系数。

\[
\eta^{(s)}=X\beta^{(s)},\qquad r^{(s)}=\exp\{\eta^{(s)}\}.
\]

曲面、导数、百分比和移动速度共享抽样，以均值及 2.5%、97.5% 分位数汇总。非线性函数逐抽样计算后再汇总，例如平均死亡率一般不等于平均对数率取指数后的值。[预测矩阵与衍生量抽样](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/predict.gam.html)、[系数协方差](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/vcov.gam.html)

这些是逐点的近似系数不确定性区间，既非整张曲面的同时区间，也非未来死亡数的预测区间。未联合抽样全部平滑参数与离散参数，模型应表述为经验贝叶斯近似。

## 4. 速度、加速度和年龄梯度

连续指标为：

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

对预测矩阵做有限差分，再乘以同一组系数抽样。内部使用中心差分，边界附近使用范围内的单侧模板，分别计算一、二阶导数（M06）。自然三次样条端点二阶导数受边界条件约束，接近零不能理解为数据证明“没有加速度”。

另输出区间指标。对同一年龄，令 $\Delta t_j=t_{j+1}-t_j$：

\[
v_j=\frac{\eta(a,t_{j+1})-\eta(a,t_j)}{\Delta t_j},
\qquad
b_j=\frac{2(v_{j+1}-v_j)}{\Delta t_j+\Delta t_{j+1}}.
\]

按同一年龄的时间轴和实际间隔计算；原版对展开后的速度向量做 `diff()`，可能跨年龄相减，且没有完成时间尺度归一化。原版第二张图实际画一阶导数，当前年度变化图和加速度图分别展示。

离散年龄梯度使用不等距三点公式（M07）。设 $h_-=a_i-a_{i-1}$、$h_+=a_{i+1}-a_i$：

\[
g_i\approx
-\frac{h_+}{h_-(h_-+h_+)}\eta_{i-1}
+\frac{h_+-h_-}{h_-h_+}\eta_i
+\frac{h_-}{h_+(h_-+h_+)}\eta_{i+1}.
\]

这避免将含开放组或追加端点的年龄网格误作等距。离散梯度省略两端年龄，连续导数版本使用范围内的边界模板。

图 02 和图 07 按每次抽样换算为百分比（M09）：

\[
v_{\%}^{(s)}=100[\exp\{v^{(s)}\}-1],\qquad
g_{\%}^{(s)}=100[\exp\{g^{(s)}\}-1].
\]

这是局部斜率分别延伸一个日历年和一岁得到的近似。严格的有限年度变化为 $100[\exp\{\eta(a,t+1)-\eta(a,t)\}-1]$；严格的相邻年龄变化为 $100[\exp\{\eta(a+1,t)-\eta(a,t)\}-1]$。先换算各抽样，再求均值和区间，避免以 `exp(mean(g))` 替代 `mean(exp(g))`。

加速度仍用对数率／日历年²。正加速度表示时间斜率增加；速度为负时，可表示死亡率下降放慢。横断面年龄梯度描述同年不同年龄人群的差异；沿同一出生队列路径的导数是 $\eta_t+\eta_a$。

## 5. 等死亡率年龄移动速度

沿等对数死亡率线，$d\eta=0$：

\[
0=\eta_a\,da+\eta_t\,dt,\qquad
u(a,t)=\frac{da}{dt}=-\frac{\eta_t}{\eta_a}.
\]

单位为年龄岁／日历年。正值表示同一死亡率水平向更高年龄移动，负值表示向更低年龄移动。当年龄梯度为正时，固定年龄死亡率下降对应正移动速度。原版只有等高线，当前新增数值计算（M10）；它是曲面的衍生指标，不增加独立观测信息。

每次抽样计算比值，将 $|g^{(s)}|<0.005$ 或非有限结果标为缺失。均值、区间及方向概率基于保留下来的抽样；报告保留数和比例，保留比例不是显著性，也不是有效样本量。图中保留比例不足 95% 的位置标为灰色。

离散版本以两端年龄梯度平均值为分母（M08）：

\[
u_j=-\frac{v_j}{\{g(a,t_j)+g(a,t_{j+1})\}/2}.
\]

这是后续模块实现的时间对齐修正，原微信脚本没有该公式。连续版本两项导数来自同一个 $(a,t)$，两者应按区间与局部导数的不同定义阅读。

基准年等效年龄需要指定 $t_0$ 并求解 $r(a_{\mathrm{eq}},t_0)=r(a,t)$，还须处理无解或多解；本示例未实现。曲面指标不能直接解释为个人生理年龄或寿命变化。

## 6. 图表、诊断和使用范围

九图覆盖曲面、年度百分比、加速度、残差、准确年份截面、指定年龄趋势、年龄百分比与移动速度、区间方向和计数拟合，PNG 与 PDF 同时保存。见 [示例图说明](../examples/README.md)。

保留原版按 $t-a$ 查看计数偏差残差的图（M11），LOESS 用于探索拟合不足，不能给出生队列作因果归因。图 05 直接提取 1990、2005、2019 年，不把邻近预测年份四舍五入后混入同一截面（M12）。

图 08 展示逐点区间是否跨零；图 09 使用实际人口和死亡数检查拟合（M13）。均值颜色不能替代区间判断，方向图未作多重比较校正，也不是同时置信带。计数诊断是样本内检查，不能作为独立预测验证。

矩形热图按相邻节点中点设置边界，适应不等距网格。数据、轴顺序、重复观测、预测网格、协方差和比值分母均有检查（M14）。密集网格只提供插值位置，预测和导数模板不得超出数据范围。

实际应用需检查人口匹配、过度离散、残差、平滑维度及导数步长。方法性能需多个生成机制、重复模拟和独立数据评价；本例用于展示可运行流程。

## 参考文献与官方说明

1. Wood SN. Fast stable restricted maximum likelihood and marginal likelihood estimation of semiparametric generalized linear models. *Journal of the Royal Statistical Society: Series B*. 2011;73(1):3–36. [DOI: 10.1111/j.1467-9868.2010.00749.x](https://doi.org/10.1111/j.1467-9868.2010.00749.x).
2. Wood SN. *Generalized Additive Models: An Introduction with R*. 2nd ed. Chapman and Hall/CRC; 2017. [DOI: 10.1201/9781315370279](https://doi.org/10.1201/9781315370279).
3. Currie ID, Durbán M, Eilers PHC. Smoothing and forecasting mortality rates. *Statistical Modelling*. 2004;4(4):279–298. [DOI: 10.1191/1471082X04st080oa](https://doi.org/10.1191/1471082X04st080oa).
4. `mgcv` 官方文档：[张量积平滑](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/te.html)、[负二项分布](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/negbin.html)、[预测矩阵与衍生量抽样](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/predict.gam.html)、[系数协方差](https://stat.ethz.ch/R-manual/R-devel/library/mgcv/html/vcov.gam.html)。
