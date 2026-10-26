# BLSD Tool 下载结果重绘：七张图（第七张合并年龄梯度和等率年龄移动）
# 依赖：install.packages(c("ggplot2", "gridExtra", "jsonlite", "readxl"))
# 用法：在网页下载“完整分析归档”或“结果表格”，填写下面的 input_path，
# 然后在 RStudio 中 Source 整份脚本。留空时弹出文件选择框。
# 支持多组 ZIP、解压后的目录、单个 results.json 或九工作表 .xlsx。
# 推荐完整分析归档：其中保留原始等高线顶点、诊断结果和默认曲线坐标。
# Excel 未保存等高线顶点；读取 Excel 时省略等高线，不重新估计。
# 第四图按稿件 Figure 3D：拟合率（每十万人，对数横轴）与偏差残差，按年龄着色。
# 稿件符号：g_t=时期对数率斜率，g_a=年龄对数率斜率，c_t=时期对数率曲率；
# A_t=100*expm1(g_t)，A_a=100*expm1(g_a)，v=-g_t/g_a（等率年龄移动）。
# 机器字段 annual/gradient/acceleration/shift 保留下载格式。
# 全部数值、95% UI、缺失值和每个指标的屏蔽均使用下载文件；不拟合、不抽样。
# 默认依次显示七张图。output_dir 非空时同时保存，formats 可用 pdf、png。
# 多性别/分组结果各自输出七张图，不合并模型或观测。图内单位保留物理年份。
input_path <- ""                     # 例如 "BLSD_archive_all_sexes.zip"
output_dir <- NULL                   # 例如 "BLSD_redrawn_figures"
formats <- c("pdf")                 # c("pdf", "png")；PNG 为 600 dpi
section_years <- NULL                # NULL 优先使用稿件示例坐标，否则采用归档默认值
trend_ages <- NULL                   # NULL 优先使用稿件六个年龄，否则采用归档默认值

# 函数用法（脚本载入后）：
# out <- blsd_plot_download("BLSD_archive_all_sexes.zip", show_plots = FALSE,
#                          output_dir = "figures", formats = c("pdf", "png"))
# out[[1]]$tables 保留用于绘图的数值；out[[1]]$plots 是七个 ggplot/grob。
# 完整归档的现有诊断结果保留在 out[[1]]$metadata$diagnostics；Excel 不补算诊断。

.blsd_need <- function(package) {
  if (!requireNamespace(package, quietly = TRUE))
    stop("请先安装依赖：install.packages('", package, "')", call. = FALSE)
}
.blsd_value <- function(x, default = NULL) if (is.null(x)) default else x
.blsd_number <- function(x) {
  if (is.null(x) || !length(x)) return(NA_real_)
  if (!is.numeric(x) || length(x) != 1L) stop("结果包含非数值的数值字段。", call. = FALSE)
  as.numeric(x)
}
.blsd_numbers <- function(rows, key) vapply(rows, function(x) .blsd_number(x[[key]]), numeric(1))
.blsd_pair <- function(x, i) if (is.null(x) || length(x) < i) NA_real_ else .blsd_number(x[[i]])
.blsd_required <- function(x, cols, context) {
  absent <- setdiff(cols, names(x))
  if (length(absent)) stop(context, " 缺少字段：", paste(absent, collapse = ", "), call. = FALSE)
}
.blsd_check_coordinates <- function(x, context) {
  .blsd_required(x, c("year", "age"), context)
  if (!nrow(x) || any(!is.finite(x$year)) || any(!is.finite(x$age)))
    stop(context, " 的时期/年龄坐标为空或无效。", call. = FALSE)
  if (anyDuplicated(x[c("year", "age")])) stop(context, " 含重复的时期/年龄坐标。", call. = FALSE)
}

# Use an original age-group label only when it is unique for that midpoint.
.blsd_age_labels <- function(ages, labels) {
  valid <- is.finite(ages) & !is.na(labels) & nzchar(labels)
  groups <- split(labels[valid], as.character(ages[valid]))
  vapply(groups, function(x) {
    x <- unique(x)
    if (length(x) == 1L) x else ""
  }, character(1))
}

.blsd_json_group <- function(result, source) {
  if (is.null(result$points) || is.null(result$residuals))
    stop("文件不是包含预测网格及残差的完整 BLSD 结果：", source, call. = FALSE)
  rows <- result$points
  metrics <- c("surface", "rate", "annual", "acceleration", "gradient", "shift")
  fields <- setNames(lapply(metrics, function(metric) {
    if (!all(vapply(rows, function(x) metric %in% names(x), logical(1))))
      stop("完整结果缺少 ", metric, "；请从当前网页重新下载完整分析归档。", call. = FALSE)
    masked <- vapply(rows, function(x) {
      flag <- x$metricMasks[[metric]]
      if (is.null(flag) && metric == "shift") flag <- x$masked
      isTRUE(flag)
    }, logical(1))
    d <- data.frame(year = .blsd_numbers(rows, "year"), age = .blsd_numbers(rows, "age"),
                    value = .blsd_numbers(rows, metric),
                    lower = vapply(rows, function(x) .blsd_pair(x$intervals[[metric]], 1), numeric(1)),
                    upper = vapply(rows, function(x) .blsd_pair(x$intervals[[metric]], 2), numeric(1)),
                    masked = masked,
                    reason = vapply(rows, function(x) {
                      reason <- x$metricMaskReasons[[metric]]
                      if (is.null(reason) && metric == "shift") reason <- x$maskReason
                      as.character(.blsd_value(reason, ""))
                    }, character(1)), stringsAsFactors = FALSE)
    d[masked, c("value", "lower", "upper")] <- NA_real_
    .blsd_check_coordinates(d, metric)
    d
  }), metrics)
  obs <- result$residuals
  if (!length(obs) || !all(vapply(obs, function(x) "fittedRate" %in% names(x), logical(1))))
    stop("残差表缺少保存的 fittedRate；请重新下载当前完整归档，不从预测网格替代计算。", call. = FALSE)
  observations <- data.frame(year = .blsd_numbers(obs, "year"), age = .blsd_numbers(obs, "age"),
    cohort = .blsd_numbers(obs, "cohort"), observed = .blsd_numbers(obs, "observedRate"),
    fitted = .blsd_numbers(obs, "fittedRate"), residual = .blsd_numbers(obs, "devianceResidual"))
  .blsd_check_coordinates(observations, "observations")
  contours <- lapply(c("surface", "annual"), function(metric) {
    lines <- result$contours[[metric]]
    if (!length(lines)) return(data.frame(year = numeric(), age = numeric(), level = numeric(), path = integer()))
    do.call(rbind, lapply(seq_along(lines), function(i) {
      line <- lines[[i]]
      data.frame(year = vapply(line$points, .blsd_pair, numeric(1), i = 1),
                 age = vapply(line$points, .blsd_pair, numeric(1), i = 2),
                 level = .blsd_number(line$level), path = i)
    }))
  })
  names(contours) <- c("surface", "annual")
  age_labels <- .blsd_age_labels(.blsd_numbers(result$input, "Age_Mid"),
    vapply(result$input, function(x) as.character(.blsd_value(x$Age_Group, "")), character(1)))
  sex <- result$meta$sex
  if (is.null(sex) && length(result$input)) sex <- result$input[[1]]$Sex
  list(label = .blsd_value(sex, "Unlabelled"), source = source, format = "json",
       fields = fields, observations = observations,
       contours = contours, defaults = .blsd_value(result$defaults, list()),
       metadata = list(meta = result$meta, settings = result$settings, fitId = result$fitId,
                       diagnostics = result$diagnostics, age_labels = age_labels))
}

.blsd_headers <- function(d) {
  aliases <- list(
    sex = c("Sex", "性别"), year = c("Period", "Year", "时期", "年份"), age = c("Age", "年龄"),
    age_group = c("Age group", "年龄组"),
    value = c("Estimate", "估计值"), lower = c("95% UI lower", "95% UI下限"),
    upper = c("95% UI upper", "95% UI上限"), status = c("Status", "状态"),
    reason = c("Screening reason", "屏蔽原因"), ln_rate = c("ln rate", "ln率"),
    ln_lower = c("ln rate 95% UI lower", "ln率95% UI下限"),
    ln_upper = c("ln rate 95% UI upper", "ln率95% UI上限"),
    cohort = c("Approximate birth period", "Approximate birth year", "近似出生时期", "近似出生年份"),
    observed = c("Observed rate (per 100,000)", "观测率（每10万人）"),
    fitted = c("Fitted rate (per 100,000)", "拟合率（每10万人）"),
    residual = c("Deviance residual", "偏差残差"))
  for (key in names(aliases)) {
    matches <- which(names(d) %in% aliases[[key]])
    if (length(matches) > 1L) stop("工作表有重复字段：", key, call. = FALSE)
    if (length(matches)) names(d)[matches] <- key
  }
  # readxl uses logical NA for a completely empty numeric column.
  for (key in intersect(names(d), c("year", "age", "value", "lower", "upper", "ln_rate", "ln_lower", "ln_upper", "cohort", "observed", "fitted", "residual"))) {
    if (is.logical(d[[key]]) && all(is.na(d[[key]]))) d[[key]] <- as.numeric(d[[key]])
    if (!is.numeric(d[[key]])) stop("工作表数值列被改成文本：", key, call. = FALSE)
  }
  d
}

.blsd_xlsx_group <- function(path, source) {
  .blsd_need("readxl")
  sheets <- readxl::excel_sheets(path)
  aliases <- list(rate = c("Fitted rate", "拟合率"), annual = c("Annual rate change", "年变化率"),
    acceleration = c("Log-rate acceleration", "对数率加速度"), gradient = c("Age gradient", "年龄梯度"),
    shift = c("Equivalent age shift", "等效年龄移动速度"),
    observations = c("Observations and residuals", "观测与残差"))
  tables <- lapply(names(aliases), function(key) {
    sheet <- intersect(sheets, aliases[[key]])
    if (length(sheet) != 1L) stop("不是当前 BLSD 九工作表结果文件；找不到工作表：", key, call. = FALSE)
    d <- .blsd_headers(as.data.frame(readxl::read_excel(path, sheet = sheet, .name_repair = "minimal")))
    .blsd_check_coordinates(d, sheet)
    d
  })
  names(tables) <- names(aliases)
  sex <- unique(unlist(lapply(tables, function(d) d$sex), use.names = FALSE))
  sex <- sex[!is.na(sex) & nzchar(sex)]
  if (length(sex) > 1L) stop("单个工作簿包含多个组，无法确认独立拟合边界。", call. = FALSE)
  fields <- lapply(tables[c("rate", "annual", "acceleration", "gradient", "shift")], function(d) {
    .blsd_required(d, c("value", "lower", "upper", "status"), "指标工作表")
    d$masked <- d$status %in% c("Screened", "已屏蔽")
    unavailable <- d$masked | d$status %in% c("Unavailable", "不可用")
    d[unavailable, c("value", "lower", "upper")] <- NA_real_
    d
  })
  rate <- fields$rate
  .blsd_required(rate, c("ln_rate", "ln_lower", "ln_upper"),
                 "该旧工作簿未保留曲面 ln 率，请重新下载当前结果表格或使用完整分析归档；拟合率表")
  surface <- rate
  surface$value <- rate$ln_rate; surface$lower <- rate$ln_lower; surface$upper <- rate$ln_upper
  surface[surface$masked, c("value", "lower", "upper")] <- NA_real_
  fields$surface <- surface
  observations <- tables$observations
  .blsd_required(observations, c("fitted", "observed", "residual"),
                 "观测与残差；旧表若缺少拟合率，请重新下载当前结果表格")
  age_labels <- character()
  input_sheet <- intersect(sheets, c("Input data", "输入数据"))
  if (length(input_sheet) == 1L) {
    input <- .blsd_headers(as.data.frame(readxl::read_excel(path, sheet = input_sheet, .name_repair = "minimal")))
    if (all(c("age", "age_group") %in% names(input)))
      age_labels <- .blsd_age_labels(input$age, as.character(input$age_group))
  }
  message("Excel 未保存等高线顶点和默认曲线选择；省略等高线，从现有坐标选取曲线。完整分析归档保留原始等高线和诊断结果。")
  list(label = if (length(sex)) sex[[1]] else "Unlabelled", source = source, format = "xlsx",
       fields = fields, observations = observations,
       contours = list(), defaults = list(), metadata = list(age_labels = age_labels))
}

# ZIP 中只读取结果 JSON 或 XLSX。XLSX 复制到新临时文件，忽略归档路径；
# 不解压任意文件、不读取或执行 RDS 中的模型。
.blsd_read_zip <- function(path) {
  catalog <- utils::unzip(path, list = TRUE)
  selected <- catalog$Name[grepl("(^|/)results[.]json$", catalog$Name)]
  kind <- "json"
  if (!length(selected)) {
    selected <- catalog$Name[grepl("[.]xlsx$", catalog$Name, ignore.case = TRUE)]
    kind <- "xlsx"
  }
  if (!length(selected)) stop("ZIP 中没有 results.json 或 .xlsx；请选择完整分析归档/结果表格，不能使用图表 ZIP。", call. = FALSE)
  if (anyDuplicated(selected)) stop("ZIP 中含重复结果路径。", call. = FALSE)
  lapply(selected, function(entry) {
    conn <- unz(path, entry, open = "rb"); on.exit(close(conn), add = TRUE)
    if (kind == "json") {
      .blsd_need("jsonlite")
      # unz connections are not seekable on all platforms; read binary chunks.
      chunks <- list(); n <- 0L
      repeat {
        chunk <- readBin(conn, "raw", n = 65536L)
        if (!length(chunk)) break
        n <- n + 1L; chunks[[n]] <- chunk
      }
      text <- rawToChar(do.call(c, chunks)); Encoding(text) <- "UTF-8"
      result <- jsonlite::fromJSON(text, simplifyVector = FALSE)
      .blsd_json_group(result, paste0(basename(path), "!", entry))
    } else {
      temp <- tempfile(fileext = ".xlsx"); on.exit(unlink(temp), add = TRUE)
      target <- file(temp, "wb")
      tryCatch(repeat {
        chunk <- readBin(conn, "raw", n = 65536L)
        if (!length(chunk)) break
        writeBin(chunk, target)
      }, finally = close(target))
      .blsd_xlsx_group(temp, paste0(basename(path), "!", entry))
    }
  })
}

blsd_read_download <- function(path) {
  if (length(path) != 1L || !is.character(path) || !nzchar(path) || !file.exists(path))
    stop("请选择存在的 BLSD 结果文件或解压目录。", call. = FALSE)
  if (dir.exists(path)) {
    candidates <- list.files(path, pattern = "^results[.]json$", recursive = TRUE, full.names = TRUE)
    if (!length(candidates)) candidates <- list.files(path, pattern = "[.]xlsx$", recursive = TRUE, full.names = TRUE, ignore.case = TRUE)
    if (!length(candidates)) stop("目录内未找到 results.json 或 .xlsx。", call. = FALSE)
    return(unlist(lapply(candidates, blsd_read_download), recursive = FALSE))
  }
  extension <- tolower(tools::file_ext(path))
  if (extension == "zip") return(.blsd_read_zip(path))
  if (extension == "xlsx") return(list(.blsd_xlsx_group(path, basename(path))))
  if (extension == "json") {
    .blsd_need("jsonlite")
    return(list(.blsd_json_group(jsonlite::fromJSON(path, simplifyVector = FALSE), basename(path))))
  }
  stop("支持 .zip、.xlsx、results.json 和解压目录。单张 CSV 不包含七张图所需的完整数据。", call. = FALSE)
}

.blsd_choose <- function(requested, defaults, observed, available, number, label) {
  available <- sort(unique(available[is.finite(available)]))
  if (!is.null(requested)) {
    if (!is.numeric(requested) || !length(requested) || any(!is.finite(requested)) || any(!requested %in% available))
      stop(label, " 必须是下载网格已有的坐标。可用坐标：", paste(available, collapse = ", "), call. = FALSE)
    return(unique(requested))
  }
  defaults <- as.numeric(unlist(defaults, use.names = FALSE))
  defaults <- defaults[defaults %in% available]
  if (length(defaults)) return(unique(defaults))
  choices <- sort(intersect(observed, available))
  if (!length(choices)) choices <- available
  unique(choices[round(seq(1, length(choices), length.out = min(number, length(choices))))])
}

.blsd_cells <- function(d) {
  # Retained grids can be irregular after adding exact observed ages.
  # Tile bounds use neighbouring coordinate midpoints; values are not interpolated.
  edges <- function(x) {
    x <- sort(unique(x)); n <- length(x)
    if (n < 2L) return(data.frame(x = x, low = x - 0.5, high = x + 0.5))
    middle <- (head(x, -1L) + tail(x, -1L)) / 2
    data.frame(x = x, low = c(x[1], middle), high = c(middle, x[n]))
  }
  y <- edges(d$year); a <- edges(d$age)
  d$xmin <- y$low[match(d$year, y$x)]; d$xmax <- y$high[match(d$year, y$x)]
  d$ymin <- a$low[match(d$age, a$x)]; d$ymax <- a$high[match(d$age, a$x)]
  d
}

.blsd_heatmap <- function(d, metric, contours = NULL) {
  # Determine cell edges before excluding endpoint curvature, retaining their interior half-edges.
  d <- .blsd_cells(d)
  if (metric == "acceleration") {
    # Drop only entire period columns explicitly screened as spline boundaries.
    boundary <- d$reason %in% c("NATURAL_SPLINE_BOUNDARY", "Period boundary", "Year boundary", "时期边界", "年份边界")
    omit <- vapply(split(boundary, d$year), all, logical(1))
    d <- d[!d$year %in% as.numeric(names(omit)[omit]), , drop = FALSE]
  }
  if (!nrow(d)) stop("指标没有可绘制的坐标：", metric, call. = FALSE)
  p <- ggplot2::ggplot(d) +
    ggplot2::geom_rect(ggplot2::aes(xmin = xmin, xmax = xmax, ymin = ymin, ymax = ymax, fill = value)) +
    ggplot2::coord_cartesian(expand = FALSE) + ggplot2::labs(x = "Period", y = "Age (years)")
  labels <- c(surface = "ln(rate per 100,000)", annual = "% / year", acceleration = "Log-rate curvature / year^2",
              gradient = "% / age-year", shift = "Age-years / year")
  if (metric == "surface") p <- p + ggplot2::scale_fill_viridis_c(name = labels[[metric]], na.value = "grey90")
  else if (metric == "gradient") p <- p + ggplot2::scale_fill_gradientn(colours = c("#346D8C", "#F7F5F0", "#CE8D5E"), name = labels[[metric]], na.value = "grey90")
  else if (metric == "shift") {
    limit <- max(c(abs(d$value[is.finite(d$value)]), 0))
    if (limit == 0) limit <- 1
    p <- p + ggplot2::scale_fill_gradient2(low = "#346D8C", mid = "#F7F5F0", high = "#CE8D5E",
      midpoint = 0, limits = c(-limit, limit), name = labels[[metric]], na.value = "grey90")
  } else p <- p + ggplot2::scale_fill_gradient2(low = "#2166AC", mid = "#FFFFFF", high = "#B2182B",
      midpoint = 0, name = labels[[metric]], na.value = "grey90")
  if (!is.null(contours) && nrow(contours)) p <- p +
    ggplot2::geom_path(data = contours, ggplot2::aes(x = year, y = age, group = path),
      inherit.aes = FALSE, colour = if (metric == "surface") "white" else "#424242", linewidth = 0.3)
  p
}

.blsd_group_plots <- function(group, section_years, trend_ages) {
  fields <- group$fields; obs <- group$observations; rate <- fields$rate
  default_years <- group$defaults$sectionYears; default_ages <- group$defaults$trendAges
  manuscript_ages <- c(32.5, 42.5, 52.5, 62.5, 82.5, 92.5)
  if (all(range(obs$year) == c(1990, 2023)) && all(c(1990, 2005, 2023) %in% rate$year))
    default_years <- c(1990, 2005, 2023)
  if (all(manuscript_ages %in% obs$age) && all(manuscript_ages %in% rate$age))
    default_ages <- manuscript_ages
  years <- .blsd_choose(section_years, default_years, obs$year, rate$year, 3, "section_years")
  ages <- .blsd_choose(trend_ages, default_ages, obs$age, rate$age, 6, "trend_ages")
  theme <- ggplot2::theme_minimal(base_size = 11) +
    ggplot2::theme(legend.position = "bottom", legend.key.width = grid::unit(1, "cm"),
      panel.grid.major = ggplot2::element_line(colour = "#e7e8eb"),
      panel.grid.minor = ggplot2::element_line(colour = "#eeeeee"),
      axis.line = ggplot2::element_blank(), plot.margin = ggplot2::margin(5, 6, 5, 5))
  p1 <- .blsd_heatmap(fields$surface, "surface", group$contours$surface) + theme
  p2 <- .blsd_heatmap(fields$annual, "annual", group$contours$annual) + theme
  p3 <- .blsd_heatmap(fields$acceleration, "acceleration") + theme
  # Figure 3D: the original fitted rate at each observation, never observed rate or grid matching.
  residual_rows <- is.finite(obs$fitted) & obs$fitted > 0 & is.finite(obs$residual)
  if (!any(residual_rows)) stop("没有可用于对数横轴残差图的正拟合率。", call. = FALSE)
  if (any(!residual_rows)) message(sum(!residual_rows), " 个非有限残差或非正拟合率保留在数值表中，未在残差图中绘制。")
  p4 <- ggplot2::ggplot(obs[residual_rows, , drop = FALSE], ggplot2::aes(fitted, residual)) +
    ggplot2::geom_hline(yintercept = 0, colour = "#000000", linetype = "dashed", linewidth = 0.28) +
    ggplot2::geom_point(ggplot2::aes(colour = age), size = 1.15, alpha = 0.5, stroke = 0) +
    ggplot2::scale_colour_viridis_c(name = "Age (years)") +
    ggplot2::scale_x_log10(labels = scales::label_number(big.mark = "")) +
    ggplot2::labs(x = "Fitted rate per 100,000", y = "Deviance residual") + theme
  sections <- rate[rate$year %in% years, ]; sections$period <- factor(sections$year, levels = years)
  observed_sections <- obs[obs$year %in% years & is.finite(obs$observed) & obs$observed > 0, ]
  observed_sections$period <- factor(observed_sections$year, levels = years)
  p5 <- ggplot2::ggplot(sections, ggplot2::aes(age, value, colour = period, fill = period)) +
    ggplot2::geom_ribbon(ggplot2::aes(ymin = lower, ymax = upper), colour = NA, alpha = 0.15, na.rm = TRUE) +
    ggplot2::geom_line(linewidth = 0.6, na.rm = TRUE) +
    ggplot2::geom_point(data = observed_sections, ggplot2::aes(y = observed), size = 1.1) +
    ggplot2::scale_y_log10() + ggplot2::labs(x = "Age (years)", y = "Rate per 100,000", colour = "Period", fill = "Period") + theme
  trends <- rate[rate$age %in% ages, ]; trends$age_label <- factor(trends$age, levels = ages)
  observed_trends <- obs[obs$age %in% ages, ]; observed_trends$age_label <- factor(observed_trends$age, levels = ages)
  trend_labels <- setNames(as.character(ages), as.character(ages))
  saved_labels <- group$metadata$age_labels
  available_labels <- intersect(names(trend_labels), names(saved_labels))
  available_labels <- available_labels[nzchar(saved_labels[available_labels])]
  trend_labels[available_labels] <- saved_labels[available_labels]
  p6 <- ggplot2::ggplot(trends, ggplot2::aes(year, value)) +
    ggplot2::geom_ribbon(ggplot2::aes(ymin = lower, ymax = upper), fill = "#2C7FB8", alpha = 0.2, na.rm = TRUE) +
    ggplot2::geom_line(colour = "#2166AC", linewidth = 0.6, na.rm = TRUE) +
    ggplot2::geom_point(data = observed_trends, ggplot2::aes(y = observed), size = 1, na.rm = TRUE) +
    ggplot2::facet_wrap(~age_label, scales = "free_y", ncol = 3,
      labeller = ggplot2::labeller(age_label = trend_labels)) +
    ggplot2::labs(x = "Period", y = "Rate per 100,000") + theme
  p7a <- .blsd_heatmap(fields$gradient, "gradient") + theme
  p7b <- .blsd_heatmap(fields$shift, "shift") + theme
  # Build the combined panel off-screen so Source opens no leading blank page.
  p7 <- (function() {
    previous <- grDevices::dev.cur()
    grDevices::pdf(file = NULL)
    device <- grDevices::dev.cur()
    on.exit({
      grDevices::dev.off(device)
      if (previous > 1L && previous %in% grDevices::dev.list()) grDevices::dev.set(previous)
    }, add = TRUE)
    gridExtra::arrangeGrob(p7a, p7b, ncol = 2)
  })()
  list(plots = list(p1, p2, p3, p4, p5, p6, p7),
       tables = list(fields = fields, observations = obs, contours = group$contours),
       section_years = years, trend_ages = ages, metadata = group$metadata,
       label = group$label, source = group$source)
}

blsd_plot_download <- function(path, output_dir = NULL, formats = c("pdf"),
                               section_years = NULL, trend_ages = NULL, show_plots = TRUE) {
  .blsd_need("ggplot2"); .blsd_need("gridExtra")
  if (!length(formats) || any(!formats %in% c("pdf", "png"))) stop("formats 仅支持 pdf、png。", call. = FALSE)
  groups <- blsd_read_download(path)
  results <- vector("list", length(groups))
  figure_names <- c("fitted_surface", "annual_change", "acceleration", "fitted_rate_residuals",
                    "age_sections", "age_specific_trends", "age_gradient_and_equal_rate_shift")
  for (i in seq_along(groups)) {
    group <- groups[[i]]
    message(sprintf("组 %d/%d：%s；来源 %s", i, length(groups), group$label, group$source))
    results[[i]] <- .blsd_group_plots(group, section_years, trend_ages)
    if (!is.null(output_dir)) {
      label <- gsub("[^[:alnum:]_.-]", "_", group$label)
      label <- substr(label, 1L, 60L)
      target <- file.path(output_dir, sprintf("%02d_%s", i, label))
      dir.create(target, recursive = TRUE, showWarnings = FALSE)
      if (!dir.exists(target)) stop("无法创建输出目录：", target, call. = FALSE)
    }
    for (j in seq_along(results[[i]]$plots)) {
      plot <- results[[i]]$plots[[j]]
      if (show_plots) {
        if (inherits(plot, "ggplot")) print(plot) else { grid::grid.newpage(); grid::grid.draw(plot) }
      }
      if (!is.null(output_dir)) for (format in unique(formats)) {
        filename <- file.path(target, sprintf("Figure%d_%s.%s", j, figure_names[j], format))
        ggplot2::ggsave(filename, plot = plot, width = if (j == 7L) 250 else 180,
          height = if (j == 6L) max(95, ceiling(length(results[[i]]$trend_ages) / 3) * 52) else 120,
          units = "mm", dpi = 600, bg = "white", limitsize = FALSE)
      }
    }
  }
  names(results) <- sprintf("%02d_%s", seq_along(groups), vapply(groups, function(x) x$label, character(1)))
  invisible(results)
}

if (nzchar(input_path)) {
  blsd_redrawn <- blsd_plot_download(input_path, output_dir, formats, section_years, trend_ages)
} else if (interactive() && isTRUE(getOption("blsd.plot.choose_file", TRUE))) {
  input_path <- file.choose()
  blsd_redrawn <- blsd_plot_download(input_path, output_dir, formats, section_years, trend_ages)
}
