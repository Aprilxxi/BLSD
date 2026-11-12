# BLSD web adapter. The original analysis scripts are left unchanged.
# Usage: Rscript --vanilla blsd_adapter.R request.json response.json

blsd_fail <- function(code, message) {
  condition <- structure(list(message = message, call = NULL, code = code),
                         class = c("blsd_error", "error", "condition"))
  stop(condition)
}

blsd_derivative <- function(model, grid, variable, domain, h, order = 1L, base_lpmatrix = NULL) {
  # Same second-order, in-domain lpmatrix stencils as R/blsd_models.R.
  x <- grid[[variable]]
  kind <- ifelse(x - h < domain[1], "forward", ifelse(x + h > domain[2], "backward", "central"))
  result <- matrix(0, nrow(grid), length(coef(model)))
  cancellation <- numeric(nrow(grid))
  for (method in unique(kind)) {
    ix <- which(kind == method)
    nodes <- if (method == "central") c(-1, 0, 1) else if (order == 1L) 0:2 else 0:3
    weights <- if (method == "central") {
      if (order == 1L) c(-0.5, 0, 0.5) else c(1, -2, 1)
    } else if (order == 1L) c(-1.5, 2, -0.5) else c(2, -5, 4, -1)
    if (method == "backward") {
      nodes <- -nodes
      if (order == 1L) weights <- -weights
    }
    for (j in seq_along(nodes)) {
      nd <- grid[ix, , drop = FALSE]
      nd[[variable]] <- x[ix] + nodes[j] * h
      xp <- if (nodes[j] == 0 && !is.null(base_lpmatrix)) base_lpmatrix[ix, , drop = FALSE]
        else predict(model, newdata = nd, type = "lpmatrix")
      result[ix, ] <- result[ix, , drop = FALSE] + weights[j] * xp
      cancellation[ix] <- cancellation[ix] + abs(weights[j]) * apply(abs(xp), 1L, max)
    }
  }
  zeroed <- apply(abs(result), 1L, max) <= 64 * .Machine$double.eps * cancellation
  result[zeroed, ] <- 0
  # Natural cubic temporal margins have structurally zero endpoint curvature.
  if (order == 2L) result[x == domain[1] | x == domain[2], ] <- 0
  result / h^order
}

blsd_summarize <- function(draws, centers) {
  fraction <- rowMeans(is.finite(draws))
  valid <- is.finite(centers) & fraction == 1
  bounds <- matrix(NA_real_, nrow(draws), 2L)
  if (any(valid)) bounds[valid, ] <- t(apply(draws[valid, , drop = FALSE], 1L,
                                           quantile, probs = c(0.025, 0.975), names = FALSE))
  centers[!valid] <- NA_real_
  list(center = centers, interval = bounds, fraction = fraction)
}

blsd_number <- function(x) if (length(x) != 1L || !is.finite(x)) NULL else unname(x)
blsd_interval <- function(x) if (length(x) != 2L || any(!is.finite(x))) NULL else unname(x)

# Tests summarize the retained fit only. The basis check has its own reproducible
# permutation stream and restores the caller's RNG, including an absent seed.
blsd_model_tests <- function(model, fit_summary, seed = 20261015L, replicates = 400L, subsample = 5000L) {
  table_number <- function(table, row, column) {
    if (is.null(table) || !column %in% colnames(table)) NULL else blsd_number(table[row, column])
  }
  smooth_table <- fit_summary$s.table
  smooth_tests <- if (is.null(smooth_table)) list() else lapply(seq_len(nrow(smooth_table)), function(i) {
    statistic_column <- intersect(c("F", "Chi.sq", "Chi-sq"), colnames(smooth_table))[1L]
    p_value <- table_number(smooth_table, i, "p-value")
    list(term = rownames(smooth_table)[i], edf = table_number(smooth_table, i, "edf"),
      referenceDf = table_number(smooth_table, i, "Ref.df"),
      statistic = if (is.na(statistic_column)) NULL else table_number(smooth_table, i, statistic_column),
      statisticType = if (is.na(statistic_column)) NULL else if (statistic_column == "F") "F" else "Chi-sq",
      pValue = p_value, approximate = TRUE, status = if (is.null(p_value)) "UNAVAILABLE" else "AVAILABLE")
  })
  parametric_table <- fit_summary$p.table
  parametric_tests <- if (is.null(parametric_table)) list() else lapply(seq_len(nrow(parametric_table)), function(i) {
    statistic_column <- intersect(c("t value", "z value"), colnames(parametric_table))[1L]
    p_column <- grep("^Pr\\(", colnames(parametric_table), value = TRUE)[1L]
    p_value <- if (is.na(p_column)) NULL else table_number(parametric_table, i, p_column)
    list(term = rownames(parametric_table)[i], estimate = table_number(parametric_table, i, "Estimate"),
      stdError = table_number(parametric_table, i, "Std. Error"),
      statistic = if (is.na(statistic_column)) NULL else table_number(parametric_table, i, statistic_column),
      statisticType = if (is.na(statistic_column)) NULL else if (statistic_column == "t value") "t" else "z",
      pValue = p_value, status = if (is.null(p_value)) "UNAVAILABLE" else "AVAILABLE")
  })
  rng_kind <- RNGkind()
  had_seed <- exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  if (had_seed) saved_seed <- get(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
  on.exit({
    do.call(RNGkind, as.list(rng_kind))
    if (had_seed) assign(".Random.seed", saved_seed, envir = .GlobalEnv)
    else if (exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) rm(".Random.seed", envir = .GlobalEnv)
  }, add = TRUE)
  # Specify every RNG component so diagnostic values do not depend on a caller's
  # RNGkind. This stream never supplies model coefficients or interval draws.
  RNGkind("Mersenne-Twister", "Inversion", "Rejection")
  set.seed(seed)
  check_table <- tryCatch(suppressWarnings(mgcv::k.check(model, subsample = subsample, n.rep = replicates)),
                          error = function(e) NULL)
  terms <- vapply(model$smooth, function(smooth) smooth$label, character(1))
  basis_checks <- lapply(seq_along(terms), function(i) {
    row <- if (is.null(check_table)) NA_integer_ else match(terms[i], rownames(check_table))
    value <- function(column) if (is.na(row)) NULL else table_number(check_table, row, column)
    p_value <- value("p-value")
    list(term = terms[i], kPrime = value("k'"), edf = value("edf"), kIndex = value("k-index"),
      pValue = p_value, replicates = replicates, seed = seed, subsample = subsample,
      status = if (is.null(p_value)) "UNAVAILABLE" else "AVAILABLE")
  })
  list(smoothTests = smooth_tests, parametricTests = parametric_tests, basisChecks = basis_checks,
    basisCheckStatus = if (is.null(check_table)) "UNAVAILABLE" else if (any(vapply(basis_checks,
      function(check) check$status == "UNAVAILABLE", logical(1)))) "PARTIAL" else "AVAILABLE",
    residualDf = blsd_number(fit_summary$residual.df), adjustedRSquared = blsd_number(fit_summary$r.sq),
    aic = blsd_number(tryCatch(stats::AIC(model), error = function(e) NA_real_)))
}

blsd_default_coordinates <- function(axis, count) {
  axis[unique(round(seq(1L, length(axis), length.out = min(count, length(axis)))))]
}

blsd_default_section_years <- function(axis) {
  axis[(axis - axis[1]) %% 5 == 0]
}

# Include exact observed coordinates, while keeping the display density bounded.
blsd_prediction_axis <- function(observed, count) {
  if (length(observed) <= count) {
    extra <- max(2L, count - length(observed) + 2L)
    sort(unique(c(observed, seq(min(observed), max(observed), length.out = extra))))
  } else observed
}

blsd_contours <- function(points, years, ages, metric) {
  values <- vapply(points, function(p) if (is.null(p[[metric]])) NA_real_ else p[[metric]], numeric(1))
  if (!any(is.finite(values)) || diff(range(values, na.rm = TRUE)) == 0) return(list())
  limits <- range(values, na.rm = TRUE)
  # Match the supplied research figures' geom_contour bins using retained
  # central values only. This is ggplot2's contour-break rule, without fitting
  # or sampling again and without an unexported ggplot2 function dependency.
  bins <- if (identical(metric, "surface")) 12L else 10L
  accuracy <- signif(diff(limits), 1L) / 10
  contour_range <- c(floor(limits[1] / accuracy), ceiling(limits[2] / accuracy)) * accuracy
  levels <- scales::fullseq(contour_range, diff(contour_range) / (bins - 1L))
  if (length(levels) < bins + 1L)
    levels <- scales::fullseq(contour_range, diff(contour_range) / bins)
  paths <- grDevices::contourLines(x = years, y = ages,
    z = t(matrix(values, nrow = length(ages), ncol = length(years))), levels = levels)
  lapply(paths, function(path) list(level = path$level,
    points = lapply(seq_along(path$x), function(i) unname(c(path$x[i], path$y[i])))))
}

# Rates and their pointwise intervals use the same coefficient draws as every
# field. No draw median is used as a central estimate.
blsd_rate_predictions <- function(model, beta, beta_draws, grid) {
  rows <- vector("list", nrow(grid))
  for (first in seq(1L, nrow(grid), by = 128L)) {
    ix <- first:min(nrow(grid), first + 127L)
    X <- predict(model, newdata = grid[ix, , drop = FALSE], type = "lpmatrix")
    center <- drop(X %*% beta) + log(100000)
    draws <- X %*% beta_draws + log(100000)
    log_summary <- blsd_summarize(draws, center)
    rate_summary <- blsd_summarize(exp(draws), exp(center))
    for (j in seq_along(ix)) rows[[ix[j]]] <- list(
      year = grid$Year[ix[j]], age = grid$Age_Mid[ix[j]],
      rate = blsd_number(rate_summary$center[j]), logRate = blsd_number(log_summary$center[j]),
      intervals = list(rate = blsd_interval(rate_summary$interval[j, ]),
        logRate = blsd_interval(log_summary$interval[j, ])),
      validFraction = rate_summary$fraction[j])
  }
  rows
}

fit_blsd_web <- function(request) {
  if (!requireNamespace("mgcv", quietly = TRUE)) blsd_fail("R_PACKAGES_MISSING", "The R fitting dependency is unavailable.")
  data <- request$rows
  if (is.data.frame(data)) {
    if (all(c("Count", "count") %in% names(data)))
      blsd_fail("DUPLICATE_COLUMN", "Use one Count column.")
    count_columns <- intersect(c("Count", "count", "Deaths"), names(data))
    if (!length(count_columns) || !all(vapply(data[count_columns], is.numeric, logical(1))) ||
        any(!is.finite(as.matrix(data[count_columns]))))
      blsd_fail("INVALID_DATA", "Count must contain finite numbers.")
    count <- data[[count_columns[1]]]
    if (any(vapply(data[count_columns], function(values) any(values != count), logical(1))))
      blsd_fail("CONFLICTING_COUNT_COLUMNS", "Count and legacy count columns must agree.")
    data$Deaths <- count
    data[intersect(c("Count", "count"), names(data))] <- NULL
  }
  required <- c("Year", "Age_Mid", "Deaths", "Pop")
  if (!is.data.frame(data) || !all(required %in% names(data)) || !nrow(data))
    blsd_fail("INVALID_DATA", "A nonempty four-column numeric data table is required.")
  if (!all(vapply(data[required], is.numeric, logical(1))) || any(!is.finite(as.matrix(data[required]))) ||
      any(data$Deaths < 0) || any(data$Pop <= 0)) blsd_fail("INVALID_DATA", "The data contains invalid numeric values.")
  if ("Sex" %in% names(data) && (!is.character(data$Sex) || anyNA(data$Sex) || any(!nzchar(data$Sex)) || length(unique(data$Sex)) != 1L))
    blsd_fail("MIXED_SEX_GROUPS", "Fit one sex group at a time.")
  if (anyDuplicated(data[c("Year", "Age_Mid")])) blsd_fail("DUPLICATE_YEAR_AGE", "Each age and year combination must occur once.")
  observed_years <- sort(unique(data$Year))
  observed_ages <- sort(unique(data$Age_Mid))
  if (length(observed_years) < 5L || length(observed_ages) < 5L)
    blsd_fail("INSUFFICIENT_DOMAIN", "At least five ages and five years are required.")
  settings <- request$settings
  method <- settings$method
  if (!method %in% c("quasi-gcv", "quasi-reml", "nb-reml")) blsd_fail("INVALID_SETTINGS", "The fitting method is unsupported.")
  k_age <- min(as.integer(settings$kAge), length(observed_ages) - 1L)
  k_year <- min(as.integer(settings$kYear), length(observed_years) - 1L)
  if (k_age < 4L || k_year < 4L || nrow(data) <= k_age * k_year)
    blsd_fail("INSUFFICIENT_DATA", "There are too few observations for the requested basis dimensions.")
  te <- mgcv::te
  family <- if (method == "nb-reml") mgcv::nb(link = "log") else quasipoisson(link = "log")
  smoothing <- if (method == "quasi-gcv") "GCV.Cp" else "REML"
  fit_warnings <- character()
  model <- withCallingHandlers(mgcv::gam(
    Deaths ~ te(Year, Age_Mid, k = c(k_year, k_age), bs = c("cr", "cr")) + offset(log(Pop)),
    family = family, method = smoothing, data = data
  ), warning = function(w) { fit_warnings <<- c(fit_warnings, conditionMessage(w)); invokeRestart("muffleWarning") })
  if (!isTRUE(model$converged)) blsd_fail("FIT_NOT_CONVERGED", "The model did not converge.")
  beta <- coef(model)
  covariance_source <- if (!is.null(model$Vc)) "Vc" else "Vp"
  covariance <- model[[covariance_source]]
  if (any(!is.finite(beta)) || any(!is.finite(covariance))) blsd_fail("FIT_NUMERICAL_ERROR", "The fitted covariance is invalid.")
  decomposition <- eigen((covariance + t(covariance)) / 2, symmetric = TRUE)
  tolerance <- 1e-8 * max(abs(decomposition$values), .Machine$double.eps)
  if (min(decomposition$values) < -tolerance) blsd_fail("FIT_NUMERICAL_ERROR", "The fitted covariance is not positive semidefinite.")
  set.seed(as.integer(settings$seed))
  innovations <- matrix(rnorm(length(beta) * settings$draws), nrow = length(beta))
  beta_draws <- sweep(decomposition$vectors %*% (sqrt(pmax(decomposition$values, 0)) * innovations), 1, beta, "+")
  rm(innovations)

  # Exact observation coordinates are retained instead of snapping to the
  # regular display grid. Each chunk holds draws for only 128 locations.
  age_count <- min(100L, as.integer(request$gridOptions$maxAgePoints %||% 100L))
  year_count <- min(40L, as.integer(request$gridOptions$maxYearPoints %||% 40L))
  age_count <- max(5L, age_count)
  year_count <- max(5L, year_count)
  defaults <- list(sectionYears = blsd_default_section_years(observed_years),
                   trendAges = observed_ages)
  ages <- blsd_prediction_axis(observed_ages, age_count)
  years <- if (length(observed_years) <= year_count) observed_years else
    blsd_prediction_axis(observed_years, year_count)
  coordinate_rule <- "REGULAR_GRID_UNION_EXACT_OBSERVATIONS"
  # Very large irregular tables must not create an unbounded Cartesian product.
  # Their exact observations are still evaluated and retained below.
  if (length(ages) > 200L || length(years) > 200L || length(ages) * length(years) > 40000L) {
    ages <- sort(unique(c(seq(min(observed_ages), max(observed_ages), length.out = age_count), blsd_default_coordinates(observed_ages, 6L))))
    years <- sort(unique(c(seq(min(observed_years), max(observed_years), length.out = year_count), defaults$sectionYears)))
    coordinate_rule <- "REGULAR_GRID_WITH_EXACT_OBSERVATION_PREDICTIONS"
  }
  grid <- expand.grid(Age_Mid = ages, Year = years, KEEP.OUT.ATTRS = FALSE)
  grid$Pop <- 1
  h_age <- min(0.01, diff(range(ages)) / 10)
  h_year <- min(0.01, diff(range(years)) / 10)
  points <- vector("list", nrow(grid))
  masked_count <- 0L
  for (first in seq(1L, nrow(grid), by = 128L)) {
    ix <- first:min(nrow(grid), first + 127L)
    nd <- grid[ix, , drop = FALSE]
    X <- predict(model, newdata = nd, type = "lpmatrix")
    Dt <- blsd_derivative(model, nd, "Year", range(years), h_year, base_lpmatrix = X)
    Da <- blsd_derivative(model, nd, "Age_Mid", range(ages), h_age, base_lpmatrix = X)
    Dtt <- blsd_derivative(model, nd, "Year", range(years), h_year, 2L, base_lpmatrix = X)
    eta_hat <- drop(X %*% beta)
    temporal_hat <- drop(Dt %*% beta)
    age_hat <- drop(Da %*% beta)
    temporal_draws <- Dt %*% beta_draws
    age_draws <- Da %*% beta_draws
    acceleration_hat <- drop(Dtt %*% beta)
    acceleration_draws <- Dtt %*% beta_draws
    eta_draws <- X %*% beta_draws + log(100000)
    age_summary <- blsd_summarize(age_draws, age_hat)
    temporal_summary <- blsd_summarize(temporal_draws, temporal_hat)
    raw_centers <- list(surface = eta_hat + log(100000), rate = exp(eta_hat) * 100000,
      annual = 100 * expm1(temporal_hat), acceleration = acceleration_hat,
      gradient = 100 * expm1(age_hat), shift = -temporal_hat / age_hat)
    summaries <- list(
      surface = blsd_summarize(eta_draws, raw_centers$surface),
      rate = blsd_summarize(exp(eta_draws), raw_centers$rate),
      annual = blsd_summarize(100 * expm1(temporal_draws), raw_centers$annual),
      acceleration = blsd_summarize(acceleration_draws, raw_centers$acceleration),
      gradient = blsd_summarize(100 * expm1(age_draws), raw_centers$gradient),
      shift = blsd_summarize(-temporal_draws / age_draws, raw_centers$shift)
    )
    stable <- (age_summary$interval[, 1] > settings$threshold & age_hat > settings$threshold) |
      (age_summary$interval[, 2] < -settings$threshold & age_hat < -settings$threshold)
    stable <- !is.na(stable) & stable & summaries$shift$fraction == 1 & is.finite(summaries$shift$center)
    for (j in seq_along(ix)) {
      boundary <- nd$Year[j] == min(years) || nd$Year[j] == max(years)
      reason <- if (stable[j]) NULL else if (summaries$shift$fraction[j] < 1) "NON_FINITE_RATIO" else "UNSTABLE_AGE_GRADIENT"
      p <- list(year = nd$Year[j], age = nd$Age_Mid[j], intervals = list(),
                masked = !stable[j], maskReason = reason, validFraction = summaries$shift$fraction[j],
                logAnnual = temporal_hat[j], logGradient = age_hat[j], metricMaskReasons = list(),
                raw = list(), rawIntervals = list(), metricMasks = list(), metricValidFractions = list(),
                rawDerivatives = list(logAnnual = blsd_number(temporal_hat[j]),
                  logGradient = blsd_number(age_hat[j]), logAcceleration = blsd_number(acceleration_hat[j]),
                  intervals = list(logAnnual = blsd_interval(temporal_summary$interval[j, ]),
                    logGradient = blsd_interval(age_summary$interval[j, ]),
                    logAcceleration = blsd_interval(summaries$acceleration$interval[j, ]))))
      for (metric in names(summaries)) {
        summary <- summaries[[metric]]
        hidden <- (metric == "shift" && !stable[j]) || (metric == "acceleration" && boundary)
        p[metric] <- list(if (hidden) NULL else blsd_number(summary$center[j]))
        p$intervals[metric] <- list(if (hidden) NULL else blsd_interval(summary$interval[j, ]))
        p$raw[metric] <- list(blsd_number(raw_centers[[metric]][j]))
        p$rawIntervals[metric] <- list(blsd_interval(summary$interval[j, ]))
        p$metricMasks[metric] <- list(hidden || !is.finite(summary$center[j]))
        p$metricValidFractions[metric] <- list(summary$fraction[j])
        if (!hidden && !is.finite(summary$center[j])) p$metricMaskReasons[metric] <- "NON_FINITE"
      }
      if (boundary) p$metricMaskReasons$acceleration <- "NATURAL_SPLINE_BOUNDARY"
      if (!stable[j]) p$metricMaskReasons$shift <- reason
      points[[ix[j]]] <- p
    }
    masked_count <- masked_count + sum(!stable)
  }
  fit_summary <- summary(model)
  settings$kAge <- k_age
  settings$kYear <- k_year
  observed_grid <- data.frame(Year = data$Year, Age_Mid = data$Age_Mid, Pop = 1)
  observed_predictions <- blsd_rate_predictions(model, beta, beta_draws, observed_grid)
  deviance_residuals <- as.numeric(residuals(model, type = "deviance"))
  pearson_residuals <- as.numeric(residuals(model, type = "pearson"))
  residual_rows <- lapply(seq_len(nrow(data)), function(i) {
    prediction <- observed_predictions[[i]]
    list(year = data$Year[i], age = data$Age_Mid[i], count = data$Deaths[i], deaths = data$Deaths[i], pop = data$Pop[i],
      cohort = data$Year[i] - data$Age_Mid[i], observedRate = data$Deaths[i] / data$Pop[i] * 100000,
      fittedRate = prediction$rate, fittedCount = prediction$rate / 100000 * data$Pop[i],
      fittedDeaths = prediction$rate / 100000 * data$Pop[i],
      logRate = prediction$logRate, intervals = prediction$intervals,
      devianceResidual = deviance_residuals[i], pearsonResidual = pearson_residuals[i])
  })
  cohort_smooth <- tryCatch(suppressWarnings({
    cohort_data <- data.frame(cohort = data$Year - data$Age_Mid, value = deviance_residuals)
    smoother <- stats::loess(value ~ cohort, data = cohort_data, span = 0.75)
    coordinates <- seq(min(cohort_data$cohort), max(cohort_data$cohort), length.out = 150L)
    values <- predict(smoother, newdata = data.frame(cohort = coordinates))
    lapply(seq_along(coordinates), function(i) list(cohort = coordinates[i], value = blsd_number(values[i])))
  }), error = function(e) list())
  curve_points <- lapply(points, function(p) list(year = p$year, age = p$age,
    rate = p$rate, logRate = p$surface, intervals = list(rate = p$intervals$rate, logRate = p$intervals$surface),
    validFraction = p$metricValidFractions$rate))
  model_tests <- blsd_model_tests(model, fit_summary)
  result <- list(schemaVersion = "1", grid = list(years = years, ages = ages,
       observedYears = observed_years, observedAges = observed_ages), points = points,
       input = data[c(required, intersect("Sex", names(data)))], provenance = request$provenance %||% list(source = "STANDARD_COUNT_EXPOSURE_CSV"),
       defaults = defaults, residuals = residual_rows, cohortSmooth = cohort_smooth,
       ageSections = list(years = defaults$sectionYears,
         points = Filter(function(p) p$year %in% defaults$sectionYears, curve_points),
         observed = Filter(function(p) p$year %in% defaults$sectionYears, residual_rows)),
       timeTrends = list(ages = defaults$trendAges,
         points = Filter(function(p) p$age %in% defaults$trendAges, curve_points),
         observed = Filter(function(p) p$age %in% defaults$trendAges, residual_rows)),
       contours = list(surface = blsd_contours(points, years, ages, "surface"),
                       annual = blsd_contours(points, years, ages, "annual")),
       settings = settings,
       parameters = list(coefficients = as.list(beta), formula = "Count ~ te(Year, Age_Mid, bs=c('cr','cr')) + offset(log(Pop))",
                         covarianceSource = covariance_source, seed = settings$seed, draws = ncol(beta_draws)),
       diagnostics = c(list(n = nrow(data), edf = sum(model$edf), scale = fit_summary$scale,
         devianceExplained = fit_summary$dev.expl, converged = isTRUE(model$converged),
         method = method, smoothingMethod = smoothing, family = model$family$family,
         covarianceSource = covariance_source, covarianceMinimumEigenvalue = min(decomposition$values),
         covarianceClippedEigenvalues = sum(decomposition$values < 0),
         gridPoints = nrow(grid), maskedShiftPoints = masked_count, hAge = h_age, hYear = h_year,
         predictionCoordinateRule = coordinate_rule,
         warningCount = length(unique(fit_warnings)), nonIntegerCount = any(data$Deaths != round(data$Deaths)),
         nonIntegerDeaths = any(data$Deaths != round(data$Deaths)),
         incompleteGrid = nrow(data) != length(observed_ages) * length(observed_years),
         temporalBoundaryRule = "NATURAL_SPLINE_BOUNDARY", theta = if (method == "nb-reml") model$family$getTheta(TRUE) else NULL), model_tests),
       meta = list(fitted = TRUE, simulationOnly = FALSE, statisticalFitExecuted = TRUE,
         engine = "mgcv", adapterVersion = "2.0.0", resultDataVersion = "2", surfaceScale = "LOG_RATE_PER_100000",
         algorithmVersion = "BLSD-WEB-2.0.0", rVersion = R.version.string,
         mgcvVersion = as.character(utils::packageVersion("mgcv")),
         coefficientDrawAlgorithm = "JOINT_GAUSSIAN_SYMMETRIC_EIGEN_DECOMPOSITION",
         intervalScope = "POINTWISE_GAUSSIAN_COEFFICIENT", smoothingUncertaintyCorrected = covariance_source == "Vc",
         shiftScreen = "GRADIENT_INTERVAL_OUTSIDE_THRESHOLD_AND_ALL_RATIOS_FINITE",
         accelerationBoundary = "ENDPOINTS_HIDDEN_NATURAL_CUBIC_CONSTRAINT",
          derivativeDefinition = "CONTINUOUS_SAME_POINT_LPMATRIX", centerDefinition = "FITTED_COEFFICIENT_SUBSTITUTION",
          cohortResidualDefinition = "DESCRIPTIVE_COUNT_DEVIANCE_RESIDUALS_BY_APPROXIMATE_BIRTH_YEAR",
          sex = if ("Sex" %in% names(data)) data$Sex[1] else NULL,
          units = list(surface = "ln(rate per 100000)", rate = "per 100000", annual = "%/year",
            acceleration = "log-rate/year^2", gradient = "%/age-year", shift = "age-years/year",
            logAnnual = "log-rate/year", logGradient = "log-rate/age-year", residuals = "deviance residual"), rateScale = 100000))
  # Keep the exact fitted model and coefficient draws for derivative step-size
  # sensitivity. Compact formula environments avoid serializing this whole job.
  snapshot_model <- model
  for (name in c("formula", "pred.formula")) {
    if (inherits(snapshot_model[[name]], "formula")) environment(snapshot_model[[name]]) <- asNamespace("mgcv")
  }
  for (name in c("terms", "pterms")) {
    if (!is.null(snapshot_model[[name]])) attr(snapshot_model[[name]], ".Environment") <- asNamespace("mgcv")
  }
  if (!is.null(attr(snapshot_model$model, "terms")))
    attr(attr(snapshot_model$model, "terms"), ".Environment") <- asNamespace("mgcv")
  attr(result, "reproducibility") <- list(fittedModel = snapshot_model, betaDraws = beta_draws,
                                        beta = beta, covariance = covariance, covarianceSource = covariance_source,
                                        predictionGrid = grid, observedData = data, inputProvenance = result$provenance,
                                        adapterVersion = "2.0.0")
  result
}

`%||%` <- function(left, right) if (is.null(left)) right else left

# A temporary column view lets jsonlite encode repeated records in batches.
# Keep the result/RDS untouched, including null fields and variable-length arrays.
blsd_json_rows <- function(rows) {
  named_record <- function(value) is.list(value) && !is.object(value) &&
    length(value) > 0L && !is.null(names(value)) && all(nzchar(names(value))) && !anyDuplicated(names(value))
  if (!length(rows) || !is.null(names(rows)) || !all(vapply(rows, named_record, logical(1)))) return(rows)
  fields <- names(rows[[1]])
  if (!all(vapply(rows, function(row) identical(names(row), fields), logical(1)))) return(rows)
  columns <- lapply(fields, function(field) {
    values <- lapply(rows, `[[`, field)
    scalar <- vapply(values, function(value) is.null(value) || (is.atomic(value) &&
      length(value) == 1L && is.null(attributes(value)) &&
      typeof(value) %in% c("integer", "double", "logical", "character")), logical(1))
    present <- Filter(Negate(is.null), values)
    if (all(scalar) && length(present)) {
      types <- unique(vapply(present, typeof, character(1)))
      type <- if (all(types %in% c("integer", "double"))) "double" else if (length(types) == 1L) types else NULL
      if (!is.null(type)) {
        missing <- switch(type, double = NA_real_, logical = NA, character = NA_character_)
        return(vapply(values, function(value) if (is.null(value)) missing else value, missing))
      }
    }
    if (all(vapply(values, named_record, logical(1)))) {
      nested <- blsd_json_rows(values)
      if (is.data.frame(nested)) return(nested)
    }
    # Uniform multi-value intervals can also be encoded column-wise. Keep
    # null or unequal-length intervals on the original list path.
    lengths <- lengths(values)
    if (lengths[1] > 1L && all(lengths == lengths[1]) &&
        all(vapply(values, function(value) is.atomic(value) && is.null(attributes(value)) &&
          typeof(value) %in% c("integer", "double", "logical", "character"), logical(1)))) {
      types <- unique(vapply(values, typeof, character(1)))
      if (length(types) == 1L || all(types %in% c("integer", "double"))) return(I(do.call(rbind, values)))
    }
    I(values)
  })
  names(columns) <- fields
  structure(columns, class = "data.frame", row.names = .set_row_names(length(rows)))
}
blsd_json_view <- function(result) {
  for (field in c("points", "residuals", "cohortSmooth"))
    if (is.list(result[[field]]) && !is.object(result[[field]])) result[field] <- list(blsd_json_rows(result[[field]]))
  for (field in c("ageSections", "timeTrends")) if (is.list(result[[field]]))
    for (rows in c("points", "observed")) if (is.list(result[[field]][[rows]]) && !is.object(result[[field]][[rows]]))
      result[[field]][rows] <- list(blsd_json_rows(result[[field]][[rows]]))
  result
}

blsd_main <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) != 2L) stop("Two adapter file arguments are required.")
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    writeLines('{"error":{"code":"R_PACKAGES_MISSING","message":"The R JSON dependency is unavailable."}}', args[2])
    quit(status = 2L)
  }
  result <- tryCatch(fit_blsd_web(jsonlite::fromJSON(args[1], simplifyVector = TRUE)),
    error = function(e) list(error = list(code = if (inherits(e, "blsd_error")) e$code else "FIT_FAILED",
                                        message = if (inherits(e, "blsd_error")) conditionMessage(e) else "The R model could not fit these data and settings.")))
  if (is.null(result$error)) {
    snapshot <- attr(result, "reproducibility")
    attr(result, "reproducibility") <- NULL
    saveRDS(c(snapshot, list(result = result)), file.path(dirname(args[2]), "fit.rds"))
  }
  jsonlite::write_json(blsd_json_view(result), args[2], auto_unbox = TRUE, null = "null", na = "null", digits = 15, pretty = FALSE)
  if (!is.null(result$error)) quit(status = 2L)
}

if (sys.nframe() == 0L) blsd_main()
