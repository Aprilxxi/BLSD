# BLSD：贝叶斯 Lexis 曲面动态模型

[English](README.md) | 简体中文

**BLSD（Bayesian Lexis Surface Dynamics）**是统计模型，其中 Lexis 表示年龄—时期坐标结构。**BLSD Tool** 是用于运行该模型并查看分析结果的网页工具。

## 网页工具

网页源码位于 [web/](web/README.zh-CN.md)，包含 React 界面、Node.js/R 后端、模型和导出代码、测试及部署脚本。

- [安装与使用说明](web/README.zh-CN.md)
- [示例 CSV](web/data/example/example_data.csv)及[固定模拟生成规则](web/data/example/dgp_fixed_before_sampling.json)
- [Linux 部署说明](web/deployment/DEPLOYMENT_LINUX_zh.txt)
- 正式网页网址：待补充。

固定示例包含 442 条独立模拟观测，覆盖 1990–2023 年和 30–34 至 90–94 岁的 13 个封闭五岁年龄组。数据生成种子为 **20261022**。网页中的系数抽样种子可由用户设置，默认值为 **123**；修改该种子不会重新生成示例计数。

网页输出包括八类交互图表、近似 95% 逐点模型不确定区间、模型诊断、可下载图表、结果表格及完整分析归档。输入要求、服务器端处理和数据临时保留方式见[网页工具说明](web/README.zh-CN.md)。

## 独立 R 脚本

仓库还提供两个独立 R 脚本：

| 脚本 | 用途 |
| --- | --- |
| [BLSD_Analysis_Selectable.R](BLSD_Analysis_Selectable.R) | 选择拟合方法，从计数与匹配分母完成分析并生成七张图。 |
| [BLSD_Plot_Web_Download.R](BLSD_Plot_Web_Download.R) | 读取网页下载结果，保留估计值、区间和屏蔽状态，重新绘制七张图。 |

### 分析数据

首次运行时安装所需 R 包：

```r
install.packages(c("mgcv", "ggplot2", "gridExtra"))
```

在 RStudio 打开 `BLSD_Analysis_Selectable.R`，修改脚本顶部附近的 `blsd_config`，然后点击 **Source**。也可在脚本所在目录运行：

```r
source("BLSD_Analysis_Selectable.R", encoding = "UTF-8")
```

脚本嵌入了与网页相同的 442 条固定示例观测，运行时直接读取，不重新抽样。默认设置为负二项＋REML、1,000 次系数抽样、系数抽样种子 123，以及年龄和时期方向各 10 的基维度。

拟合方法通过以下两个参数选择：

| `distribution` | `smoothing` | 实际方法 |
| --- | --- | --- |
| `"quasipoisson"` | `"GCV"` | 准 Poisson＋GCV |
| `"quasipoisson"` | `"REML"` | 准 Poisson＋REML |
| `"nb"` | `"REML"` | 负二项＋REML，同时估计 θ |

负二项＋GCV 会明确报错，因为当前 `mgcv` 的相应调用使用 REML 或 UBRE。脚本检查实际拟合方法，确保方法标签与计算一致。

### 使用自己的 CSV

将 `input_csv = NULL` 改成数据路径，例如 `input_csv = "my_data.csv"`。

| 列 | 内容 |
| --- | --- |
| `Year` | 时期坐标。 |
| `Age_Group` 或 `Age_Mid` | 封闭年龄组或数值年龄中点；`30-34` 按区间 [30, 35) 取中点 32.5。 |
| `Count` 或 `Deaths` | 非负事件数，保留原始小数。 |
| `Pop` | 正的人口或暴露分母。 |
| `Sex`（可选） | 分组标签，每组独立拟合。 |

开放年龄组需先确定有依据的数值年龄坐标，再使用 `Age_Mid` 输入。多个 `Sex` 标签默认分别分析，也可通过 `selected_sexes` 指定组。每组的时期与年龄组合须唯一。

### 图表与保存

独立脚本生成七张图，依次为拟合曲面、年度变化、时间对数率曲率、拟合率—偏差残差诊断、年龄截面、年龄别时期趋势，以及年龄梯度与等效年龄移动双面板。

图表默认显示在 RStudio 的 **Plots** 面板中。设置 `output_dir = "BLSD_figures"` 后，每组另存七张 PDF 和 600 dpi PNG；`formats` 可选择 `"pdf"`、`"png"` 或两者。`blsd_result` 保留模型、系数抽样、数值表、诊断和绘图对象。残差图以每十万人拟合率为对数横轴，按年龄着色，与稿件 Figure 3D 一致。

每组还输出 `mgcv::k.check` 基维度检查，包括最大基自由度、EDF、k-index 和置换 P 值，保存在 `blsd_result$groups[[1]]$diagnostics$basis_checks`。检查使用独立种子 20261015、400 次置换和最多 5,000 条观测，并恢复随机数状态，保持原有系数抽样不变。不可用的诊断会保留状态和原因。

## 重绘网页下载结果

安装绘图和文件读取依赖：

```r
install.packages(c("ggplot2", "gridExtra", "jsonlite", "readxl"))
```

在网页下载结果后，打开 `BLSD_Plot_Web_Download.R`，将顶部附近的 `input_path` 填为下载文件路径，然后点击 **Source**。在交互式 RStudio 中留空会弹出文件选择框。

支持以下输入：

- **完整分析归档 ZIP**：推荐，包含结果数值、观测位置的拟合率、原始等高线顶点和模型诊断。
- **结果表格 ZIP**或单个 **XLSX**：支持当前中英文工作表。Excel 未保存原始等高线顶点，因此重绘时省略等高线；残差图直接使用工作表中的拟合率与偏差残差。
- 单个 `results.json` 或上述归档的解压目录。

多组归档按组分别生成七张图。脚本直接使用下载中的估计值、区间和屏蔽信息，不重新拟合或抽样。`section_years`、`trend_ages` 可选择下载网格内已有的坐标；`output_dir` 和 `formats` 控制 PDF／PNG 保存。

公式、模拟数据生成机制、区间计算、稳定性筛查和诊断规则见[方法说明](docs/methods.md)。方法参考文献沿用 JSHR 投稿稿（2026年10月25日）的编号和书目信息，软件手册链接单独列出。

## 许可证

BLSD Tool 网页工具及配套软件文档采用 [MIT 许可证](LICENSE)，Copyright © 2026 Ruhai Bai and Jinchao Hua。第三方组件、字体和外部数据保留各自的许可证及使用条款。
