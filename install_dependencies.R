# [修改 M01 | 微信原版 L4—9]
# 原版只注释提示安装多个包；本示例单独检查并安装实际用到的三个依赖。
# Run once before the demonstration.
packages <- c("mgcv", "ggplot2", "gridExtra")
missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing)) {
  install.packages(missing, repos = "https://cloud.r-project.org")
} else {
  message("All BLSD demonstration dependencies are already installed.")
}
