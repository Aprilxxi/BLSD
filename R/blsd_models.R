# BLSD v2: Bayesian Lexis-Surface Dynamics prototypes
#
# BLSD-S   : an identifiable age-period surface model.
# BLSD-APC : a constrained posterior decomposition of the BLSD-S surface into
#            age, net-drift, period-curvature, cohort-curvature, and residual
#            dynamic-surface components.
#
# The fitting engine below is mgcv, so posterior draws are empirical-Bayesian
# Gaussian approximations based on the fitted coefficient covariance matrix.
# This file is intended as a statistically coherent prototype before a full
# state-space implementation in Stan/INLA.

required_blsd_columns <- c("Year", "Age_Mid", "Deaths", "Pop")

blsd_core_version <- "2.1.1-audit-20260911"

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

simulate_blsd_data <- function(
    years = 1990:2021,
    ages = seq(20, 85, by = 5),
    seed = 123,
    theta = 35) {
  set.seed(seed)
  data <- expand.grid(
    Year = years,
    Age_Mid = ages,
    KEEP.OUT.ATTRS = FALSE,
    stringsAsFactors = FALSE
  )
  data$Cohort <- data$Year - data$Age_Mid

  age_term <- 0.075 * (data$Age_Mid - 50) +
    0.0008 * pmax(data$Age_Mid - 65, 0)^2
  period_term <- -0.018 * (data$Year - min(years))
  cohort_scar <- 0.20 * exp(-0.5 * ((data$Cohort - 1955) / 6)^2)
  local_rebound <- 0.25 * exp(-0.5 * ((data$Age_Mid - 45) / 9)^2) *
    stats::plogis((data$Year - 2012) / 1.8)
  temporary_shock <- 0.15 * exp(-0.5 * ((data$Year - 2020) / 0.8)^2) *
    stats::plogis((data$Age_Mid - 55) / 5)

  data$Eta_True <- -8.7 + age_term + period_term + cohort_scar +
    local_rebound + temporary_shock
  data$Rate_True <- exp(data$Eta_True)

  base_pop <- 180000 * exp(-pmax(data$Age_Mid - 40, 0) / 55)
  calendar_growth <- 1 + 0.004 * (data$Year - min(years))
  data$Pop <- round(base_pop * calendar_growth * stats::runif(nrow(data), 0.85, 1.15))
  mu <- data$Pop * data$Rate_True
  data$Deaths <- stats::rnbinom(nrow(data), mu = mu, size = theta)
  data$Rate_per_100k <- data$Deaths / data$Pop * 100000
  data
}

#' Fit the primary BLSD-S model
#'
#' This estimates the complete log-rate surface eta(age, period). It does not
#' claim to uniquely separate linear age, period, and cohort effects.
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

#' Derive physically motivated BLSD fields
#'
#' These are divided differences, not continuous partial derivatives.
#' Year retains the interval END label for compatibility; metadata gives the
#' actual interval and the centre of the three-point second difference.
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

orthogonal_curvature_basis <- function(x, df, prefix) {
  validate_blsd_scalar(df, paste0(prefix, "df"), 2, integer = TRUE)
  df <- min(as.integer(df), length(unique(x)) - 2L)
  if (df < 2L) {
    stop("Insufficient unique values to construct the ", prefix, " curvature basis.", call. = FALSE)
  }
  raw <- splines::ns(x, df = df, intercept = FALSE)
  linear_space <- cbind(1, as.numeric(scale(x, center = TRUE, scale = FALSE)))
  residualized <- qr.resid(qr(linear_space), raw)
  basis_qr <- qr(residualized, tol = 1e-10)
  keep <- basis_qr$pivot[seq_len(basis_qr$rank)]
  basis <- residualized[, sort(keep), drop = FALSE]
  colnames(basis) <- paste0(prefix, seq_len(ncol(basis)))
  basis
}

#' Constrained BLSD-APC posterior decomposition
#'
#' The decomposition is applied to every BLSD-S posterior surface draw. Period
#' and cohort spline bases are constrained to contain neither a constant nor a
#' linear trend. The residual dynamic surface is orthogonal to all retained APC
#' basis columns on the requested prediction grid.
decompose_blsd_apc <- function(
    prediction,
    df_age = 6L,
    df_period = 6L,
    df_cohort = 8L) {
  validate_blsd_prediction(prediction)
  grid <- prediction$grid
  age_centered <- as.numeric(scale(grid$Age_Mid, center = TRUE, scale = FALSE))
  period_centered <- as.numeric(scale(grid$Year, center = TRUE, scale = FALSE))
  cohort <- grid$Year - grid$Age_Mid

  age_curvature <- orthogonal_curvature_basis(grid$Age_Mid, df_age, "A_curv_")
  period_curvature <- orthogonal_curvature_basis(grid$Year, df_period, "P_curv_")
  cohort_curvature <- orthogonal_curvature_basis(cohort, df_cohort, "C_curv_")

  design <- cbind(
    Intercept = 1,
    Age_linear = age_centered,
    Net_drift = period_centered,
    age_curvature,
    period_curvature,
    cohort_curvature
  )
  design_qr <- qr(design, tol = 1e-9)
  if (design_qr$rank < ncol(design)) {
    stop(
      "The requested APC basis is rank deficient on this grid. ",
      "Reduce df_age, df_period, or df_cohort.",
      call. = FALSE
    )
  }

  coefficients <- qr.coef(design_qr, prediction$eta_draws)
  coefficient_names <- rownames(coefficients)
  component_columns <- list(
    Intercept = match("Intercept", coefficient_names),
    Age = c(
      match("Age_linear", coefficient_names),
      grep("^A_curv_", coefficient_names)
    ),
    Net_Drift = match("Net_drift", coefficient_names),
    Period_Curvature = grep("^P_curv_", coefficient_names),
    Cohort_Curvature = grep("^C_curv_", coefficient_names)
  )

  component_draws <- lapply(component_columns, function(index) {
    design[, index, drop = FALSE] %*% coefficients[index, , drop = FALSE]
  })
  fitted_apc <- design %*% coefficients
  component_draws$Residual_Dynamic_Surface <- prediction$eta_draws - fitted_apc
  reconstruction_error <- apply(abs(Reduce(`+`, component_draws) - prediction$eta_draws), 2L, max)
  residual_crossproduct <- crossprod(design, component_draws$Residual_Dynamic_Surface)
  column_norms <- sqrt(colSums(design^2))
  normalized_orthogonality <- apply(abs(residual_crossproduct / column_norms), 2L, max)
  curvature_constraints <- do.call(rbind, lapply(list(
    Age = list(x = grid$Age_Mid, basis = age_curvature),
    Period = list(x = grid$Year, basis = period_curvature),
    Cohort = list(x = cohort, basis = cohort_curvature)
  ), function(z) {
    data.frame(Max_Abs_Constant_Crossproduct = max(abs(colSums(z$basis))),
      Max_Abs_Linear_Crossproduct = max(abs(crossprod(z$x - mean(z$x), z$basis))))
  }))

  summaries <- lapply(names(component_draws), function(component) {
    result <- summarize_draw_matrix(
      component_draws[[component]],
      grid,
      "Effect"
    )
    result$Component <- component
    result
  })

  structure(
    list(
      summary = do.call(rbind, summaries),
      component_draws = component_draws,
      coefficients = coefficients,
      design = design,
      grid = grid,
      diagnostics = list(
        design_rank = design_qr$rank, design_columns = ncol(design),
        design_condition_number = kappa(design, exact = TRUE),
        requested_basis_df = c(age = df_age, period = df_period, cohort = df_cohort),
        retained_curvature_columns = c(age = ncol(age_curvature), period = ncol(period_curvature), cohort = ncol(cohort_curvature)),
        curvature_constraints = curvature_constraints,
        per_draw = data.frame(Draw = seq_len(prediction$n_draws),
          Max_Abs_Reconstruction_Error = reconstruction_error,
          Max_Normalized_Residual_Crossproduct = normalized_orthogonality,
          Residual_Surface_RMS = sqrt(colMeans(component_draws$Residual_Dynamic_Surface^2))),
        projection_weight = "Equal weight for every requested age-period grid cell; cohort frequency is induced by this grid",
        projection_penalty = "None: unpenalized QR projection of the already penalized BLSD-S surface",
        core_version = blsd_core_version
      ),
      drift_summary = summarize_draw_matrix(
        coefficients[match("Net_drift", coefficient_names), , drop = FALSE],
        data.frame(Quantity = "Constrained net linear period drift; log-rate/calendar-year"), "Net_Drift"),
      constraints = c(
        "Age, period and cohort curvature bases are orthogonal to constants under equal grid-cell weights.",
        "Age, period and cohort curvature bases are orthogonal to their own linear trends under equal grid-cell weights.",
        "The residual dynamic surface is orthogonal to the retained APC design on the prediction grid.",
        "The residual dynamic surface is a log-rate projection remainder, distinct from count deviance residuals.",
        "Curvature components describe nonlinear spline contributions, not second-derivative arrays.",
        "No separately identified linear cohort trend or unique causal APC effect is claimed.",
        "Drift and nonlinear components depend on the chosen grid, dimensions and constraints; report sensitivity analyses."
      )
    ),
    class = "blsd_apc"
  )
}

plot_blsd_field <- function(
    data,
    value,
    title,
    diverging = TRUE,
    midpoint = 0) {
  check_blsd_packages()
  if (!value %in% names(data)) {
    stop(value, " is not present in data.", call. = FALSE)
  }
  mapping <- ggplot2::aes(x = Year, y = Age_Mid, fill = .data[[value]])
  plot <- ggplot2::ggplot(data, mapping) +
    ggplot2::geom_raster() +
    ggplot2::labs(x = "Year", y = "Age", title = title, fill = value) +
    ggplot2::theme_minimal(base_size = 12)
  if (diverging) {
    plot <- plot + ggplot2::scale_fill_gradient2(
      low = "#2166AC",
      mid = "white",
      high = "#B2182B",
      midpoint = midpoint
    )
  } else {
    plot <- plot + ggplot2::scale_fill_viridis_c(option = "magma")
  }
  plot
}

diagnose_blsd_s <- function(object) {
  if (!inherits(object, "blsd_s")) {
    stop("object must be returned by fit_blsd_s().", call. = FALSE)
  }
  list(
    summary = summary(object$model),
    gam_check = mgcv::gam.check(object$model, rep = 0),
    concurvity = mgcv::concurvity(object$model, full = TRUE)
  )
}
