# All observed curve coordinates must survive rendering and figure sizing.
# Estimates and intervals remain those of the retained fit and its draws.
script_arg <- grep("^--file=", commandArgs(), value = TRUE)[1]
server_dir <- dirname(normalizePath(sub("^--file=", "", script_arg), mustWork = TRUE))
source(file.path(server_dir, "blsd_adapter.R"))
source(file.path(server_dir, "blsd_export.R"))

stopifnot(identical(blsd_default_section_years(1990:2023), seq(1990L, 2020L, by = 5L)),
  identical(blsd_default_section_years(c(2001L, 2002L, 2008L, 2011L, 2016L)), c(2001L, 2011L, 2016L)))
data <- expand.grid(Year = 1990:2023, Age_Mid = seq(2.5, 97.5, by = 5))
data$Pop <- 200000 + data$Age_Mid * 1000
data$Deaths <- round(data$Pop * exp(-9 + .06 * data$Age_Mid - .015 * (data$Year - 1990)) *
  (1 + .1 * sin((data$Year - 1990) * 1.8 + data$Age_Mid * .2)))
fit <- fit_blsd_web(list(rows = data,
  settings = list(method = "quasi-gcv", draws = 100L, seed = 123L, kAge = 4L, kYear = 4L, threshold = .005),
  gridOptions = list(maxAgePoints = 20L, maxYearPoints = 34L)))
before <- serialize(fit, NULL)
years <- sort(unique(data$Year))
ages <- sort(unique(data$Age_Mid))
stopifnot(identical(fit$defaults$sectionYears, seq(1990L, 2020L, by = 5L)))
for (width in 180) {
  sections <- blsd_export_plot(fit, list(metric = "ageSections", locale = "en", widthMm = width,
    sectionYears = years, trendAges = ages))
  stopifnot(length(unique(sections$plot$data$Group)) == length(years),
    nrow(sections$plot$data) == length(years) * length(fit$grid$ages),
    sections$heightMm >= 169)
  trends <- blsd_export_plot(fit, list(metric = "timeTrends", locale = "en", widthMm = width,
    sectionYears = years, trendAges = ages))
  built <- suppressWarnings(ggplot2::ggplot_build(trends$plot))
  stopifnot(length(unique(built$layout$layout$PANEL)) == length(ages),
    length(unique(built$layout$layout$SCALE_Y)) == length(ages),
    length(unique(built$layout$layout$ROW)) == ceiling(length(ages) / 3),
    trends$heightMm == 16 + ceiling(length(ages) / 3) * 47)
  for (locale in c("en", "zh")) {
    residuals <- blsd_export_plot(fit, list(metric = "residuals", locale = locale, widthMm = width))
    residual_plot <- residuals$plot
    built_residuals <- suppressWarnings(ggplot2::ggplot_build(residual_plot))
    fitted_rates <- vapply(fit$residuals, function(row) row$fittedRate, numeric(1))
    deviance_residuals <- vapply(fit$residuals, function(row) row$devianceResidual, numeric(1))
    stopifnot(identical(residual_plot$data$FittedRate, fitted_rates),
      identical(residual_plot$data$Residual, deviance_residuals),
      length(residual_plot$layers) == 2L,
      all(built_residuals$data[[1]]$yintercept == 0),
      isTRUE(all.equal(built_residuals$data[[2]]$x, log10(fitted_rates), check.attributes = FALSE)),
      identical(built_residuals$data[[2]]$y, deviance_residuals),
      identical(residual_plot$labels$x, if (locale == "zh") "拟合率（每10万人）" else "Fitted rate per 100,000"),
      identical(residual_plot$labels$y, if (locale == "zh") "偏差残差" else "Deviance residual"),
      identical(residual_plot$scales$get_scales("colour")$name, if (locale == "zh") "年龄" else "Age"))
  }
}
stopifnot(identical(serialize(fit, NULL), before))
cat("34 observed section years, 20 age facets, fitted-rate residual plots in both languages at 180 mm, unchanged retained estimates/draws: PASS\n")
