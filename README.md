# BLSD Tool：分析与结果绘图

仓库提供两个独立 R 脚本：

| 脚本 | 用途 |
|---|---|
| [BLSD_Analysis_Selectable.R](BLSD_Analysis_Selectable.R) | 选择拟合方法，从计数与人口数据完成分析并生成七张图 |
| [BLSD_Plot_Web_Download.R](BLSD_Plot_Web_Download.R) | 读取网页下载的结果，保留估计值、区间和屏蔽状态，重新绘制七张图 |

## 分析数据

首次运行安装依赖：

```r
install.packages(c("mgcv", "ggplot2", "gridExtra"))
```

在 RStudio 打开 `BLSD_Analysis_Selectable.R`，修改文件顶部的 `blsd_config`，然后点击 **Source**。也可在脚本所在目录运行：

```r
source("BLSD_Analysis_Selectable.R", encoding = "UTF-8")
```

默认使用网页相同的固定示例数据：1990–2023 年、30–34 至 90–94 岁的 13 个封闭年龄组，共 442 条观测。数据已完整嵌入脚本，运行时直接读取。默认设置为负二项＋REML、1,000 次系数抽样、抽样种子 123、年龄和时期基维度各 10。

拟合方法通过两个参数选择：

| `distribution` | `smoothing` | 实际方法 |
|---|---|---|
| `"quasipoisson"` | `"GCV"` | 准 Poisson＋GCV |
| `"quasipoisson"` | `"REML"` | 准 Poisson＋REML |
| `"nb"` | `"REML"` | 负二项＋REML，同时估计 θ |

负二项＋GCV 会明确报错，因为当前 `mgcv` 对相应调用使用 REML 或 UBRE；脚本检查实际拟合方法，避免方法标签与计算不一致。

### 使用自己的 CSV

将 `input_csv = NULL` 改成数据路径，例如 `input_csv = "my_data.csv"`。

| 列 | 内容 |
|---|---|
| `Year` | 时期坐标 |
| `Age_Group` 或 `Age_Mid` | 封闭年龄组或数值年龄中点；`30-34` 按区间 [30, 35) 取中点 32.5 |
| `Count` 或 `Deaths` | 非负事件数，可保留原始小数 |
| `Pop` | 正的人口或暴露量 |
| `Sex`（可选） | 分组标签；每组独立拟合 |

开放年龄组需先确定有依据的数值年龄坐标，再使用 `Age_Mid` 输入。多个 `Sex` 标签默认分别分析，也可通过 `selected_sexes` 指定组。每组的时期与年龄组合须唯一。

### 图表与保存

七张图依次为：拟合曲面、年度变化、加速度、队列残差、年龄截面、年龄别时期趋势、年龄梯度与等死亡率年龄移动速度双面板。

默认在 RStudio 的 **Plots** 中显示。设置 `output_dir = "BLSD_figures"` 后，各组另存七张 PDF 和 600 dpi PNG；`formats` 可选择 `"pdf"`、`"png"` 或两者。`blsd_result` 保留模型、系数抽样、数值表和绘图对象。

## 重绘网页下载结果

安装绘图读取依赖：

```r
install.packages(c("ggplot2", "gridExtra", "jsonlite", "readxl"))
```

在网页下载结果后，打开 `BLSD_Plot_Web_Download.R`，将顶部 `input_path` 填为下载文件路径，然后点击 **Source**。在交互式 RStudio 中留空会弹出文件选择框。

支持以下输入：

- **完整分析归档 ZIP**：推荐，包含结果数值、原始等高线顶点和残差平滑线。
- **结果表格 ZIP**或单个 **XLSX**：支持当前中英文工作表；Excel 未保存等高线和残差平滑线，重绘时省略这些图层。
- 单个 `results.json` 或上述归档的解压目录。

多组归档按组分别生成七张图。脚本直接使用下载中的估计值、区间和屏蔽信息，不重新拟合或抽样。`section_years`、`trend_ages` 可选择下载网格内已有的坐标；`output_dir` 和 `formats` 控制 PDF／PNG 保存。

公式、区间计算、稳定性筛查和示例来源见[方法说明](docs/methods.md)。
