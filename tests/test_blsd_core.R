source(file.path("R", "blsd_models.R"))

# Parse every shipped R script, including this test. Check executable symbols
# and argument names, rather than words in comments or the example's cohort
# diagnostic. The surface-only release must not call the removed projection.
released_scripts <- list.files(".", pattern = "\\.R$", full.names = TRUE,
                               recursive = TRUE, ignore.case = TRUE)
removed_symbols <- c(paste0("decompose_blsd_", "a", "pc"),
                     paste0("orthogonal_", "curvature_basis"), paste0("a", "pc"))
for (path in released_scripts) {
  symbols <- all.names(parse(path, encoding = "UTF-8"), functions = TRUE, unique = TRUE)
  unexpected <- intersect(tolower(symbols), removed_symbols)
  if (length(unexpected)) stop("Removed projection symbol in ", path, ": ",
                               paste(unexpected, collapse = ", "))
}
stopifnot(identical(blsd_core_version, "2.1.2-s-only-20261009"))

# Deterministic posterior draws from a surface with known derivatives:
# eta(a, t) = 0.05*a - 0.02*t0 + 0.001*t0^2, where t0 = t - 2000.
ages <- seq(30, 70, by = 5)
years <- 2000:2010
grid <- expand.grid(
  Age_Mid = ages,
  Year = years,
  KEEP.OUT.ATTRS = FALSE,
  stringsAsFactors = FALSE
)
t0 <- grid$Year - 2000
eta <- 0.05 * grid$Age_Mid - 0.02 * t0 + 0.001 * t0^2
n_draws <- 20L

prediction <- structure(
  list(
    grid = grid,
    ages = ages,
    years = years,
    eta_draws = matrix(eta, nrow = nrow(grid), ncol = n_draws),
    rate_draws = matrix(exp(eta), nrow = nrow(grid), ncol = n_draws),
    n_draws = n_draws,
    rate_scale = 1
  ),
  class = "blsd_prediction"
)

fields <- derive_blsd_fields(prediction, min_abs_age_gradient = 1e-8)

# A quadratic time trend has a constant annual second difference of 0.002.
stopifnot(max(abs(fields$acceleration$Acceleration - 0.002)) < 1e-10)

# The central age gradient is exactly 0.05.
stopifnot(max(abs(fields$age_gradient$Age_Gradient - 0.05)) < 1e-10)

expect_error <- function(expr) stopifnot(inherits(try(force(expr), silent = TRUE), "try-error"))
make_prediction <- function(ages, years, fun, ndraw = 20L) {
  g <- expand.grid(Age_Mid = ages, Year = years, KEEP.OUT.ATTRS = FALSE)
  e <- fun(g$Age_Mid, g$Year)
  structure(list(grid = g, ages = ages, years = years,
    eta_draws = matrix(e, nrow(g), ndraw), n_draws = ndraw), class = "blsd_prediction")
}

# Unequal grids: local quadratic derivatives must target the displayed age;
# the interval denominator must align with the temporal slope, not its endpoint.
irregular <- make_prediction(c(30, 32, 37, 44, 52), c(2000, 2001, 2003, 2006, 2010),
  function(a, t) 0.001 * a^2 + 0.003 * a * (t - 2000) + 0.002 * (t - 2000)^2)
irfields <- derive_blsd_fields(irregular)
stopifnot(max(abs(irfields$age_gradient$Age_Gradient -
  (0.002 * irfields$age_gradient$Age_Mid + 0.003 * (irfields$age_gradient$Year - 2000)))) < 1e-10)
stopifnot(max(abs(irfields$acceleration$Acceleration - 0.004)) < 1e-10)
iso <- irfields$iso_risk_velocity
expected_iso <- -(0.003 * iso$Age_Mid + 0.004 * (iso$Interval_Midpoint - 2000)) /
  (0.002 * iso$Age_Mid + 0.003 * (iso$Interval_Midpoint - 2000))
stopifnot(max(abs(iso$Iso_Risk_Velocity - expected_iso)) < 1e-10,
          all(iso$Gradient_Year == iso$Interval_Midpoint),
          all(irfields$velocity$Year == irfields$velocity$Interval_End))

# Zero and threshold-small denominators are explicitly suppressed. All-invalid
# cells remain NA with zero retained draws, and mixed cells report fractions.
flat <- make_prediction(ages, years, function(a, t) 0.01 * (t - 2000))
flatfields <- derive_blsd_fields(flat)
stopifnot(all(is.na(flatfields$iso_risk_velocity$Iso_Risk_Velocity)),
          !any(is.nan(flatfields$iso_risk_velocity$Iso_Risk_Velocity)),
          all(flatfields$iso_risk_velocity$Effective_Draw_Fraction == 0))
small_gradient <- make_prediction(ages, years,
  function(a, t) 0.003 * a - 0.01 * (t - 2000))
screened <- derive_blsd_fields(small_gradient)$iso_risk_velocity
stopifnot(all(is.na(screened$Iso_Risk_Velocity)),
          all(screened$Effective_Draw_N == 0))
half_retained <- small_gradient
half_retained$eta_draws[, 1:10] <- matrix(
  0.007 * half_retained$grid$Age_Mid - 0.01 * (half_retained$grid$Year - 2000),
  nrow(half_retained$grid), 10L)
screened <- derive_blsd_fields(half_retained)$iso_risk_velocity
stopifnot(max(abs(screened$Iso_Risk_Velocity - 0.01/0.007)) < 1e-10,
          all(screened$Effective_Draw_N == 10),
          all(screened$Effective_Draw_Fraction == 0.5))
mixed <- summarize_draw_matrix(matrix(c(1, NA, Inf, 3, NA, -Inf), nrow = 2),
                               data.frame(Cell = 1:2), "Value")
stopifnot(identical(mixed$Value_valid_n, c(1, 1)),
          all(mixed$Value_valid_fraction == 1/3), all(mixed$Value == c(1, 3)))
bad <- irregular
bad$grid <- bad$grid[rev(seq_len(nrow(bad$grid))), ]
expect_error(derive_blsd_fields(bad))
expect_error(derive_blsd_fields(irregular, min_abs_age_gradient = 0))
expect_error(validate_blsd_axis(c(1, NA_real_), "ages"))
expect_error(validate_blsd_axis(c(1, 1), "ages"))
expect_error(validate_blsd_axis(numeric(), "ages"))
expect_error(validate_blsd_scalar(20.5, "n_draws", 20, integer = TRUE))

# Analytical polynomial prediction matrix tests the entire continuous derivative
# path, including both observed boundaries and draw-wise uncertainty alignment.
(function() {
predict.blsd_test_polynomial <- function(object, newdata, type, ...) {
  a <- newdata$Age_Mid
  t <- newdata$Year - 2000
  cbind(1, a, a^2, t, t^2, a*t)
}
coef.blsd_test_polynomial <- function(object, ...) object$coefficients
# Register mock methods explicitly so sys.source(..., envir=isolated_env) also
# exercises the methods. Restore the dispatch table on every exit.
dispatch <- get(".__S3MethodsTable__.", envir=asNamespace("stats"))
method_names <- c("predict.blsd_test_polynomial", "coef.blsd_test_polynomial")
previous_methods <- lapply(method_names, function(nm) get0(nm, envir=dispatch, inherits=FALSE))
on.exit(for (i in seq_along(method_names)) {
  if (is.null(previous_methods[[i]])) {
    if (exists(method_names[i], envir=dispatch, inherits=FALSE)) rm(list=method_names[i], envir=dispatch)
  } else assign(method_names[i], previous_methods[[i]], envir=dispatch)
}, add=TRUE)
registerS3method("predict", "blsd_test_polynomial", predict.blsd_test_polynomial, envir=asNamespace("stats"))
registerS3method("coef", "blsd_test_polynomial", coef.blsd_test_polynomial, envir=asNamespace("stats"))
poly <- structure(list(coefficients = c(Intercept=-9, a=.02, aa=.001, t=-.02, tt=.002, at=.0003)),
                  class = "blsd_test_polynomial")
polyfit <- structure(list(model=poly, data=data.frame(Age_Mid=c(30, 70), Year=c(2000, 2010))), class="blsd_s")
polygrid <- expand.grid(Age_Mid=c(30, 30.005, 40, 60, 69.995, 70),
                       Year=c(2000, 2000.005, 2004, 2009.995, 2010), KEEP.OUT.ATTRS=FALSE)
betas <- sapply(seq_len(20L), function(i) coef(poly) * (0.99 + i/1000))
polypred <- structure(list(grid=polygrid, ages=sort(unique(polygrid$Age_Mid)),
  years=sort(unique(polygrid$Year)), n_draws=20L, coefficient_draws=betas,
  eta_draws=predict(poly, polygrid, "lpmatrix") %*% betas), class="blsd_prediction")
cont <- derive_blsd_continuous_fields(polyfit, polypred)
expected_dt <- outer(rep(1, nrow(polygrid)), betas[4,]) +
  outer(2*(polygrid$Year-2000), betas[5,]) + outer(polygrid$Age_Mid, betas[6,])
expected_da <- outer(rep(1, nrow(polygrid)), betas[2,]) +
  outer(2*polygrid$Age_Mid, betas[3,]) + outer(polygrid$Year-2000, betas[6,])
expected_dtt <- outer(rep(2, nrow(polygrid)), betas[5,])
stopifnot(max(abs(cont$draws$velocity-expected_dt)) < 1e-8,
          max(abs(cont$draws$age_gradient-expected_da)) < 1e-8,
          max(abs(cont$draws$acceleration-expected_dtt)) < 1e-7,
          max(abs(cont$draws$iso_risk_velocity+expected_dt/expected_da)) < 1e-7,
          all(c("forward", "backward", "central") %in% cont$diagnostics$stencil$Year_Method))
missing_beta <- polypred
missing_beta$coefficient_draws <- NULL
expect_error(derive_blsd_continuous_fields(polyfit, missing_beta))
wrong_beta <- polypred
wrong_beta$coefficient_draws <- betas+1
expect_error(derive_blsd_continuous_fields(polyfit, wrong_beta))
expect_error(derive_blsd_continuous_fields(polyfit, polypred, h_year=3))

# Guard materially indefinite covariance instead of silently repairing a bad fit;
# only floating-point roundoff is clipped, with diagnostics.
test_model <- list(coefficients=c(a=0,b=0),Vp=diag(c(1,-0.1)))
expect_error(draw_gaussian_coefficients(test_model, 20))
test_model$Vp <- diag(c(1,-1e-12))
tiny <- draw_gaussian_coefficients(test_model, 20, seed=9)
stopifnot(attr(tiny, "covariance_diagnostics")$negative_eigenvalues_clipped == 1)
test_model$Vp <- diag(c(1, 2))
test_model$Vc <- diag(c(3, 4))
stopifnot(attr(draw_gaussian_coefficients(test_model, 20), "covariance_diagnostics")$source == "Vc")

})()

# The natural cubic temporal marginal constrains endpoint second derivatives to
# zero. Numerical cancellation must not create narrow, nonzero sign intervals.
integration_data <- expand.grid(Age_Mid=seq(30,70,by=5), Year=2000:2010,
                                KEEP.OUT.ATTRS=FALSE)
integration_data$Pop <- 100000
integration_data$Deaths <- round(integration_data$Pop * exp(-9 + .05*integration_data$Age_Mid -
  .02*(integration_data$Year-2000) + .001*(integration_data$Year-2000)^2))
integration_fit <- fit_blsd_s(integration_data,k_age=6L,k_period=6L,family="poisson")
integration_prediction <- predict_blsd_s(integration_fit,n_draws=20L,seed=41)
integration_fields <- derive_blsd_continuous_fields(integration_fit,integration_prediction)
edges <- integration_fields$acceleration$Year %in% c(2000,2010)
stopifnot(all(integration_fields$acceleration$Acceleration[edges] == 0),
          all(integration_fields$acceleration$Acceleration_lower[edges] == 0),
          all(integration_fields$acceleration$Acceleration_upper[edges] == 0),
          all(integration_fields$diagnostics$stencil$Acceleration_Roundoff_Zeroed[edges]),
          !any(integration_fields$diagnostics$stencil$Acceleration_Roundoff_Zeroed[!edges]))
integration_link <- drop(predict(integration_fit$model,integration_data,type="lpmatrix") %*%
  coef(integration_fit$model)) + log(integration_data$Pop)
stopifnot(max(abs(integration_link-predict(integration_fit$model,integration_data,type="link"))) < 1e-10)
duplicated_data <- rbind(integration_data,integration_data[1,])
expect_error(validate_blsd_data(duplicated_data))
bad_pop <- integration_data
bad_pop$Pop[1] <- 0
expect_error(validate_blsd_data(bad_pop))

message("All BLSD core tests passed: offset-independent analytic surfaces; regular/unequal grids;",
        " iso-risk alignment and screening; continuous interior/boundary derivatives with shared draws;",
        " invalid-input/covariance guards; natural-spline endpoint structural-zero handling;",
        " fitted count-offset identity; all released R scripts parse and remain surface-only.")
