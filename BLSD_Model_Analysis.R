# ============================================================
# BLSD_Model_Analysis.R：在微信原版基础上修改的完整单文件版本
# ============================================================
# 以原版167行脚本为对照，保留0—4节的总体结构和模拟数据生成机制。
# 本文件直接包含模拟、GAM拟合、抽样、导数、全部九组绘图及结果保存。
# 单独下载本文件即可运行；仅需R及以下三个包，不读取其他项目脚本或CSV。
# 首次安装：install.packages(c("mgcv", "ggplot2", "gridExtra"))
# 运行：Rscript BLSD_Model_Analysis.R
# 可选：--draws=300 --seed=123 --age-step=1 --output=outputs/demo_smoke
# R/RStudio：source("BLSD_Model_Analysis.R")
# 仅加载函数供测试：options(blsd.run_demo=FALSE)
# 修改处以M01—M14注释，说明原版位置、调整内容与原因。

# ============================================================
# 0. 环境准备与运行设置（对照微信原版L4—11）
# ============================================================
# [修改 M01] 原版需要tidyverse/metR/viridis等；现用命名空间调用三个实际依赖。
# 中文注释使用UTF-8。以下设置仅作用于当前R会话，不修改系统设置。
if (!isTRUE(l10n_info()[["UTF-8"]])) {
  locale_candidates <- if (.Platform$OS.type == "windows") {
    c("English_United States.utf8", "English_United States.UTF-8")
  } else c("C.UTF-8", "en_US.UTF-8")
  for (locale_candidate in locale_candidates) {
    suppressWarnings(Sys.setlocale("LC_CTYPE", locale_candidate))
    if (isTRUE(l10n_info()[["UTF-8"]])) break
  }
}

# [修改 M01] 定位本文件所在目录；独立复制或在RStudio中运行均可保存结果。
blsd_entry_root <- function() {
  for (frame in rev(sys.frames())) {
    if (!is.null(frame$ofile)) {
      return(dirname(normalizePath(frame$ofile, winslash="/", mustWork=TRUE)))
    }
  }
  command_file <- grep("^--file=", commandArgs(trailingOnly=FALSE), value=TRUE)
  if (length(command_file)) {
    return(dirname(normalizePath(sub("^--file=", "", command_file[1]),
                                 winslash="/", mustWork=TRUE)))
  }
  normalizePath(getwd(), winslash="/", mustWork=TRUE)
}
blsd_script_directory <- blsd_entry_root()

# BLSD-S 示例运行流程。数据为微信原版模拟数据。
# [修改 M01 | 微信原版 L159—166 只交互展示四图]
# 增加可配置的抽样数与输出目录，保存九组图及可复核数值表。
parse_blsd_demo_args <- function(args) {
  settings <- list(draws = 1000L, seed = 123L, age_step = 1,
                   output = "outputs/demo", help = FALSE)
  for (arg in args) {
    if (arg %in% c("--help", "-h")) { settings$help <- TRUE; next }
    if (!grepl("^--(draws|seed|age-step|output)=", arg)) {
      stop("Unknown argument: ", arg, call. = FALSE)
    }
    key <- sub("^--([^=]+)=.*$", "\\1", arg)
    value <- sub("^--[^=]+=", "", arg)
    if (key == "output") {
      if (!nzchar(value)) stop("output must not be empty.", call. = FALSE)
      settings$output <- value
    } else {
      number <- suppressWarnings(as.numeric(value))
      if (length(number) != 1L || !is.finite(number)) {
        stop("Invalid numeric argument: ", arg, call. = FALSE)
      }
      if (key == "age-step") {
        if (number <= 0 || number > 5) {
          stop("age-step must be greater than 0 and at most 5.", call. = FALSE)
        }
        settings$age_step <- number
      } else {
        if (number != floor(number) || number < 0 ||
            number > .Machine$integer.max ||
            (key == "draws" && number < 20)) {
          stop("draws must be an integer >= 20; seed must be a nonnegative integer.",
               call. = FALSE)
        }
        settings[[key]] <- as.integer(number)
      }
    }
  }
  settings
}



# ============================================================
# 1. 数据模拟（保留微信原版L18—53的公式和随机数调用顺序）
# ============================================================

# [保留 M02 | 微信原版 L14—53]
# 保留 seed、年龄/年份、人口公式、随机数调用顺序、真率公式和 Poisson 死亡数。
# 数据生成放入函数以便复现与核验；85+ 取90岁只沿用原模拟的演示约定。
simulate_wechat_example <- function(seed = 123L) {
  if (length(seed) != 1L || !is.finite(seed) || seed != as.integer(seed)) {
    stop("seed must be one finite integer.", call. = FALSE)
  }
  set.seed(as.integer(seed))
  years <- 1990:2019
  age_starts <- seq(0, 85, by = 5)
  age_groups <- paste0(age_starts, "-", age_starts + 4)
  age_groups[length(age_groups)] <- "85+"
  data <- expand.grid(Year = years, Age_Group = age_groups)
  age_mids <- c(seq(2.5, 82.5, by = 5), 90)
  data$Age_Mid <- rep(age_mids, each = length(years))
  data$Pop <- round(runif(nrow(data), 10000, 50000) *
                      (1 + (data$Age_Mid / 100)^2))
  true_rate <- function(age, year) {
    time_idx <- year - 1990
    base_risk <- -12 + 0.12 * age
    time_trend <- -0.02 * time_idx
    interaction <- 0.0005 * age * time_idx
    noise <- rnorm(length(age), 0, 0.05)
    young_rebound <- ifelse(age < 50 & year > 2010,
                            0.05 * (year - 2010), 0)
    exp(base_risk + time_trend - interaction + young_rebound + noise)
  }
  data$Rate_True <- true_rate(data$Age_Mid, data$Year)
  data$Deaths <- rpois(nrow(data), data$Pop * data$Rate_True)
  data$Mortality_Rate <- data$Deaths / data$Pop * 100000
  data
}


# ============================================================
# 2. BLSD-S模型构建、相关系数抽样与死亡率预测
# 对照微信原版L66—83；模型与全部数值实现直接写在本文件内。
# ============================================================

required_blsd_columns <- c("Year", "Age_Mid", "Deaths", "Pop")

blsd_core_version <- "2.1.3-singlefile-20261009"

validate_blsd_scalar <- function(x, name, lower = 0, integer = FALSE, strict = FALSE) {
  if (!is.numeric(x) || length(x) != 1L || !is.finite(x) ||
      (if (strict) x <= lower else x < lower) || (integer && x != round(x))) {
    stop(name, " must be a finite numeric scalar ",
         if (strict) "greater than " else "at least ", lower,
         if (integer) " and an integer." else ".", call. = FALSE)
  }
  invisible(x)
}

validate_blsd_axis <- function(x, name) {
  if (!is.numeric(x) || !length(x) || any(!is.finite(x)) ||
      is.unsorted(x, strictly = TRUE)) {
    stop(name, " must be a nonempty, finite, strictly increasing numeric vector.", call. = FALSE)
  }
  invisible(x)
}

check_blsd_packages <- function() {
  needed <- c("mgcv", "ggplot2")
  missing <- needed[!vapply(needed, requireNamespace, logical(1), quietly = TRUE)]
  if (length(missing)) {
    stop(
      "Install the following packages before running BLSD: ",
      paste(missing, collapse = ", "),
      call. = FALSE
    )
  }
  invisible(TRUE)
}

# [修改 M14 | 原版 L23—53 未进行这类输入验证]
# 检查有限死亡数、正人口和重复单元，避免错误数据产生看似正常的结果。
validate_blsd_data <- function(data) {
  if (!is.data.frame(data) || !nrow(data)) {
    stop("data must be a nonempty data frame.", call. = FALSE)
  }
  missing <- setdiff(required_blsd_columns, names(data))
  if (length(missing)) {
    stop("Missing required columns: ", paste(missing, collapse = ", "), call. = FALSE)
  }

  for (nm in required_blsd_columns) {
    if (!is.numeric(data[[nm]])) {
      stop(nm, " must be numeric.", call. = FALSE)
    }
  }
  if (any(!is.finite(data$Year)) || any(!is.finite(data$Age_Mid))) {
    stop("Year and Age_Mid must contain only finite values.", call. = FALSE)
  }
  if (any(!is.finite(data$Deaths)) || any(data$Deaths < 0)) {
    stop("Deaths must contain finite non-negative values.", call. = FALSE)
  }
  if (any(!is.finite(data$Pop)) || any(data$Pop <= 0)) {
    stop("Pop must contain finite positive values.", call. = FALSE)
  }
  if (any(abs(data$Deaths - round(data$Deaths)) > sqrt(.Machine$double.eps))) {
    warning(
      "Deaths contains non-integer estimates. For GBD-like estimated outcomes, ",
      "a measurement-error likelihood should replace the count likelihood in ",
      "the final fully Bayesian implementation.",
      call. = FALSE
    )
  }
  if (anyDuplicated(data[c("Year", "Age_Mid")])) {
    stop("Each age-period cell must occur once; aggregate counts and matching exposure explicitly.", call. = FALSE)
  }
  if (length(unique(data$Year)) < 5L || length(unique(data$Age_Mid)) < 5L) {
    stop("BLSD requires at least five distinct years and five distinct ages.", call. = FALSE)
  }
  invisible(data)
}

# [修改 M03 | 原版 L66—68]
# 保留死亡计数响应、张量积平滑和 log(Pop) 偏置项；准 Poisson 改为负二项，
# 显式采用 REML 选择平滑程度。改变的是方差假设与估计准则，不保证效果自动更好。
fit_blsd_s <- function(
    data,
    k_age = 10L,
    k_period = 10L,
    family = c("nb", "poisson")) {
  check_blsd_packages()
  validate_blsd_data(data)
  family <- match.arg(family)

  validate_blsd_scalar(k_age, "k_age", 4, integer = TRUE)
  validate_blsd_scalar(k_period, "k_period", 4, integer = TRUE)

  k_age <- min(as.integer(k_age), length(unique(data$Age_Mid)) - 1L)
  k_period <- min(as.integer(k_period), length(unique(data$Year)) - 1L)
  if (k_age < 4L || k_period < 4L) {
    stop("k_age and k_period must both be at least 4 after range checks.", call. = FALSE)
  }

  family_object <- switch(
    family,
    nb = mgcv::nb(link = "log"),
    poisson = stats::poisson(link = "log")
  )

  # Keep the conventional smooth name inside the formula while avoiding a
  # requirement that users attach mgcv to the search path.
  te <- mgcv::te

  model <- mgcv::gam(
    Deaths ~ te(
      Age_Mid,
      Year,
      k = c(k_age, k_period),
      bs = c("cr", "cr")
    ) + offset(log(Pop)),
    family = family_object,
    method = "REML",
    data = data
  )

  structure(
    list(
      model = model,
      data = data,
      specification = list(
        name = "BLSD-S",
        engine = "mgcv empirical-Bayes prototype",
        family = family,
        k_age = k_age,
        k_period = k_period,
        core_version = blsd_core_version,
        likelihood = "Deaths with log(Pop) offset; rate = expected deaths / matching exposure"
      )
    ),
    class = "blsd_s"
  )
}

# [修改 M04 | 原版 L82—96 主要使用点估计，未向动态量传播系数不确定性]
# 依据 Vc（可用时）或 Vp 抽取相关系数，每次抽样对应一张完整曲面；
# 这是高斯后验近似，不是对所有平滑参数及离散参数的联合贝叶斯抽样。
draw_gaussian_coefficients <- function(model, n_draws, seed = NULL) {
  validate_blsd_scalar(n_draws, "n_draws", 1, integer = TRUE)
  if (!is.null(seed)) {
    set.seed(seed)
  }
  beta <- stats::coef(model)
  covariance <- if (!is.null(model$Vc)) model$Vc else model$Vp
  if (!length(beta) || any(!is.finite(beta)) || !is.matrix(covariance) ||
      !identical(dim(covariance), c(length(beta), length(beta))) || any(!is.finite(covariance))) {
    stop("Model coefficients and their covariance must be finite and conformable.", call. = FALSE)
  }
  covariance <- (covariance + t(covariance)) / 2
  decomposition <- eigen(covariance, symmetric = TRUE)
  tolerance <- 1e-8 * max(abs(decomposition$values), .Machine$double.eps)
  if (min(decomposition$values) < -tolerance) {
    stop("Coefficient covariance is materially non-positive-semidefinite; diagnose the fit before drawing.", call. = FALSE)
  }
  eigenvalues <- pmax(decomposition$values, 0)
  innovations <- matrix(
    stats::rnorm(length(beta) * n_draws),
    nrow = length(beta),
    ncol = n_draws
  )
  draws <- decomposition$vectors %*%
    (sqrt(eigenvalues) * innovations)
  draws <- sweep(draws, 1L, beta, FUN = "+")
  rownames(draws) <- names(beta)
  attr(draws, "covariance_diagnostics") <- list(
    source = if (!is.null(model$Vc)) "Vc" else "Vp",
    smoothing_parameter_uncertainty_corrected = !is.null(model$Vc),
    minimum_eigenvalue = min(decomposition$values),
    negative_eigenvalues_clipped = sum(decomposition$values < 0),
    negative_tolerance = tolerance,
    interval_scope = "Approximate pointwise coefficient uncertainty; not a full joint Bayesian fit"
  )
  draws
}

# [修改 M04、M14 | 原版未输出这些动态量的抽样区间和有效比例]
# 非线性量先逐抽样计算，再汇总均值与分位数；全无效行返回 NA 而非 NaN。
summarize_draw_matrix <- function(draws, grid, value_name) {
  if (!is.matrix(draws) || !is.numeric(draws) || !ncol(draws) || nrow(draws) != nrow(grid)) {
    stop("The number of draw rows must equal the number of grid rows.", call. = FALSE)
  }
  # Ratios can have no retained draws. Report explicit missing summaries and
  # effective sample fractions, rather than NaN or infinite quantiles.
  draws[!is.finite(draws)] <- NA_real_
  valid_n <- rowSums(!is.na(draws))
  safe_quantile <- function(x, p) {
    if (all(is.na(x))) NA_real_ else unname(stats::quantile(x, p, na.rm = TRUE))
  }
  output <- grid
  output[[value_name]] <- rowMeans(draws, na.rm = TRUE)
  output[[value_name]][valid_n == 0] <- NA_real_
  output[[paste0(value_name, "_lower")]] <- apply(
    draws, 1L, safe_quantile, p = 0.025
  )
  output[[paste0(value_name, "_upper")]] <- apply(
    draws, 1L, safe_quantile, p = 0.975
  )
  output[[paste0("Pr_", value_name, "_positive")]] <- rowMeans(draws > 0, na.rm = TRUE)
  output[[paste0("Pr_", value_name, "_positive")]][valid_n == 0] <- NA_real_
  output[[paste0(value_name, "_valid_n")]] <- valid_n
  output[[paste0(value_name, "_valid_fraction")]] <- valid_n / ncol(draws)
  output
}

#' Draw the BLSD-S posterior surface on an ordered rectangular in-range grid
# [修改 M05 | 原版 L77—83]
# 原网格延伸到 92.5 岁，超出模拟中点上限 90 岁；现网格限制在观测范围。
# 用 Pop=1 和不含偏置项的预测矩阵得到每人对数率，再统一换算为每10万人率。
predict_blsd_s <- function(
    object,
    ages = sort(unique(object$data$Age_Mid)),
    years = seq(min(object$data$Year), max(object$data$Year), by = 1),
    n_draws = 1000L,
    seed = 123,
    rate_scale = 100000) {
  if (!inherits(object, "blsd_s")) {
    stop("object must be returned by fit_blsd_s().", call. = FALSE)
  }
  validate_blsd_scalar(n_draws, "n_draws", 20, integer = TRUE)
  validate_blsd_scalar(rate_scale, "rate_scale", strict = TRUE)
  validate_blsd_axis(ages, "ages")
  validate_blsd_axis(years, "years")
  n_draws <- as.integer(n_draws)
  age_range <- range(object$data$Age_Mid)
  year_range <- range(object$data$Year)
  if (any(ages < age_range[1L] | ages > age_range[2L])) {
    stop("ages must remain inside the observed age range.", call. = FALSE)
  }
  if (any(years < year_range[1L] | years > year_range[2L])) {
    stop("years must remain inside the observed period range.", call. = FALSE)
  }
  if (is.unsorted(ages, strictly = TRUE) || is.unsorted(years, strictly = TRUE)) {
    stop("ages and years must be strictly increasing.", call. = FALSE)
  }

  grid <- expand.grid(
    Age_Mid = ages,
    Year = years,
    KEEP.OUT.ATTRS = FALSE,
    stringsAsFactors = FALSE
  )
  grid$Pop <- 1
  linear_predictor <- stats::predict(
    object$model,
    newdata = grid,
    type = "lpmatrix"
  )
  coefficient_draws <- draw_gaussian_coefficients(
    object$model,
    n_draws = as.integer(n_draws),
    seed = seed
  )
  eta_draws <- linear_predictor %*% coefficient_draws
  rate_draws <- exp(eta_draws) * rate_scale

  structure(
    list(
      grid = grid[c("Age_Mid", "Year")],
      ages = ages,
      years = years,
      eta_draws = eta_draws,
      rate_draws = rate_draws,
      rate_summary = summarize_draw_matrix(
        rate_draws,
        grid[c("Age_Mid", "Year")],
        "Rate"
      ),
      n_draws = n_draws,
      rate_scale = rate_scale,
      coefficient_draws = coefficient_draws,
      covariance_diagnostics = attr(coefficient_draws, "covariance_diagnostics"),
      core_version = blsd_core_version
    ),
    class = "blsd_prediction"
  )
}

summarize_draw_array <- function(values, ages, years, value_name) {
  dims <- dim(values)
  if (length(dims) != 3L || dims[1L] != length(ages) || dims[2L] != length(years)) {
    stop("values must be an age by year by draw array.", call. = FALSE)
  }
  draw_matrix <- matrix(values, nrow = length(ages) * length(years), ncol = dims[3L])
  grid <- expand.grid(
    Age_Mid = ages,
    Year = years,
    KEEP.OUT.ATTRS = FALSE,
    stringsAsFactors = FALSE
  )
  summarize_draw_matrix(draw_matrix, grid, value_name)
}

validate_blsd_prediction <- function(prediction) {
  if (!inherits(prediction, "blsd_prediction")) {
    stop("prediction must be returned by predict_blsd_s().", call. = FALSE)
  }
  validate_blsd_axis(prediction$ages, "prediction$ages")
  validate_blsd_axis(prediction$years, "prediction$years")
  validate_blsd_scalar(prediction$n_draws, "prediction$n_draws", 1, integer = TRUE)
  expected <- expand.grid(Age_Mid = prediction$ages, Year = prediction$years,
                          KEEP.OUT.ATTRS = FALSE, stringsAsFactors = FALSE)
  if (!is.data.frame(prediction$grid) ||
      !all(c("Age_Mid", "Year") %in% names(prediction$grid)) ||
      !isTRUE(all.equal(as.matrix(prediction$grid[c("Age_Mid", "Year")]),
                       as.matrix(expected), check.attributes = FALSE)) ||
      !is.matrix(prediction$eta_draws) ||
      !identical(dim(prediction$eta_draws), c(nrow(expected), as.integer(prediction$n_draws))) ||
      any(!is.finite(prediction$eta_draws))) {
    stop("Prediction must have a complete age-fastest ordered grid and finite conformable eta_draws.", call. = FALSE)
  }
  invisible(prediction)
}

summarize_blsd_iso <- function(draws, grid) {
  out <- summarize_draw_matrix(draws, grid, "Iso_Risk_Velocity")
  out$Effective_Draw_N <- out$Iso_Risk_Velocity_valid_n
  out$Effective_Draw_Fraction <- out$Iso_Risk_Velocity_valid_fraction
  out
}



# ============================================================
# 3. 挖掘与可视化（对照微信原版L85—154）
# 3.1 正确计算速度、加速度、年龄梯度与等死亡率移动速度
# ============================================================

#' Derive physically motivated BLSD fields
#'
#' These are divided differences, not continuous partial derivatives.
#' Year retains the interval END label for compatibility; metadata gives the
#' actual interval and the centre of the three-point second difference.
# [修改 M06 | 原版 L85—96]
# 原加速度为对展开向量直接 diff，未除时间间隔且跨年龄组边界；
# 现按同一年龄、同一次抽样计算区间速度与二阶差分，并输出准确时间位置。
derive_blsd_fields <- function(prediction, min_abs_age_gradient = 0.005) {
  validate_blsd_prediction(prediction)
  validate_blsd_scalar(min_abs_age_gradient, "min_abs_age_gradient", strict = TRUE)
  ages <- prediction$ages
  years <- prediction$years
  n_age <- length(ages)
  n_year <- length(years)
  n_draw <- prediction$n_draws
  if (n_age < 3L || n_year < 3L) {
    stop("At least three ages and three years are required for derivatives.", call. = FALSE)
  }

  eta <- array(prediction$eta_draws, dim = c(n_age, n_year, n_draw))
  delta_year <- diff(years)
  velocity <- eta[, 2:n_year, , drop = FALSE] -
    eta[, 1:(n_year - 1L), , drop = FALSE]
  for (j in seq_along(delta_year)) {
    velocity[, j, ] <- velocity[, j, ] / delta_year[j]
  }

  acceleration <- velocity[, 2:(n_year - 1L), , drop = FALSE] -
    velocity[, 1:(n_year - 2L), , drop = FALSE]
  midpoint_gap <- (delta_year[2:(n_year - 1L)] + delta_year[1:(n_year - 2L)]) / 2
  for (j in seq_along(midpoint_gap)) {
    acceleration[, j, ] <- acceleration[, j, ] / midpoint_gap[j]
  }

  # [修改 M07 | 原版未单独计算年龄导数]
  # 不等距年龄网格使用三点局部二次插值导数，目标位置为中间年龄。
  age_gradient <- array(
    NA_real_,
    dim = c(n_age - 2L, n_year, n_draw)
  )
  for (i in 2:(n_age - 1L)) {
    left <- ages[i] - ages[i - 1L]
    right <- ages[i + 1L] - ages[i]
    # Derivative at the centre of the local quadratic interpolation. On an
    # unequal grid a two-neighbour secant is centred at the wrong age.
    age_gradient[i - 1L, , ] <-
      -right / (left * (left + right)) * eta[i - 1L, , ] +
      (right - left) / (left * right) * eta[i, , ] +
      left / (right * (left + right)) * eta[i + 1L, , ]
  }

  # [修改 M08 | 原版无等率移动公式；此处修正后续模块的时间对齐]
  # 区间速度对应整个区间；分母使用两端年龄梯度平均，而不是仅用末年梯度。
  midpoint_age_gradient <- (age_gradient[, 1:(n_year - 1L), , drop = FALSE] +
                              age_gradient[, 2:n_year, , drop = FALSE]) / 2
  iso_velocity <- -velocity[2:(n_age - 1L), , , drop = FALSE] /
    midpoint_age_gradient
  unstable <- !is.finite(iso_velocity) | abs(midpoint_age_gradient) < min_abs_age_gradient
  iso_velocity[unstable] <- NA_real_

  result <- structure(
    list(
      velocity = summarize_draw_array(
        velocity,
        ages,
        years[-1L],
        "Velocity"
      ),
      acceleration = summarize_draw_array(
        acceleration,
        ages,
        years[-c(1L, 2L)],
        "Acceleration"
      ),
      age_gradient = summarize_draw_array(
        age_gradient,
        ages[-c(1L, n_age)],
        years,
        "Age_Gradient"
      ),
      iso_risk_velocity = summarize_draw_array(
        iso_velocity,
        ages[-c(1L, n_age)],
        years[-1L],
        "Iso_Risk_Velocity"
      ),
      definition = list(
        velocity = "(eta(t_end)-eta(t_start))/(t_end-t_start); log-rate/calendar-year; Year is END label",
        acceleration = "2*(successive interval slopes difference)/(sum of interval widths); log-rate/calendar-year^2; local quadratic second derivative",
        age_gradient = "three-point local-quadratic first derivative at the central age; log-rate/year-of-age; boundary ages omitted",
        iso_risk_velocity = "negative interval log-rate slope / mean of age gradients at the two interval endpoints; year-of-age/calendar-year",
        iso_screen = paste0("Each draw with absolute denominator < ", min_abs_age_gradient,
                            " is omitted; summaries are conditional on retention, with effective fractions"),
        uncertainty = "Pointwise Gaussian coefficient-draw intervals, not simultaneous intervals or predictive intervals"
      )
    ),
    class = "blsd_fields"
  )
  starts <- rep(years[-n_year], each = n_age)
  ends <- rep(years[-1L], each = n_age)
  result$velocity$Interval_Start <- starts
  result$velocity$Interval_End <- ends
  result$velocity$Interval_Midpoint <- (starts + ends) / 2
  result$acceleration$Interval_Start <- rep(years[seq_len(n_year - 2L)], each = n_age)
  result$acceleration$Center_Year <- rep(years[2:(n_year - 1L)], each = n_age)
  result$acceleration$Interval_End <- rep(years[3:n_year], each = n_age)
  iso <- result$iso_risk_velocity
  iso$Interval_Start <- rep(years[-n_year], each = n_age - 2L)
  iso$Interval_End <- rep(years[-1L], each = n_age - 2L)
  iso$Interval_Midpoint <- (iso$Interval_Start + iso$Interval_End) / 2
  iso$Gradient_Year <- iso$Interval_Midpoint
  iso$Effective_Draw_N <- iso$Iso_Risk_Velocity_valid_n
  iso$Effective_Draw_Fraction <- iso$Iso_Risk_Velocity_valid_fraction
  result$iso_risk_velocity <- iso
  result
}

#' Finite-difference derivative of the coefficient design, wholly inside the
#' observed domain. Central three-point stencils are used in the interior;
#' forward/backward three-point first and four-point second stencils near edges.
#' Truncation is O(h^2) on a sufficiently smooth surface; the second derivative
#' can be O(h) at cubic-spline knots, where the third derivative jumps.
# [修改 M06、M14 | 原版 L87—92 用极小步长作单侧差分]
# 对预测设计矩阵求有限差分；内部用中心模板，近边界用域内单侧模板。
# 保留步长和样条结点限制，并处理结构性零附近的浮点尾差。
blsd_lpmatrix_derivative <- function(object, grid, variable, h, order = 1L) {
  validate_blsd_scalar(h, "finite-difference step", strict = TRUE)
  domain <- range(object$data[[variable]])
  if (!all(is.finite(domain)) || diff(domain) <= 0 || h > diff(domain) / 4) {
    stop("Derivative step must be at most one quarter of the observed axis range.", call. = FALSE)
  }
  if (!order %in% c(1L, 2L)) stop("Only first and second derivatives are supported.", call. = FALSE)
  x <- grid[[variable]]
  if (any(x < domain[1] | x > domain[2])) stop("Derivative grid is outside the observed domain.", call. = FALSE)
  method <- ifelse(x - h < domain[1], "forward", ifelse(x + h > domain[2], "backward", "central"))
  ans <- matrix(0, nrow(grid), length(stats::coef(object$model)))
  cancellation_scale <- numeric(nrow(grid))
  for (kind in unique(method)) {
    ix <- which(method == kind)
    nodes <- if (kind == "central") c(-1, 0, 1) else if (order == 1L) 0:2 else 0:3
    weights <- if (kind == "central") {
      if (order == 1L) c(-0.5, 0, 0.5) else c(1, -2, 1)
    } else if (order == 1L) c(-1.5, 2, -0.5) else c(2, -5, 4, -1)
    if (kind == "backward") {
      nodes <- -nodes
      if (order == 1L) weights <- -weights
    }
    for (j in seq_along(nodes)) {
      nd <- grid[ix, , drop = FALSE]
      nd[[variable]] <- x[ix] + nodes[j] * h
      nd$Pop <- 1
      xp <- stats::predict(object$model, nd, type = "lpmatrix")
      ans[ix, ] <- ans[ix, , drop = FALSE] + weights[j] * xp
      cancellation_scale[ix] <- cancellation_scale[ix] + abs(weights[j]) * apply(abs(xp), 1L, max)
    }
  }
  # A natural cubic spline has an exactly zero second derivative at its end
  # knots. Floating-point cancellation otherwise leaves tiny design rows whose
  # draw intervals can spuriously exclude zero. Zero an entire row only when
  # every coefficient derivative is indistinguishable from accumulation error.
  roundoff_tolerance <- 64 * .Machine$double.eps * cancellation_scale
  zeroed <- apply(abs(ans), 1L, max) <= roundoff_tolerance
  ans[zeroed, ] <- 0
  list(matrix = ans / h^order, method = method, domain = domain, step = h,
       roundoff_zeroed = zeroed, roundoff_tolerance = roundoff_tolerance / h^order)
}

#' Continuous log-rate derivatives aligned to the original four-figure concept.
#' This is a separate estimator from derive_blsd_fields(). It reuses the exact
#' coefficient draws that generated prediction, including their dependence.
# [修改 M06 | 原版 L85—96]
# 另计算同点的连续导数近似，并复用原预测的相同系数抽样；
# 连续偏导与年度区间差分是不同估计量，不能混用时间标签。
derive_blsd_continuous_fields <- function(
    object, prediction, h_age = 0.01, h_year = 0.01,
    min_abs_age_gradient = 0.005) {
  if (!inherits(object, "blsd_s")) stop("object must be returned by fit_blsd_s().", call. = FALSE)
  validate_blsd_prediction(prediction)
  validate_blsd_scalar(min_abs_age_gradient, "min_abs_age_gradient", strict = TRUE)
  beta <- prediction$coefficient_draws
  if (!is.matrix(beta) || !identical(dim(beta), c(length(stats::coef(object$model)), prediction$n_draws)) ||
      any(!is.finite(beta))) {
    stop("prediction must retain coefficient_draws; regenerate with predict_blsd_s() using the original fit and seed.", call. = FALSE)
  }
  grid <- prediction$grid
  nd <- grid
  nd$Pop <- 1
  reconstructed <- stats::predict(object$model, nd, type = "lpmatrix") %*% beta
  reconstruction_error <- max(abs(reconstructed - prediction$eta_draws))
  if (reconstruction_error > 1e-8 * max(1, max(abs(prediction$eta_draws)))) {
    stop("object and prediction coefficient draws do not reconstruct the same surface.", call. = FALSE)
  }
  dt <- blsd_lpmatrix_derivative(object, grid, "Year", h_year, 1L)
  dtt <- blsd_lpmatrix_derivative(object, grid, "Year", h_year, 2L)
  da <- blsd_lpmatrix_derivative(object, grid, "Age_Mid", h_age, 1L)
  velocity <- dt$matrix %*% beta
  acceleration <- dtt$matrix %*% beta
  age_gradient <- da$matrix %*% beta
  # [修改 M10 | 原版 L99—108 只有等死亡率线和视觉解读]
  # 新增局部等率年龄移动速度 -eta_t/eta_a（岁/日历年），不是绝对等效年龄。
  # 小分母按每次抽样屏蔽，区间需与保留比例一起阅读。
  iso <- -velocity / age_gradient
  iso[!is.finite(iso) | abs(age_gradient) < min_abs_age_gradient] <- NA_real_
  structure(list(
    velocity = summarize_draw_matrix(velocity, grid, "Velocity"),
    acceleration = summarize_draw_matrix(acceleration, grid, "Acceleration"),
    age_gradient = summarize_draw_matrix(age_gradient, grid, "Age_Gradient"),
    iso_risk_velocity = summarize_blsd_iso(iso, grid),
    draws = list(velocity = velocity, acceleration = acceleration,
                 age_gradient = age_gradient, iso_risk_velocity = iso),
    definition = list(
      velocity = "partial eta / partial calendar year at the displayed Year; log-rate/calendar-year",
      acceleration = "partial^2 eta / partial calendar year^2 at the displayed Year; log-rate/calendar-year^2",
      age_gradient = "partial eta / partial age at the displayed Age_Mid; log-rate/year-of-age",
      iso_risk_velocity = "-eta_t/eta_a at the same age and year; year-of-age/calendar-year; descriptive equal-risk movement",
      estimator = "Finite differences of the mgcv lpmatrix, multiplied by the same coefficient draws; distinct from interval divided differences",
      boundary = "In-domain one-sided stencils near boundaries; natural cubic spline second derivatives are constrained to zero at endpoints, not empirical evidence of no acceleration",
      truncation = "Nominal O(h^2) on smooth polynomial pieces; second derivatives can have O(h) error at cubic-spline knots; report step sensitivity",
      roundoff = "Entire derivative-design rows below a conservative machine-precision accumulation bound are zeroed to prevent spurious sign certainty at structural zeros",
      iso_screen = paste0("Omit each draw if |eta_a| < ", min_abs_age_gradient,
                          "; intervals/probabilities condition on retained draws; inspect Effective_Draw_Fraction"),
      uncertainty = "Pointwise Gaussian coefficient-draw intervals, not simultaneous intervals or predictive intervals"
    ),
    diagnostics = list(h_age = h_age, h_year = h_year,
      coefficient_surface_reconstruction_error = reconstruction_error,
      roundoff_rule = "Zero whole derivative-design row only if max(abs(weighted lpmatrix sum)) <= 64 * machine epsilon * sum(abs(stencil weight) * max(abs(lpmatrix row))); tolerance is scaled by h^order",
      stencil = data.frame(grid, Age_Method = da$method, Year_Method = dt$method,
        Velocity_Roundoff_Zeroed = dt$roundoff_zeroed,
        Acceleration_Roundoff_Zeroed = dtt$roundoff_zeroed,
        Age_Gradient_Roundoff_Zeroed = da$roundoff_zeroed,
        Acceleration_Roundoff_Tolerance = dtt$roundoff_tolerance),
      age_domain = da$domain, year_domain = dt$domain,
      core_version = blsd_core_version)
  ), class = c("blsd_continuous_fields", "blsd_fields"))
}



# ------------------------------------------------------------
# 3.2 完整绘图代码：原四图对应功能与新增图，共九组PNG/PDF
# 原p1→图01；原p2→图02，并增加真正的加速度图03；
# 原p3→图04计数残差诊断；原p4→图05准确年份年龄截面。
# ------------------------------------------------------------

# Publication-oriented figures for the self-contained BLSD-S demonstration.
# Labels are English and use the platform's default sans font. No font or
# graphics packages are installed by this script.

make_blsd_demo_figures <- function(
    data, fit, prediction, discrete_fields, continuous_fields,
    transformed, output_dir) {
  for (package in c("ggplot2", "gridExtra")) {
    if (!requireNamespace(package, quietly = TRUE)) {
      stop("Install the required plotting package: ", package, call. = FALSE)
    }
  }
  validate_blsd_prediction(prediction)
  if (!inherits(fit, "blsd_s")) {
    stop("fit must be a BLSD-S model object.", call. = FALSE)
  }
  if (!all(c("age_gradient_percent", "velocity_percent") %in% names(transformed))) {
    stop("transformed must contain age_gradient_percent and velocity_percent.", call. = FALSE)
  }
  figure_dir <- file.path(output_dir, "figures")
  table_dir <- file.path(output_dir, "tables")
  dir.create(figure_dir, recursive = TRUE, showWarnings = FALSE)
  dir.create(table_dir, recursive = TRUE, showWarnings = FALSE)
  manifest <- list()
  interval_note <- "Ribbons: approximate 95% pointwise coefficient-draw intervals."
  iso_note <- "Grey: fewer than 95% of draws retained after screening small age gradients."

  theme_blsd <- function() {
    ggplot2::theme_minimal(base_size = 11, base_family = "sans") +
      ggplot2::theme(
        panel.grid.minor = ggplot2::element_blank(),
        plot.title = ggplot2::element_text(face = "bold", size = 13),
        plot.subtitle = ggplot2::element_text(size = 9),
        plot.caption = ggplot2::element_text(size = 8, hjust = 0),
        legend.title = ggplot2::element_text(size = 9),
        legend.text = ggplot2::element_text(size = 8),
        strip.text = ggplot2::element_text(face = "bold"),
        plot.margin = ggplot2::margin(8, 8, 8, 8)
      )
  }
  symmetric_limit <- function(x) {
    x <- x[is.finite(x)]
    if (!length(x)) return(1)
    answer <- max(abs(x))
    if (answer == 0) 1 else answer
  }
  cell_bounds <- function(x) {
    values <- sort(unique(x))
    boundaries <- if (length(values) == 1L) {
      c(values - 0.5, values + 0.5)
    } else {
      c(values[1L] - diff(values)[1L] / 2,
        (values[-1L] + values[-length(values)]) / 2,
        values[length(values)] + tail(diff(values), 1L) / 2)
    }
    index <- match(x, values)
    list(lower = boundaries[index], upper = boundaries[index + 1L])
  }
  tiles <- function(x) {
    # [修改 M14 | 微信原版 L101–103、L115–116] 原版直接 geom_tile()。
    # 现按相邻节点中点构造格子边界，使非等距年龄/年份网格也能连续铺满，
    # 避免追加范围端点后出现间隙或重叠；颜色对应的统计量不因此改变。
    period_bounds <- cell_bounds(x$Year)
    age_bounds <- cell_bounds(x$Age_Mid)
    x$.X_Min <- period_bounds$lower
    x$.X_Max <- period_bounds$upper
    x$.Y_Min <- age_bounds$lower
    x$.Y_Max <- age_bounds$upper
    x
  }
  heatmap <- function(x, value, title, legend, subtitle = NULL,
                      diverging = TRUE, limits = NULL, fill_transform = "identity") {
    x <- tiles(x)
    p <- ggplot2::ggplot(x, ggplot2::aes(x = Year, y = Age_Mid)) +
      ggplot2::geom_rect(ggplot2::aes(
        fill = .data[[value]], xmin = .X_Min, xmax = .X_Max,
        ymin = .Y_Min, ymax = .Y_Max)) +
      ggplot2::coord_cartesian(xlim = range(x$Year), ylim = range(x$Age_Mid),
                               expand = FALSE) +
      ggplot2::labs(title = title, subtitle = subtitle, x = "Calendar year",
                    y = "Age (years)", fill = legend) + theme_blsd()
    if (diverging) {
      if (is.null(limits)) {
        bound <- symmetric_limit(x[[value]])
        limits <- c(-bound, bound)
      }
      p <- p + ggplot2::scale_fill_gradient2(
        low = "#2166AC", mid = "#F7F7F7", high = "#B2182B",
        midpoint = 0, limits = limits, na.value = "grey75")
    } else {
      p <- p + ggplot2::scale_fill_viridis_c(
        option = "C", na.value = "grey75", limits = limits, trans = fill_transform)
    }
    p
  }
  combined <- function(plots, title, caption, ncol = 2L) {
    gridExtra::arrangeGrob(
      grobs = plots, ncol = ncol,
      top = grid::textGrob(title, gp = grid::gpar(fontface = "bold", fontsize = 14)),
      bottom = grid::textGrob(caption, gp = grid::gpar(fontsize = 8))
    )
  }
  save_figure <- function(number, slug, plot, title, note,
                          width = 11, height = 7) {
    base <- sprintf("fig%02d_%s", number, slug)
    ggplot2::ggsave(file.path(figure_dir, paste0(base, ".png")), plot = plot,
                    width = width, height = height, units = "in", dpi = 300,
                    bg = "white")
    ggplot2::ggsave(file.path(figure_dir, paste0(base, ".pdf")), plot = plot,
                    width = width, height = height, units = "in",
                    device = grDevices::pdf, useDingbats = FALSE, bg = "white")
    manifest[[length(manifest) + 1L]] <<- data.frame(
      Figure = number, Title = title,
      PNG = file.path("figures", paste0(base, ".png")),
      PDF = file.path("figures", paste0(base, ".pdf")),
      Interpretation = note, stringsAsFactors = FALSE
    )
  }

  # Reorder fitted values and count residuals to the supplied observation rows.
  key <- function(x) paste(x$Age_Mid, x$Year, sep = "|")
  fitted_rows <- match(key(data), key(fit$data))
  if (anyNA(fitted_rows) || nrow(data) != nrow(fit$data)) {
    stop("data must contain the same observation cells as fit$data.", call. = FALSE)
  }
  observed <- data
  observed$Fitted_Deaths <- as.numeric(stats::fitted(fit$model))[fitted_rows]
  observed$Deviance_Residual <- as.numeric(stats::residuals(
    fit$model, type = "deviance"))[fitted_rows]
  observed$Pearson_Residual <- as.numeric(stats::residuals(
    fit$model, type = "pearson"))[fitted_rows]
  observed$Observed_Rate <- observed$Deaths / observed$Pop * prediction$rate_scale
  observed$Cohort <- observed$Year - observed$Age_Mid
  rates <- prediction$rate_summary
  age_percent <- transformed$age_gradient_percent
  year_percent <- transformed$velocity_percent
  iso <- continuous_fields$iso_risk_velocity
  retained <- if ("Effective_Draw_Fraction" %in% names(iso)) {
    iso$Effective_Draw_Fraction
  } else iso$Iso_Risk_Velocity_valid_fraction
  iso$Reliable_Retention <- is.finite(retained) & retained >= 0.95
  iso$Displayed_Iso <- iso$Iso_Risk_Velocity
  iso$Displayed_Iso[!iso$Reliable_Retention] <- NA_real_

  # [修改 M05 | 微信原版 L77–83、L99–108] 保留率曲面与等死亡率线，
  # 使用已去除人口偏置项的率抽样均值，图例明确为每10万人死亡数。
  # 预测网格的范围检查在 predict_blsd_s() 中完成；颜色用对数刻度，
  # 不再把等率线位移直接称为“生理衰老推迟”。
  # 01: Rates and equal-rate contours. Colour encodes a rate, not evidence.
  p <- heatmap(rates, "Rate", "Fitted mortality surface", "Deaths per 100,000",
               "Coefficient-draw mean rate; white contours mark equal fitted rates.",
               diverging = FALSE, fill_transform = "log10") +
    ggplot2::geom_contour(ggplot2::aes(z = log10(Rate)), bins = 12,
                          colour = "white", linewidth = 0.35, alpha = 0.65)
  save_figure(1, "mortality_surface", p, "Fitted mortality surface",
               "Rate per 100,000; logarithmic colour scale; equal-rate contours.")

  # [修改 M09 | 微信原版 L85–92、L115–120；原版未输出百分比图]
  # 将每次时间导数抽样换算为 100*(exp(导数)-1)，再汇总为百分比，
  # 避免读者自行换算。它是局部一年变化近似，颜色并不表示区间排除零。
  # 02: Transform every derivative draw before summarizing (done by the runner).
  p <- heatmap(year_percent, "Annual_Change_Pct", "Local annual mortality change",
               "Relative change (%)",
               "100 * (exp(partial log-rate / partial year) - 1), summarized draw by draw.") +
    ggplot2::labs(caption = "Local one-calendar-year approximation. Colours show the mean, not interval exclusion of zero.")
  save_figure(2, "annual_change_percent", p, "Local annual mortality change",
               "Derivative-based local one-calendar-year relative change; draw-wise transformation.")

  # [修改 M06 | 微信原版 L85–96、L112–120] 原版计算的 Accel_Time
  # 未正确除以时间间隔，原图2实际画一阶 Deriv_Time。现图2与图3分开
  # 展示速度和二阶时间导数，并注明自然三次样条端点二阶导数为零的约束。
  # 03: This remains a log-rate second derivative, not a percent acceleration.
  p <- heatmap(continuous_fields$acceleration, "Acceleration",
               "Temporal acceleration of log mortality", "Log-rate / year^2",
               "Positive values: increasing time slope; negative values: decreasing time slope.") +
    ggplot2::labs(caption = "Natural cubic spline endpoint acceleration is constrained to zero; it is not an empirical finding.")
  save_figure(3, "log_rate_acceleration", p, "Temporal log-rate acceleration",
               "Second period derivative; natural cubic endpoint constraints apply.")

  # [修改 M11 | 微信原版 L128–139] 保留按出生队列查看计数偏差残差的图，
  # 用于发现拟合不足。移除“世代自带高风险印记”的归因，LOESS曲线只作
  # 描述性诊断；该图仍使用观测计数残差，并非新增队列效应模型。
  # 04: Count residuals by cohort are a diagnostic, not a cohort-effect estimate.
  p <- ggplot2::ggplot(observed, ggplot2::aes(x = Cohort, y = Deviance_Residual)) +
    ggplot2::geom_hline(yintercept = 0, colour = "grey40", linewidth = 0.4) +
    ggplot2::geom_point(ggplot2::aes(colour = Age_Mid), alpha = 0.65, size = 1.5) +
    ggplot2::geom_smooth(method = "loess", formula = y ~ x, span = 0.6,
                          se = FALSE, colour = "black", linewidth = 0.8) +
    ggplot2::scale_colour_viridis_c(name = "Age") +
    ggplot2::labs(title = "Count residuals viewed by birth cohort",
                  subtitle = "Exploratory lack-of-fit diagnostic; the black LOESS curve is not an estimated cohort effect.",
                  x = "Approximate birth year (period - age midpoint)",
                  y = "Count deviance residual") + theme_blsd()
  save_figure(4, "count_residuals_by_cohort", p, "Count residuals by cohort",
               "Descriptive count-model diagnostic; no causal cohort interpretation.")

  # [修改 M12 | 微信原版 L146–150] 原版 round(Year) 会将多个相邻
  # 预测年份归为同一年。现只提取准确的1990、2005、2019年，叠加
  # 观测率与逐点区间；零观测率只从对数坐标图中省略，仍保留在数据中。
  # 05: The three reference years reproduce the original example's comparison.
  profile_years <- c(1990, 2005, 2019)
  if (!all(profile_years %in% prediction$years)) {
    profile_years <- unique(prediction$years[c(1L, ceiling(length(prediction$years) / 2),
                                             length(prediction$years))])
  }
  profile <- rates[rates$Year %in% profile_years, ]
  profile$Period <- factor(profile$Year, levels = profile_years)
  profile_observed <- observed[observed$Year %in% profile_years & observed$Observed_Rate > 0, ]
  profile_observed$Period <- factor(profile_observed$Year, levels = profile_years)
  p <- ggplot2::ggplot(profile, ggplot2::aes(x = Age_Mid, y = Rate,
                                           colour = Period, fill = Period)) +
    ggplot2::geom_ribbon(ggplot2::aes(ymin = Rate_lower, ymax = Rate_upper),
                          alpha = 0.12, colour = NA) +
    ggplot2::geom_line(linewidth = 0.8) +
    ggplot2::geom_point(data = profile_observed,
                         ggplot2::aes(y = Observed_Rate), size = 1.6) +
    ggplot2::scale_y_log10() +
    ggplot2::labs(title = "Age profiles in selected calendar years",
                  subtitle = interval_note, x = "Age (years)",
                  y = "Deaths per 100,000 (log scale)",
                  caption = "Points: observed rates; zero observed rates omitted from this logarithmic panel.") + theme_blsd()
  save_figure(5, "age_profiles", p, "Selected-year age profiles",
               paste("Years:", paste(profile_years, collapse = ", "),
                     "; pointwise intervals; observed zeros excluded only from this log-scale panel."))

  # [修改 M13 | 微信原版无此输出] 新增指定观测年龄的时间趋势图，
  # 同时展示观测率和系数抽样的95%逐点区间，检查拟合与不确定性。
  # 选实际观测年龄中点，避免把插值年龄重新贴成整数年龄标签。
  # 06: Observation ages are used, rather than relabelling interpolated ages.
  observation_ages <- sort(unique(observed$Age_Mid))
  targets <- c(7.5, 22.5, 42.5, 62.5, 82.5, 90)
  trend_ages <- unique(vapply(targets, function(x) {
    observation_ages[which.min(abs(observation_ages - x))]
  }, numeric(1)))
  if (!all(trend_ages %in% prediction$ages)) {
    stop("prediction$ages must include selected observed age midpoints for time-trend figures.", call. = FALSE)
  }
  trends <- rates[rates$Age_Mid %in% trend_ages, ]
  trend_observed <- observed[observed$Age_Mid %in% trend_ages, ]
  facet_levels <- paste0("Age ", sort(trend_ages))
  trends$Age_Panel <- factor(paste0("Age ", trends$Age_Mid), levels = facet_levels)
  trend_observed$Age_Panel <- factor(paste0("Age ", trend_observed$Age_Mid), levels = facet_levels)
  p <- ggplot2::ggplot(trends, ggplot2::aes(x = Year, y = Rate)) +
    ggplot2::geom_ribbon(ggplot2::aes(ymin = Rate_lower, ymax = Rate_upper),
                          fill = "#2C7FB8", alpha = 0.2) +
    ggplot2::geom_line(colour = "#2166AC", linewidth = 0.8) +
    ggplot2::geom_point(data = trend_observed, ggplot2::aes(y = Observed_Rate),
                         colour = "#333333", size = 1.4, alpha = 0.7) +
    ggplot2::facet_wrap(~Age_Panel, scales = "free_y", ncol = 3) +
    ggplot2::labs(title = "Mortality trends at selected observed ages",
                  subtitle = interval_note, x = "Calendar year", y = "Deaths per 100,000",
                  caption = "Points: observed rates. Each age panel has its own vertical scale.") + theme_blsd()
  save_figure(6, "selected_age_trends", p, "Selected-age time trends",
               "Pointwise coefficient intervals and observed rates; panel-specific vertical scales.",
               width = 12, height = 8)

  # [修改 M09/M10 | 微信原版 L99–108；原版只有等死亡率线]
  # 新增同一年横断面年龄导数，并以100*(exp(导数)-1)的百分比展示；
  # 同时新增 -时间导数/年龄导数，量化等死亡率年龄移动速度（岁/年）。
  # 小年龄梯度筛除后保留抽样不足95%的格点显示为灰色，避免不稳定比值。
  # 07: The age derivative is shown as percent, and iso movement as years/year.
  p_age <- heatmap(age_percent, "Age_Change_Pct", "A. Local age-associated relative change",
                   "Relative change (%)", "One additional age-year at the same calendar year.")
  p_iso <- heatmap(iso, "Displayed_Iso", "B. Equal-mortality age-shift velocity",
                   "Age-years / calendar-year", "Positive: equal mortality moves to older ages.")
  p <- combined(list(p_age, p_iso), "Age gradient and equal-mortality movement",
                 paste("Age percent is a local one-age-year approximation.", iso_note))
  save_figure(7, "age_percent_and_iso_velocity", p,
               "Age gradient (%) and equal-mortality age movement",
               "Age derivative transformed draw by draw; local approximation; iso retention <95% grey.",
               width = 14, height = 6)

  # [修改 M13 | 微信原版无此输出] 新增区间方向图，区分均值颜色和
  # 95%区间是否跨零；这些是逐点区间，不是同时置信带或多重检验校正。
  # 08: Direction categories use pointwise quantiles, not the colour of a mean.
  direction <- function(x, value, valid = rep(TRUE, nrow(x))) {
    lower <- x[[paste0(value, "_lower")]]
    upper <- x[[paste0(value, "_upper")]]
    category <- rep("Interval includes zero", nrow(x))
    category[is.finite(lower) & lower > 0] <- "Positive interval"
    category[is.finite(upper) & upper < 0] <- "Negative interval"
    category[!valid | !is.finite(lower) | !is.finite(upper)] <- "Unavailable / low retention"
    x$Direction <- factor(category, levels = c("Negative interval", "Interval includes zero",
                                               "Positive interval", "Unavailable / low retention"))
    tiles(x)
  }
  direction_map <- function(x, title) {
    ggplot2::ggplot(x, ggplot2::aes(x = Year, y = Age_Mid)) +
      ggplot2::geom_rect(ggplot2::aes(fill = Direction,
                                     xmin = .X_Min, xmax = .X_Max,
                                     ymin = .Y_Min, ymax = .Y_Max)) +
      ggplot2::scale_fill_manual(values = c("#2166AC", "#F7F7F7", "#B2182B", "grey70"),
                                  drop = FALSE, name = "95% pointwise interval") +
      ggplot2::coord_cartesian(xlim = range(x$Year), ylim = range(x$Age_Mid), expand = FALSE) +
      ggplot2::labs(title = title, x = "Calendar year", y = "Age (years)") + theme_blsd()
  }
  p <- combined(list(
    direction_map(direction(age_percent, "Age_Change_Pct"), "A. Age-associated relative change"),
    direction_map(direction(iso, "Iso_Risk_Velocity", iso$Reliable_Retention),
                    "B. Equal-mortality age-shift velocity")),
    "Pointwise interval direction summaries",
    "Pointwise intervals are not simultaneous bands or a multiple-comparison procedure; screened iso intervals condition on retained draws.")
  save_figure(8, "pointwise_direction", p, "Pointwise interval direction summaries",
               "Categories reflect 95% pointwise intervals, not multiplicity-adjusted evidence.",
               width = 14, height = 6)

  # [修改 M13 | 微信原版 L129及无此组合图] 扩展计数诊断，新增
  # 实际死亡数与拟合值对照、残差对拟合值图。按年龄/年份键对应原观测，
  # 不把插值网格当新观测，也不把样本内诊断称为独立预测验证。
  # 09: Diagnostics operate on observed counts and their actual exposures.
  p_counts <- ggplot2::ggplot(observed, ggplot2::aes(x = Fitted_Deaths, y = Deaths)) +
    ggplot2::geom_abline(intercept = 0, slope = 1, colour = "grey40", linetype = 2) +
    ggplot2::geom_point(ggplot2::aes(colour = Age_Mid), alpha = 0.65, size = 1.5) +
    ggplot2::scale_colour_viridis_c(name = "Age") +
    ggplot2::scale_x_sqrt() + ggplot2::scale_y_sqrt() +
    ggplot2::labs(title = "A. Observed versus fitted counts", x = "Fitted deaths (square-root scale)",
                  y = "Observed deaths (square-root scale)") + theme_blsd()
  p_residual <- ggplot2::ggplot(observed, ggplot2::aes(x = Fitted_Deaths, y = Deviance_Residual)) +
    ggplot2::geom_hline(yintercept = 0, colour = "grey40", linewidth = 0.4) +
    ggplot2::geom_point(ggplot2::aes(colour = Age_Mid), alpha = 0.65, size = 1.5) +
    ggplot2::scale_colour_viridis_c(name = "Age") + ggplot2::scale_x_sqrt() +
    ggplot2::labs(title = "B. Deviance residuals", x = "Fitted deaths (square-root scale)",
                  y = "Count deviance residual") + theme_blsd()
  p <- combined(list(p_counts, p_residual), "Observed-count model diagnostics",
                 "These are in-sample model diagnostics, not held-out validation.")
  save_figure(9, "count_fit_diagnostics", p, "Observed-count fit diagnostics",
               "Observed/fitted counts and count deviance residuals; in-sample diagnostics.",
               width = 14, height = 6)

  utils::write.csv(observed[c("Age_Mid", "Year", "Deaths", "Pop", "Fitted_Deaths",
                              "Deviance_Residual", "Pearson_Residual", "Observed_Rate", "Cohort")],
                    file.path(table_dir, "count_fit_diagnostics.csv"), row.names = FALSE)
  result <- do.call(rbind, manifest)
  rownames(result) <- NULL
  utils::write.csv(result, file.path(table_dir, "figure_manifest.csv"), row.names = FALSE)
  result
}


# ============================================================
# 4. 输出展示与结果保存（对照微信原版L159—166）
# [修改 M01] 统一执行以上本文件内的函数，写出九组图与17张表。
# ============================================================

run_blsd_demo <- function(root, args = character()) {
  settings <- parse_blsd_demo_args(args)
  if (settings$help) {
    cat("BLSD simulated example\n",
        "Rscript BLSD_Model_Analysis.R [--draws=1000] [--seed=123]",
        " [--age-step=1] [--output=outputs/demo]\n", sep = "")
    return(invisible(NULL))
  }
  dependencies <- c("mgcv", "ggplot2", "gridExtra")
  missing <- dependencies[!vapply(dependencies, requireNamespace,
                                  logical(1), quietly = TRUE)]
  if (length(missing)) {
    stop("Missing packages: ", paste(missing, collapse = ", "),
         ". Install mgcv, ggplot2 and gridExtra before running this file.", call. = FALSE)
  }
  output_dir <- settings$output
  if (!grepl("^([A-Za-z]:[/\\\\]|/|\\\\\\\\)", output_dir)) {
    output_dir <- file.path(root, output_dir)
  }
  dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
  dir.create(file.path(output_dir, "tables"), recursive = TRUE, showWarnings = FALSE)
  dir.create(file.path(output_dir, "figures"), recursive = TRUE, showWarnings = FALSE)
  output_dir <- normalizePath(output_dir, winslash = "/", mustWork = TRUE)
  csv <- function(x, name) {
    write.csv(x, file.path(output_dir, "tables", paste0(name, ".csv")),
              row.names = FALSE, na = "", fileEncoding = "UTF-8")
  }

  # [保留 M02 | 微信原版 L14—53] 生成公式与随机数顺序保持一致。
  cat("[1/6] Reproducing the original simulated data...\n")
  data <- simulate_wechat_example(settings$seed)
  csv(data, "simulated_data")
  # [修改 M03 | 微信原版 L66—68] 准 Poisson 改为负二项，平滑参数采用 REML。
  cat("[2/6] Fitting the negative-binomial age-period surface...\n")
  fit <- fit_blsd_s(data, k_age = 10L, k_period = 10L, family = "nb")
  ages <- sort(unique(c(seq(min(data$Age_Mid), max(data$Age_Mid),
                            by = settings$age_step), data$Age_Mid)))
  # [修改 M04、M05 | 微信原版 L77—83] 域内网格与同一组相关系数抽样。
  prediction <- predict_blsd_s(fit, ages = ages, years = 1990:2019,
                               n_draws = settings$draws, seed = settings$seed)
  # [修改 M06—M08、M10 | 微信原版 L85—108]
  # 按年龄/抽样正确计算导数；区间与连续指标分别保存，并增加等率移动速度。
  cat("[3/6] Deriving interval and continuous fields...\n")
  discrete_fields <- derive_blsd_fields(prediction, min_abs_age_gradient = 0.005)
  continuous_fields <- derive_blsd_continuous_fields(
    fit, prediction, h_age = 0.01, h_year = 0.01,
    min_abs_age_gradient = 0.005
  )
  # [修改 M09 | 微信原版没有年龄梯度百分比或动态量抽样汇总]
  # 先对每次抽样作 100 * expm1，再汇总；先平均再换算通常得到不同结果。
  # 图中标明局部一岁/一年的近似，严格有限变化应另比较两点的完整死亡率。
  transformed <- list(
    age_gradient_percent = summarize_draw_matrix(
      100 * expm1(continuous_fields$draws$age_gradient),
      prediction$grid, "Age_Change_Pct"),
    velocity_percent = summarize_draw_matrix(
      100 * expm1(continuous_fields$draws$velocity),
      prediction$grid, "Annual_Change_Pct")
  )
  cat("[4/6] Exporting surface and dynamic summaries...\n")
  csv(prediction$rate_summary, "surface")
  for (name in c("velocity", "acceleration", "age_gradient", "iso_risk_velocity")) {
    csv(discrete_fields[[name]], paste0("interval_", name))
    csv(continuous_fields[[name]], paste0("continuous_", name))
  }
  csv(transformed$age_gradient_percent, "age_gradient_percent")
  csv(transformed$velocity_percent, "velocity_percent")
  csv(continuous_fields$diagnostics$stencil, "derivative_stencils")
  fitted_counts <- stats::fitted(fit$model)
  count_diagnostics <- data
  count_diagnostics$Fitted_Deaths <- fitted_counts
  count_diagnostics$Fitted_Rate <- fitted_counts / data$Pop * 100000
  count_diagnostics$Pearson_Residual <- stats::residuals(fit$model, type = "pearson")
  count_diagnostics$Deviance_Residual <- stats::residuals(fit$model, type = "deviance")
  # [修改 M11 | 微信原版 L128—139]
  # 出生队列坐标只用于查看观测计数残差，不把残差平滑当作世代效应。
  count_diagnostics$Cohort <- data$Year - data$Age_Mid
  csv(count_diagnostics, "count_diagnostics")

  metrics <- data.frame(
    Metric = c("Observed_Cells", "Prediction_Cells", "Draws", "Data_Seed",
               "Coefficient_Seed", "NB_Theta", "Smooth_EDF",
               "Coefficient_Surface_Reconstruction_Error",
               "Min_Iso_Effective_Draw_Fraction"),
    Value = c(nrow(data), nrow(prediction$grid), prediction$n_draws,
              settings$seed, settings$seed, fit$model$family$getTheta(TRUE),
              sum(fit$model$edf),
              continuous_fields$diagnostics$coefficient_surface_reconstruction_error,
              min(continuous_fields$iso_risk_velocity$Effective_Draw_Fraction))
  )
  csv(metrics, "summary_metrics")
  capture.output(summary(fit$model),
                 file = file.path(output_dir, "tables", "model_summary.txt"))
  capture.output(mgcv::concurvity(fit$model, full = TRUE),
                 file = file.path(output_dir, "tables", "concurvity.txt"))

  cat("[5/6] Rendering the figure collection...\n")
  figure_manifest <- make_blsd_demo_figures(
    data, fit, prediction, discrete_fields, continuous_fields,
    transformed, output_dir
  )
  csv(figure_manifest, "figure_manifest")
  cat("[6/6] Saving reproducible results and session information...\n")
  result <- list(
    data = data, fit = fit, prediction = prediction,
    discrete_fields = discrete_fields,
    continuous_fields = continuous_fields,
    transformed = transformed,
    settings = settings, figure_manifest = figure_manifest
  )
  saveRDS(result, file.path(output_dir, "demo_result.rds"), compress = "gzip")
  capture.output(sessionInfo(), file = file.path(output_dir, "tables", "session_info.txt"))
  cat("Completed: ", nrow(figure_manifest), " figures (PNG and PDF)\n",
      "Output directory: ", output_dir, "\n", sep = "")
  invisible(result)
}


# [修改 M01] source()与Rscript默认均运行完整分析；测试可关闭自动运行。
if (isTRUE(getOption("blsd.run_demo", TRUE))) {
  blsd_demo_result <- run_blsd_demo(
    root = blsd_script_directory,
    args = commandArgs(trailingOnly = TRUE)
  )
}
