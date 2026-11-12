# Standalone, deterministic export preparation regression; no fitting or jobs.
# Rscript --vanilla tests/export-prepare.test.R [project-root old-exporter-path]
args <- commandArgs(trailingOnly = TRUE)
script <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
root <- normalizePath(if (length(args)) args[1] else file.path(dirname(script), ".."), winslash = "/", mustWork = TRUE)
stopifnot(requireNamespace("ggplot2", quietly = TRUE), requireNamespace("jsonlite", quietly = TRUE))
old <- new.env(parent = globalenv()); current <- new.env(parent = globalenv())
sys.source(file.path(root, "server/blsd_export.R"), envir = current)
if (length(args) >= 2L) sys.source(args[2], envir = old) else {
  sys.source(file.path(root, "server/blsd_export.R"), envir = old)
  # Reference the former row-wise preparation, using the unchanged plot layers.
  plot_layers <- old$blsd_export_plot
  old$blsd_export_theme <- function(prepared, font, small) old$blsd_plot_theme(font, small)
  old$blsd_export_plot <- function(fit, settings) {
    prepared <- list(curves = NULL, observed = NULL, residuals = NULL, themes = new.env(parent = emptyenv()))
    if (settings$metric %in% c("ageSections", "timeTrends")) {
      sections <- identical(settings$metric, "ageSections")
      selected <- old$blsd_export_coordinates(if (sections) settings$sectionYears else settings$trendAges,
        if (sections) fit$defaults$sectionYears else fit$defaults$trendAges,
        if (sections) fit$grid$years else fit$grid$ages)
      rows <- Filter(function(p) (if (sections) p$year else p$age) %in% selected, fit$points)
      prepared$curves <- do.call(rbind, lapply(rows, function(p) data.frame(
        Year = p$year, Age = p$age, Rate = if (is.null(p$rate)) NA_real_ else p$rate,
        Lower = if (is.null(p$intervals$rate)) NA_real_ else p$intervals$rate[1],
        Upper = if (is.null(p$intervals$rate)) NA_real_ else p$intervals$rate[2])))
      observed <- Filter(function(p) (if (sections) p$year else p$age) %in% selected, fit$residuals)
      prepared$observed <- do.call(rbind, lapply(observed, function(p)
        data.frame(Year = p$year, Age = p$age, Rate = p$observedRate)))
    } else if (settings$metric == "residuals") {
      prepared$residuals <- do.call(rbind, lapply(fit$residuals, function(p)
        data.frame(FittedRate = p$fittedRate, Residual = p$devianceResidual, Age = p$age)))
    }
    plot_layers(fit, settings, prepared)
  }
}
if (length(args) >= 2L) {
  reference_plot <- old$blsd_export_plot
  old$blsd_export_plot <- function(fit, settings) {
    value <- reference_plot(fit, settings)
    for (name in names(value$plot$labels)) {
      label <- value$plot$labels[[name]]
      if (identical(label, "Year")) value$plot$labels[[name]] <- "Period"
      else if (identical(label, "年份")) value$plot$labels[[name]] <- "时期"
    }
    value
  }
}
years <- 2000:2004; ages <- 30:34
points <- lapply(seq_len(length(years) * length(ages)), function(i) {
  year <- years[(i - 1L) %% length(years) + 1L]; age <- ages[(i - 1L) %/% length(years) + 1L]
  rate <- as.numeric(year - 1900 + age)
  list(year = year, age = age, rate = rate, surface = log(rate), annual = 1.25, acceleration = if(year %in% range(years)) NULL else 0.001,
    gradient = 0.8, shift = if(i == 1L) NULL else -0.25,
    intervals = list(rate = if(i == 1L) NULL else c(rate - 1, rate + 1)))
})
observed <- lapply(points[c(1L, 3L, 5L, 8L, 16L)], function(p)
  list(year = p$year, age = p$age, observedRate = if(p$year == 2000L) 0 else p$rate,
    fittedRate = p$rate, devianceResidual = if(p$age == 33L) NA_real_ else 0.5))
fit <- list(points = points, residuals = observed, grid = list(years = years, ages = ages),
  defaults = list(sectionYears = c(2000L, 2004L), trendAges = c(30L, 34L)),
  provenance = list(ageGroups = list(list(midpoint = 30, lower = 28, upper = 31))),
  contours = list(surface = list(list(level = 4, points = list(c(2000, 30), c(2004, 34)))), annual = list()),
  meta = list(adapterVersion = "fixture"))
before <- serialize(fit, NULL)
scale_view <- function(built) lapply(built$layout$panel_params, function(panel) {
  lapply(panel[c("x", "y")], function(axis) lapply(c("breaks", "minor_breaks", "limits", "continuous_range", "name"), function(name) axis[[name]]))
})
checks <- 0L
for (case in c("ordinary", "empty_observations", "no_selected_observations", "NA_rate")) {
  test_fit <- fit
  if (case == "empty_observations") test_fit$residuals <- list()
  if (case == "no_selected_observations") test_fit$residuals <- lapply(observed, function(p) {p$year <- 2002L; p$age <- 32L; p})
  if (case == "NA_rate") test_fit$points[[2L]]$rate <- NULL
  prepared <- current$blsd_export_prepare(test_fit)
  for (metric in c("surface", "annual", "acceleration", "ageSections", "timeTrends", "gradient", "shift", "residuals")) {
    if (metric == "residuals" && case == "empty_observations") next
    for (locale in c("zh", "en")) for (visible in c(TRUE, FALSE)) {
      settings <- list(metric = metric, locale = locale, widthMm = 180, dpi = 600, format = "png", showIntervals = visible, showContours = visible)
      a <- old$blsd_export_plot(test_fit, settings)
      b <- current$blsd_export_plot(test_fit, settings, prepared)
      period_label <- if (locale == "zh") "时期" else "Period"
      if (!metric %in% c("ageSections", "residuals")) stopifnot(identical(b$plot$labels$x, period_label))
      if (metric == "ageSections") stopifnot(identical(b$plot$labels$colour, period_label),
        identical(b$plot$labels$fill, period_label), identical(b$plot$labels$linetype, period_label))
      if (metric == "annual") stopifnot(identical(b$plot$labels$fill, if(locale == "zh") "% / 年份" else "% / year"))
      stopifnot(identical(a[names(a) != "plot"], b[names(b) != "plot"]),
        identical(a$plot$data, b$plot$data), identical(a$plot$labels, b$plot$labels), identical(a$plot$theme, b$plot$theme))
      aa <- suppressWarnings(ggplot2::ggplot_build(a$plot)); bb <- suppressWarnings(ggplot2::ggplot_build(b$plot))
      stopifnot(identical(aa$data, bb$data), identical(scale_view(aa), scale_view(bb)))
      checks <- checks + 1L
    }
  }
}
stopifnot(identical(before, serialize(fit, NULL)))
cat(jsonlite::toJSON(list(ok = TRUE, comparisons = checks, fitted = FALSE, sampled = FALSE), auto_unbox = TRUE), "\n")
