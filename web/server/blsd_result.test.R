# Real numerical contract checks for the web adapter and retained-data plots.
script_arg <- grep("^--file=", commandArgs(), value = TRUE)[1]
server_dir <- dirname(normalizePath(sub("^--file=", "", script_arg), mustWork = TRUE))
source(file.path(server_dir, "blsd_adapter.R"))
source(file.path(server_dir, "blsd_export.R"))
out <- file.path(server_dir, "qa", "eight-chart-contract-20261013")
dir.create(out, recursive = TRUE, showWarnings = FALSE)
near <- function(actual, expected, label) {
  if (!isTRUE(all.equal(actual, expected, tolerance = 1e-10, check.attributes = FALSE))) stop(label)
}
data <- expand.grid(Year = 2000:2007, Age_Mid = seq(32.5, 72.5, by = 5))
data$Pop <- 180000 + 7000 * (data$Age_Mid - 32.5) / 5
data$Deaths <- round(data$Pop * exp(-8 + 0.065 * (data$Age_Mid - 32.5) - 0.02 * (data$Year - 2000)) *
  (1 + 0.11 * sin((data$Year - 2000) * 1.8 + (data$Age_Mid - 32.5) / 5 * 1.2))) + 0.25
data$Sex <- "Both"
checks <- character()
for (method in c("quasi-gcv", "quasi-reml", "nb-reml")) {
  settings <- list(method = method, draws = 120L, seed = 123L, kAge = 4L, kYear = 4L, threshold = 0.005)
  result <- fit_blsd_web(list(rows = data, settings = settings,
    gridOptions = list(maxAgePoints = 20L, maxYearPoints = 8L),
    provenance = list(source = "FRACTIONAL_COUNT_EXPOSURE_CONTRACT_FIXTURE", sex = "Both")))
  snapshot <- attr(result, "reproducibility")
  attr(result, "reproducibility") <- NULL
  stopifnot(all(unique(data$Age_Mid) %in% result$grid$ages), all(unique(data$Year) %in% result$grid$years),
    identical(result$input, data[c("Year", "Age_Mid", "Deaths", "Pop", "Sex")]), identical(result$meta$sex, "Both"), result$diagnostics$nonIntegerDeaths,
    result$meta$adapterVersion == "2.0.0", nrow(snapshot$betaDraws) == length(coef(snapshot$fittedModel)),
    ncol(snapshot$betaDraws) == settings$draws, length(result$residuals) == nrow(data),
    length(result$contours$surface) > 0L, length(result$contours$annual) > 0L)
  X <- predict(snapshot$fittedModel, newdata = snapshot$predictionGrid, type = "lpmatrix")
  eta <- drop(X %*% coef(snapshot$fittedModel)) + log(100000)
  eta_draws <- X %*% snapshot$betaDraws + log(100000)
  Dt <- blsd_derivative(snapshot$fittedModel, snapshot$predictionGrid, "Year", range(result$grid$years), result$diagnostics$hYear)
  Da <- blsd_derivative(snapshot$fittedModel, snapshot$predictionGrid, "Age_Mid", range(result$grid$ages), result$diagnostics$hAge)
  Dtt <- blsd_derivative(snapshot$fittedModel, snapshot$predictionGrid, "Year", range(result$grid$years), result$diagnostics$hYear, 2L)
  temporal <- drop(Dt %*% coef(snapshot$fittedModel))
  gradient <- drop(Da %*% coef(snapshot$fittedModel))
  temporal_draws <- Dt %*% snapshot$betaDraws
  gradient_draws <- Da %*% snapshot$betaDraws
  derivative_centers <- list(annual = 100 * expm1(temporal), gradient = 100 * expm1(gradient),
    acceleration = drop(Dtt %*% coef(snapshot$fittedModel)), shift = -temporal / gradient)
  derivative_draws <- list(annual = 100 * expm1(temporal_draws), gradient = 100 * expm1(gradient_draws),
    acceleration = Dtt %*% snapshot$betaDraws, shift = -temporal_draws / gradient_draws)
  near(vapply(result$points, function(p) p$surface, numeric(1)), eta, "Surface centers differ from fitted coefficient substitution")
  near(vapply(result$points, function(p) p$rate, numeric(1)), exp(eta), "Rate centers differ from fitted coefficient substitution")
  for (i in seq_along(result$points)) {
    p <- result$points[[i]]
    near(p$intervals$surface, unname(quantile(eta_draws[i, ], c(.025, .975))), "Log-rate intervals differ from retained draws")
    near(p$intervals$rate, unname(quantile(exp(eta_draws[i, ]), c(.025, .975))), "Rate intervals differ from retained draws")
    for (metric in names(derivative_centers)) {
      near(p$raw[[metric]], derivative_centers[[metric]][i], paste(metric, "raw center differs from coefficient substitution"))
      near(p$rawIntervals[[metric]], unname(quantile(derivative_draws[[metric]][i, ], c(.025, .975))),
        paste(metric, "raw interval differs from retained draws"))
    }
    stopifnot(identical(p$raw$surface, p$surface), identical(p$raw$rate, p$rate))
    if (p$year %in% range(result$grid$years)) {
      stopifnot(is.null(p$acceleration), is.null(p$intervals$acceleration),
        is.finite(p$raw$acceleration), length(p$rawIntervals$acceleration) == 2L,
        p$metricMasks$acceleration, p$metricMaskReasons$acceleration == "NATURAL_SPLINE_BOUNDARY")
    }
    gradient_ci <- p$rawDerivatives$intervals$logGradient
    stable <- (p$logGradient > settings$threshold && gradient_ci[1] > settings$threshold) ||
      (p$logGradient < -settings$threshold && gradient_ci[2] < -settings$threshold)
    stable <- stable && p$metricValidFractions$shift == 1 && !is.null(p$raw$shift)
    stopifnot(identical(p$masked, !stable))
    if (!stable) stopifnot(is.null(p$shift), is.null(p$intervals$shift))
    else near(p$shift, -p$logAnnual / p$logGradient, "Shift center differs from coefficient ratio")
  }
  near(vapply(result$residuals, function(p) p$devianceResidual, numeric(1)),
    unname(residuals(snapshot$fittedModel, type = "deviance")), "Residuals differ from retained model")
  for (metric in c("ageSections", "timeTrends")) for (row in result[[metric]]$points) {
    matched <- Filter(function(p) p$year == row$year && p$age == row$age, result$points)[[1]]
    near(row$rate, matched$rate, "Curve center differs from complete grid")
    near(row$intervals$rate, matched$intervals$rate, "Curve interval differs from complete grid")
  }
  snapshot$result <- result
  saveRDS(snapshot, file.path(out, paste0(method, ".rds")))
  jsonlite::write_json(result, file.path(out, paste0(method, ".json")), auto_unbox = TRUE, null = "null", na = "null", digits = 15)
  checks <- c(checks, paste(method, "coefficient centers, retained-draw intervals, exact coordinates, residuals, curves, raw values and masks: PASS"))
  if (method == "quasi-gcv") {
    before_draws <- snapshot$betaDraws
    for (metric in c("surface", "annual", "acceleration", "residuals", "ageSections", "timeTrends", "gradient", "shift")) {
      for (locale in c("en", "zh")) {
        exported <- blsd_export_plot(result, list(metric = metric, locale = locale, widthMm = 180))
        stopifnot(is.null(exported$plot$labels$title), is.null(exported$plot$labels$subtitle), is.null(exported$plot$labels$caption))
        built <- suppressWarnings(ggplot2::ggplot_build(exported$plot))
        stopifnot(length(built$data) > 0L)
        if (metric == "timeTrends") stopifnot(length(unique(built$layout$layout$PANEL)) == 6L,
          length(unique(built$layout$layout$COL)) == 3L, length(unique(built$layout$layout$ROW)) == 2L,
          length(unique(built$layout$layout$SCALE_Y)) == 6L)
        if (metric == "residuals") {
          expected_label <- if (locale == "zh") "年龄" else "Age"
          stopifnot(exported$legendShown,
            identical(exported$plot$scales$get_scales("colour")$name, expected_label),
            identical(exported$plot$labels$x, if (locale == "zh") "拟合率（每10万人）" else "Fitted rate per 100,000"),
            identical(exported$plot$data$FittedRate, vapply(result$residuals, function(row) row$fittedRate, numeric(1))),
            length(exported$plot$layers) == 2L)
        }
        if (metric == "acceleration") stopifnot(!any(exported$plot$data$Year %in% range(result$grid$years)))
        path <- file.path(out, paste0(metric, "-", locale, ".pdf"))
        grDevices::cairo_pdf(path, width = 180 / 25.4, height = 130 / 25.4, family = exported$font)
        suppressWarnings(print(exported$plot))
        grDevices::dev.off()
        stopifnot(file.info(path)$size > 1000)
        if (locale == "en") {
          grDevices::png(file.path(out, paste0(metric, "-600dpi.png")), width = 180, height = exported$heightMm,
            units = "mm", res = 600, type = "cairo", bg = "white")
          suppressWarnings(print(blsd_export_plot(result, list(metric = metric, locale = locale, widthMm = 180))$plot))
          grDevices::dev.off()
        }
      }
    }
    stopifnot(identical(before_draws, snapshot$betaDraws))
    checks <- c(checks, "Eight plots in EN/ZH vector PDF and eight 600 dpi PNG exports: PASS; no titles, subtitles or captions; acceleration endpoint rows absent")
    screened <- fit_blsd_web(list(rows = data, settings = modifyList(settings, list(threshold = 1)),
      gridOptions = list(maxAgePoints = 10L, maxYearPoints = 8L)))
    stopifnot(all(vapply(screened$points, function(p) p$masked && is.null(p$shift) && is.null(p$intervals$shift), logical(1))))
    all_masked <- blsd_export_plot(screened, list(metric = "shift", locale = "en", widthMm = 180))
    stopifnot(all_masked$finitePoints == 0L, !all_masked$legendShown,
      is.null(all_masked$plot$labels$title), is.null(all_masked$plot$labels$caption))
  }
}
non_finite <- blsd_summarize(matrix(c(1, 2, Inf), nrow = 1), 1.5)
stopifnot(is.na(non_finite$center), all(is.na(non_finite$interval)), non_finite$fraction == 2 / 3)
checks <- c(checks, "Non-finite draw sets are not filtered before quantiles; all-masked shift stays missing: PASS")
writeLines(checks, file.path(out, "checks.txt"))
cat(paste(checks, collapse = "\n"), "\n")
