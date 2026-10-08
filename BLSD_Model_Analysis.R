# BLSD-S：微信示例数据的一键运行入口。
# [修改 M01 | 微信原版 L4—11、L159—166]
# 原版依赖手动加载包和交互显示；现提供依赖检查、命令行参数、可重复的文件输出。
# 对照注释导航（完整说明见 docs/original_changes.md）：
# M02 原版 L14—53：模拟数据原样复现 -> R/wechat_example.R。
# M03 原版 L66—68：负二项分布与 REML -> R/blsd_models.R 的 fit_blsd_s。
# M04 原版 L82—96：相关系数抽样与逐点区间 -> draw_gaussian_coefficients。
# M05 原版 L77—83：率尺度明确、限制范围外网格 -> predict_blsd_s。
# M06 原版 L85—96：速度/加速度纠错与连续导数 -> derive_blsd_*_fields。
# M07 原版未计算：新增不等距年龄导数 -> derive_blsd_fields。
# M08 原版未计算：修正后续离散等率指标的分母时间对齐 -> derive_blsd_fields。
# M09 原版未输出：逐抽样转换年龄/年度百分比 -> analysis/run_blsd_demo.R。
# M10 原版 L99—108：从等率线增加移动速度 -> derive_blsd_continuous_fields。
# M11 原版 L128—139：残差队列图保持为计数诊断 -> R/blsd_plotting.R。
# M12 原版 L146—154：直接选择准确年份 -> R/blsd_plotting.R。
# M13 原版未输出：增加区间方向和计数诊断 -> R/blsd_plotting.R。
# M14 原版缺少防护：数据、协方差及非等距网格边界 -> core 与 plotting。
# Run with: Rscript BLSD_Model_Analysis.R
# Optional: --draws=300 --seed=123 --age-step=1 --output=outputs/demo_smoke
# All data in this example are simulated.
# [修改 M01 | 新增中文对照注释后的编码兼容]
# 某些 Windows R 会因启动环境退回 C 编码；仅在当前会话中启用 UTF-8，
# 以便 source(..., encoding="UTF-8") 能读取中文注释。
if (!isTRUE(l10n_info()[["UTF-8"]])) {
  locale_candidates <- if (.Platform$OS.type == "windows") {
    c("English_United States.utf8", "English_United States.UTF-8")
  } else c("C.UTF-8", "en_US.UTF-8")
  for (locale_candidate in locale_candidates) {
    suppressWarnings(Sys.setlocale("LC_CTYPE", locale_candidate))
    if (isTRUE(l10n_info()[["UTF-8"]])) break
  }
}
blsd_entry_root <- function() {
  command_file <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  if (length(command_file)) {
    return(dirname(normalizePath(sub("^--file=", "", command_file[1]),
                                 winslash = "/", mustWork = TRUE)))
  }
  for (frame in rev(sys.frames())) {
    if (!is.null(frame$ofile)) {
      return(dirname(normalizePath(frame$ofile, winslash = "/", mustWork = TRUE)))
    }
  }
  if (file.exists("R/blsd_models.R")) return(normalizePath("."))
  stop("Run this file from the BLSD directory, or source its absolute path.",
       call. = FALSE)
}
blsd_root <- blsd_entry_root()
source(file.path(blsd_root, "analysis", "run_blsd_demo.R"), encoding = "UTF-8")
blsd_demo_result <- run_blsd_demo(root = blsd_root,
                                args = commandArgs(trailingOnly = TRUE))
