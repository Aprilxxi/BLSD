# Run from the project root. Optional arguments: request.json [retained-fit.rds].
# The default fixtures need only this project and its normal R dependencies.
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) <= 2L)
before <- new.env(parent = globalenv())
after <- new.env(parent = globalenv())
sys.source("server/blsd_adapter.R", envir = before)
sys.source("server/blsd_adapter.R", envir = after)
fresh_derivative <- before$blsd_derivative
before$blsd_derivative <- function(model, grid, variable, domain, h, order = 1L, base_lpmatrix = NULL) {
  fresh_derivative(model, grid, variable, domain, h, order, base_lpmatrix = NULL)
}

check_case <- function(request, label, retained = NULL) {
  set.seed(987654)
  initial_rng <- .Random.seed
  before_time <- system.time(old <- before$fit_blsd_web(request))
  old_rng <- .Random.seed
  .Random.seed <<- initial_rng
  after_time <- system.time(new <- after$fit_blsd_web(request))
  new_rng <- .Random.seed
  old_snapshot <- attr(old, "reproducibility")
  new_snapshot <- attr(new, "reproducibility")
  stopifnot(identical(old_rng, new_rng))
  for (key in c("beta", "betaDraws", "covariance", "predictionGrid", "observedData")) {
    stopifnot(identical(old_snapshot[[key]], new_snapshot[[key]]))
    if (!is.null(retained)) stopifnot(identical(new_snapshot[[key]], retained[[key]]))
  }
  model <- new_snapshot$fittedModel
  for (key in names(old_snapshot$fittedModel))
    if (is.numeric(old_snapshot$fittedModel[[key]]) || is.matrix(old_snapshot$fittedModel[[key]]))
      stopifnot(identical(old_snapshot$fittedModel[[key]], model[[key]]))
  ages <- range(new_snapshot$predictionGrid$Age_Mid)
  years <- range(new_snapshot$predictionGrid$Year)
  nd <- expand.grid(Age_Mid = c(ages[1], mean(ages), ages[2]),
    Year = c(years[1], mean(years), years[2]), KEEP.OUT.ATTRS = FALSE)
  nd$Pop <- 1
  base <- predict(model, newdata = nd, type = "lpmatrix")
  for (variable in c("Year", "Age_Mid")) {
    domain <- range(nd[[variable]])
    h <- min(0.01, diff(domain) / 10)
    zero_shift <- nd
    zero_shift[[variable]] <- zero_shift[[variable]] + 0 * h
    stopifnot(identical(nd, zero_shift), identical(base, predict(model, newdata = zero_shift, type = "lpmatrix")))
    for (order in 1:2) {
      legacy <- before$blsd_derivative(model, nd, variable, domain, h, order)
      compatible <- after$blsd_derivative(model, nd, variable, domain, h, order)
      reused <- after$blsd_derivative(model, nd, variable, domain, h, order, base_lpmatrix = base)
      stopifnot(identical(legacy, compatible), identical(legacy, reused))
    }
  }
  attr(old, "reproducibility") <- NULL
  attr(new, "reproducibility") <- NULL
  stopifnot(identical(old, new))
  if (!is.null(retained)) stopifnot(identical(new, retained$result))
  snapshot_file <- tempfile("blsd-basis-reuse-", fileext = ".rds")
  on.exit(unlink(snapshot_file), add = TRUE)
  saveRDS(c(new_snapshot, list(result = new)), snapshot_file)
  roundtrip <- readRDS(snapshot_file)
  stopifnot(identical(roundtrip$result, new))
  for (key in c("beta", "betaDraws", "covariance", "predictionGrid", "observedData"))
    stopifnot(identical(roundtrip[[key]], new_snapshot[[key]]))
  cat(label, ": full result, stencils, matrices, RDS and RNG identical; fresh=",
    before_time[["elapsed"]], "s, reused=", after_time[["elapsed"]], "s\n", sep = "")
}

if (length(args)) {
  request <- jsonlite::fromJSON(args[1], simplifyVector = TRUE)
  retained <- if (length(args) == 2L) readRDS(args[2]) else NULL
  check_case(request, "Provided fixture", retained)
} else {
  rows <- expand.grid(Year = 2000:2007, Age_Mid = seq(30, 70, by = 5), KEEP.OUT.ATTRS = FALSE)
  rows$Pop <- 180000 + (rows$Age_Mid - 30) * 1400
  yi <- rows$Year - 2000; ai <- (rows$Age_Mid - 30) / 5
  rows$Count <- round(rows$Pop * exp(-8 + 0.065 * (rows$Age_Mid - 30) - 0.02 * yi) *
    (1 + 0.11 * sin(yi * 1.8 + ai * 1.2)))
  for (method in c("quasi-gcv", "quasi-reml", "nb-reml")) {
    request <- list(rows = rows, settings = list(method = method, draws = 100L, seed = 123L,
      kAge = 4L, kYear = 4L, threshold = 0.005), gridOptions = list(maxAgePoints = 15L, maxYearPoints = 8L))
    check_case(request, method)
  }
}
