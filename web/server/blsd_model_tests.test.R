# Verify real mgcv diagnostics and isolate their random permutation stream.
script_arg <- grep("^--file=", commandArgs(), value = TRUE)[1]
server_dir <- dirname(normalizePath(sub("^--file=", "", script_arg), mustWork = TRUE))
source(file.path(server_dir, "blsd_adapter.R"))
near <- function(actual, expected, label) {
  if (!isTRUE(all.equal(actual, unname(expected), tolerance = 1e-12, check.attributes = FALSE))) stop(label)
}
data <- expand.grid(Year = 2000:2007, Age_Mid = seq(32.5, 72.5, by = 5))
data$Pop <- 180000 + 7000 * (data$Age_Mid - 32.5) / 5
data$Deaths <- round(data$Pop * exp(-8 + 0.065 * (data$Age_Mid - 32.5) - 0.02 * (data$Year - 2000)) *
  (1 + 0.11 * sin((data$Year - 2000) * 1.8 + (data$Age_Mid - 32.5) / 5 * 1.2))) + 0.25
full_tests <- blsd_model_tests
checked <- character()
for (method in c("quasi-gcv", "quasi-reml", "nb-reml")) {
  request <- list(rows = data,
    settings = list(method = method, draws = 100L, seed = 123L, kAge = 4L, kYear = 4L, threshold = 0.005),
    gridOptions = list(maxAgePoints = 10L, maxYearPoints = 8L))
  # Baseline runs the original numerical path with no added test calculations.
  blsd_model_tests <- function(...) list()
  set.seed(41L)
  baseline <- fit_blsd_web(request)
  baseline_rng <- .Random.seed
  blsd_model_tests <- full_tests
  set.seed(41L)
  result <- fit_blsd_web(request)
  stopifnot(identical(.Random.seed, baseline_rng))
  for (field in c("points", "residuals", "ageSections", "timeTrends", "parameters", "contours"))
    stopifnot(identical(result[[field]], baseline[[field]]))
  retained <- attr(result, "reproducibility")
  old_retained <- attr(baseline, "reproducibility")
  stopifnot(identical(retained$betaDraws, old_retained$betaDraws),
    identical(retained$beta, old_retained$beta), identical(retained$covariance, old_retained$covariance),
    identical(serialize(retained$fittedModel, NULL), serialize(old_retained$fittedModel, NULL)))
  model <- retained$fittedModel
  model_before <- serialize(model, NULL)
  summary <- summary(model)
  diagnostic <- result$diagnostics
  stopifnot(length(diagnostic$smoothTests) == nrow(summary$s.table),
    length(diagnostic$parametricTests) == nrow(summary$p.table))
  for (i in seq_len(nrow(summary$s.table))) {
    smooth <- diagnostic$smoothTests[[i]]
    stopifnot(smooth$term == rownames(summary$s.table)[i], smooth$approximate, smooth$status == "AVAILABLE",
      smooth$statisticType == if (method == "nb-reml") "Chi-sq" else "F")
    near(smooth$edf, summary$s.table[i, "edf"], "Smooth EDF differs from mgcv")
    near(smooth$referenceDf, summary$s.table[i, "Ref.df"], "Smooth reference DF differs from mgcv")
    near(smooth$statistic, summary$s.table[i, 3], "Smooth test statistic differs from mgcv")
    near(smooth$pValue, summary$s.table[i, "p-value"], "Smooth P value differs from mgcv")
  }
  for (i in seq_len(nrow(summary$p.table))) {
    parameter <- diagnostic$parametricTests[[i]]
    stopifnot(parameter$term == rownames(summary$p.table)[i], parameter$status == "AVAILABLE",
      parameter$statisticType == if (method == "nb-reml") "z" else "t")
    near(parameter$estimate, summary$p.table[i, 1], "Parametric estimate differs from mgcv")
    near(parameter$stdError, summary$p.table[i, 2], "Parametric SE differs from mgcv")
    near(parameter$statistic, summary$p.table[i, 3], "Parametric test statistic differs from mgcv")
    near(parameter$pValue, summary$p.table[i, 4], "Parametric P value differs from mgcv")
  }
  near(diagnostic$residualDf, summary$residual.df, "Residual DF differs from mgcv")
  near(diagnostic$adjustedRSquared, summary$r.sq, "Adjusted R squared differs from mgcv")
  if (method == "nb-reml") near(diagnostic$aic, stats::AIC(model), "AIC differs from retained NB model")
  else stopifnot(is.null(diagnostic$aic), is.na(stats::AIC(model)))
  RNGkind("Mersenne-Twister", "Inversion", "Rejection")
  set.seed(20261015L)
  actual_check <- mgcv::k.check(model, subsample = 5000L, n.rep = 400L)
  stopifnot(diagnostic$basisCheckStatus == "AVAILABLE")
  for (i in seq_len(nrow(actual_check))) {
    check <- diagnostic$basisChecks[[i]]
    stopifnot(check$term == rownames(actual_check)[i], check$status == "AVAILABLE",
      check$replicates == 400L, check$seed == 20261015L, check$subsample == 5000L)
    near(check$kPrime, actual_check[i, "k'"], "k prime differs from mgcv")
    near(check$edf, actual_check[i, "edf"], "Basis-check EDF differs from mgcv")
    near(check$kIndex, actual_check[i, "k-index"], "k index differs from mgcv")
    near(check$pValue, actual_check[i, "p-value"], "Basis-check P value differs from mgcv")
  }
  # Different caller RNG algorithms/seeds must give the same diagnostics and
  # each caller must recover its own exact random stream, including RNG kind.
  for (kind in c("Mersenne-Twister", "L'Ecuyer-CMRG")) {
    RNGkind(kind)
    set.seed(987L)
    before_seed <- .Random.seed
    before_kind <- RNGkind()
    repeated <- blsd_model_tests(model, summary)
    stopifnot(identical(before_seed, .Random.seed), identical(before_kind, RNGkind()),
      identical(repeated, blsd_model_tests(model, summary)),
      identical(repeated$basisChecks, diagnostic$basisChecks), identical(serialize(model, NULL), model_before))
  }
  # Missing numerical test values and failed basis checks stay unavailable;
  # they cannot become invented zero P values.
  invalid_summary <- summary
  invalid_summary$s.table[, "p-value"] <- NA_real_
  invalid_summary$p.table[, 4] <- NA_real_
  invalid_model <- model
  invalid_model$model <- invalid_model$model[FALSE, , drop = FALSE]
  unavailable <- blsd_model_tests(invalid_model, invalid_summary)
  stopifnot(unavailable$basisCheckStatus == "UNAVAILABLE",
    all(vapply(unavailable$basisChecks, function(check) is.null(check$pValue) && check$status == "UNAVAILABLE", logical(1))),
    all(vapply(unavailable$smoothTests, function(check) is.null(check$pValue) && check$status == "UNAVAILABLE", logical(1))),
    all(vapply(unavailable$parametricTests, function(check) is.null(check$pValue) && check$status == "UNAVAILABLE", logical(1))))
  checked <- c(checked, paste(method, "real smooth/parametric/basis tests, AIC availability, exact model/draw preservation: PASS"))
}
rm(".Random.seed", envir = .GlobalEnv)
stopifnot(!exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE))
invisible(blsd_model_tests(model, summary))
stopifnot(!exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE))
cat(paste(c(checked, "RNG seed absence and stream restoration: PASS"), collapse = "\n"), "\n")
