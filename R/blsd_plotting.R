# Publication-oriented figures for the self-contained BLSD demonstration.
# Labels are English and use the platform's default sans font. No font or
# graphics packages are installed by this script.

make_blsd_demo_figures <- function(
    data, fit, prediction, discrete_fields, continuous_fields, apc,
    transformed, output_dir) {
  for (package in c("ggplot2", "gridExtra")) {
    if (!requireNamespace(package, quietly = TRUE)) {
      stop("Install the required plotting package: ", package, call. = FALSE)
    }
  }
  validate_blsd_prediction(prediction)
  if (!inherits(fit, "blsd_s") || !inherits(apc, "blsd_apc")) {
    stop("fit and apc must be BLSD model and decomposition objects.", call. = FALSE)
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
    # Unequal node spacings need asymmetric cell bounds. A width centred on
    # the node would otherwise leave gaps or overlap near an appended endpoint.
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

  # 01: Rates and equal-rate contours. Colour encodes a rate, not evidence.
  p <- heatmap(rates, "Rate", "Fitted mortality surface", "Deaths per 100,000",
               "Coefficient-draw mean rate; white contours mark equal fitted rates.",
               diverging = FALSE, fill_transform = "log10") +
    ggplot2::geom_contour(ggplot2::aes(z = log10(Rate)), bins = 12,
                          colour = "white", linewidth = 0.35, alpha = 0.65)
  save_figure(1, "mortality_surface", p, "Fitted mortality surface",
               "Rate per 100,000; logarithmic colour scale; equal-rate contours.")

  # 02: Transform every derivative draw before summarizing (done by the runner).
  p <- heatmap(year_percent, "Annual_Change_Pct", "Local annual mortality change",
               "Relative change (%)",
               "100 * (exp(partial log-rate / partial year) - 1), summarized draw by draw.") +
    ggplot2::labs(caption = "Local one-calendar-year approximation. Colours show the mean, not interval exclusion of zero.")
  save_figure(2, "annual_change_percent", p, "Local annual mortality change",
               "Derivative-based local one-calendar-year relative change; draw-wise transformation.")

  # 03: This remains a log-rate second derivative, not a percent acceleration.
  p <- heatmap(continuous_fields$acceleration, "Acceleration",
               "Temporal acceleration of log mortality", "Log-rate / year^2",
               "Positive values: increasing time slope; negative values: decreasing time slope.") +
    ggplot2::labs(caption = "Natural cubic spline endpoint acceleration is constrained to zero; it is not an empirical finding.")
  save_figure(3, "log_rate_acceleration", p, "Temporal log-rate acceleration",
               "Second period derivative; natural cubic endpoint constraints apply.")

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

  # 10: Repeated values at the same APC coordinate are represented once.
  contribution_curve <- function(component, coordinate, title, x_label) {
    x <- apc$summary[apc$summary$Component == component, ]
    if (coordinate == "Cohort") x$Cohort <- x$Year - x$Age_Mid
    x <- x[!duplicated(x[[coordinate]]), ]
    x <- x[order(x[[coordinate]]), ]
    ggplot2::ggplot(x, ggplot2::aes(x = .data[[coordinate]], y = Effect)) +
      ggplot2::geom_hline(yintercept = 0, colour = "grey50", linetype = 2, linewidth = 0.3) +
      ggplot2::geom_ribbon(ggplot2::aes(ymin = Effect_lower, ymax = Effect_upper),
                            fill = "#2C7FB8", alpha = 0.2) +
      ggplot2::geom_line(colour = "#2166AC", linewidth = 0.8) +
      ggplot2::labs(title = title, x = x_label, y = "Log-rate contribution") + theme_blsd()
  }
  p <- combined(list(
    contribution_curve("Age", "Age_Mid", "A. Age contribution", "Age (years)"),
    contribution_curve("Net_Drift", "Year", "B. Constrained net period drift", "Calendar year"),
    contribution_curve("Period_Curvature", "Year", "C. Period curvature contribution", "Calendar year"),
    contribution_curve("Cohort_Curvature", "Cohort", "D. Cohort curvature contribution", "Approximate birth year")),
    "Constrained APC contributions",
    paste(interval_note, "Components depend on the grid, basis dimensions and constraints."))
  save_figure(10, "apc_contribution_curves", p, "Constrained APC contribution curves",
               "Log-rate contributions; curvature means nonlinear spline contribution, not a second derivative.",
               width = 12, height = 9)

  # 11: Every contribution, including the intercept and remainder, is retained.
  component_names <- c("Intercept", "Age", "Net_Drift", "Period_Curvature",
                        "Cohort_Curvature", "Residual_Dynamic_Surface")
  component_titles <- c("Intercept", "Age", "Net period drift", "Period curvature",
                         "Cohort curvature", "Projection remainder")
  component_plots <- lapply(seq_along(component_names), function(i) {
    x <- apc$summary[apc$summary$Component == component_names[i], ]
    heatmap(x, "Effect", component_titles[i], "Log-rate contribution")
  })
  p <- combined(component_plots, "Six components of the log-rate surface",
                 "Each panel has its own colour limits. Contributions reconstruct the original surface draw by draw.",
                 ncol = 2)
  save_figure(11, "six_apc_component_surfaces", p, "Six APC component surfaces",
               "Six log-rate components; independent panel colour scales; decomposition does not improve count likelihood.",
               width = 12, height = 13)

  # 12: Compare full and projected log-rate surfaces on the same colour scale.
  remainder_draws <- apc$component_draws$Residual_Dynamic_Surface
  full_surface <- prediction$grid
  full_surface$Log_Rate <- rowMeans(prediction$eta_draws)
  apc_surface <- prediction$grid
  apc_surface$Log_Rate <- rowMeans(prediction$eta_draws - remainder_draws)
  remainder_surface <- prediction$grid
  remainder_surface$Remainder <- rowMeans(remainder_draws)
  common_limits <- range(c(full_surface$Log_Rate, apc_surface$Log_Rate), finite = TRUE)
  if (diff(common_limits) == 0) common_limits <- common_limits + c(-0.5, 0.5)
  p <- combined(list(
    heatmap(full_surface, "Log_Rate", "A. Full BLSD-S", "Log mortality rate",
              diverging = FALSE, limits = common_limits),
    heatmap(apc_surface, "Log_Rate", "B. APC projection", "Log mortality rate",
              diverging = FALSE, limits = common_limits),
    heatmap(remainder_surface, "Remainder", "C. Projection remainder", "Log-rate difference")),
    "Full surface, APC projection and remainder",
    "A and B share colour limits; C has its own zero-centred scale. Remainder = full log-rate minus APC log-rate.",
    ncol = 3)
  save_figure(12, "full_apc_remainder", p, "Full, APC and remainder surfaces",
               "Log-rate projection comparison; reconstruction is an algebraic property, not validation.",
               width = 17, height = 6)

  # 13: Transform each remainder draw; exp(mean(R)) is not mean(exp(R)).
  multiplier <- summarize_draw_matrix(exp(remainder_draws), prediction$grid,
                                       "Mortality_Multiplier")
  multiplier <- tiles(multiplier)
  multiplier_limits <- range(c(1, multiplier$Mortality_Multiplier), finite = TRUE)
  if (diff(multiplier_limits) == 0) multiplier_limits <- c(0.99, 1.01)
  p <- ggplot2::ggplot(multiplier, ggplot2::aes(x = Year, y = Age_Mid)) +
    ggplot2::geom_rect(ggplot2::aes(fill = Mortality_Multiplier,
                                   xmin = .X_Min, xmax = .X_Max,
                                   ymin = .Y_Min, ymax = .Y_Max)) +
    ggplot2::scale_fill_gradient2(low = "#2166AC", mid = "#F7F7F7", high = "#B2182B",
                                   midpoint = 1, limits = multiplier_limits,
                                   name = "Full / APC rate", na.value = "grey75") +
    ggplot2::coord_cartesian(xlim = range(multiplier$Year), ylim = range(multiplier$Age_Mid),
                               expand = FALSE) +
    ggplot2::labs(title = "Mortality multiplier from the APC projection remainder",
                  subtitle = "Mean of exp(remainder) across the same coefficient draws.",
                  x = "Calendar year", y = "Age (years)",
                  caption = "Above 1: full rate exceeds the APC projection rate. Below 1: full rate is lower. This is a descriptive ratio.") +
    theme_blsd()
  save_figure(13, "remainder_mortality_multiplier", p, "Remainder mortality multiplier",
               "Draw-wise exp(R), then summarized; ratio of full rate to APC projection rate.")
  utils::write.csv(multiplier[c("Age_Mid", "Year", "Mortality_Multiplier",
                                "Mortality_Multiplier_lower", "Mortality_Multiplier_upper")],
                    file.path(table_dir, "remainder_mortality_multiplier.csv"), row.names = FALSE)
  utils::write.csv(observed[c("Age_Mid", "Year", "Deaths", "Pop", "Fitted_Deaths",
                              "Deviance_Residual", "Pearson_Residual", "Observed_Rate", "Cohort")],
                    file.path(table_dir, "count_fit_diagnostics.csv"), row.names = FALSE)
  result <- do.call(rbind, manifest)
  rownames(result) <- NULL
  utils::write.csv(result, file.path(table_dir, "figure_manifest.csv"), row.names = FALSE)
  result
}
