# JSON representation checks; no fitting, prediction or coefficient sampling.
script_arg <- grep("^--file=", commandArgs(), value = TRUE)[1]
server_dir <- dirname(normalizePath(sub("^--file=", "", script_arg), mustWork = TRUE))
source(file.path(server_dir, "blsd_adapter.R"))

encode <- function(value) jsonlite::toJSON(value, auto_unbox = TRUE, null = "null",
  na = "null", digits = 15, pretty = FALSE)
checked <- 0L
check <- function(value, label) {
  before <- serialize(value, NULL)
  set.seed(123L)
  rng <- .Random.seed
  view <- blsd_json_view(value)
  original_json <- encode(value)
  candidate_json <- encode(view)
  expected <- jsonlite::fromJSON(original_json, simplifyVector = FALSE)
  actual <- jsonlite::fromJSON(candidate_json, simplifyVector = FALSE)
  if (!identical(expected, actual)) stop(paste("JSON representation changed:", label))
  stopifnot(identical(serialize(value, NULL), before), identical(.Random.seed, rng))
  checked <<- checked + 1L
}

point <- function(value, hidden = FALSE) list(
  year = 2000L, age = 32.5, intervals = list(rate = c(0.012345678901234567, 1e20),
    shift = if (hidden) NULL else c(-1e-20, pi)), masked = hidden,
  maskReason = if (hidden) "UNSTABLE_AGE_GRADIENT" else NULL,
  metricMaskReasons = if (hidden) list(shift = "UNSTABLE_AGE_GRADIENT") else list(),
  raw = list(rate = value, shift = -value), rawIntervals = list(rate = c(NA_real_, Inf)),
  metricMasks = list(rate = FALSE, shift = hidden),
  metricValidFractions = list(rate = 1, shift = 0.999),
  rawDerivatives = list(logAnnual = value, logGradient = -value,
    intervals = list(logAnnual = c(-value, value))), rate = value,
  shift = if (hidden) NULL else -value)
result <- function(points) list(schemaVersion = "1", points = points,
  residuals = list(), ageSections = list(years = 2000L, points = points, observed = list()),
  timeTrends = list(ages = 32.5, points = points, observed = list()),
  contours = list(surface = list(), annual = list()), cohortSmooth = list(),
  meta = list(sex = "自定义组\"\\\n", optional = NULL))

check(result(list()), "empty rows and arrays")
check(list(error = list(code = "FIT_FAILED", message = "The R model could not fit these data and settings.")),
  "structured failure response")
check(result(list(point(pi))), "one row and one-element coordinate arrays")
check(result(list(point(pi), point(-1e-20, TRUE))), "mixed null masks and nested intervals")
check(result(lapply(c(0, -0, 1e-200, 1e200, -pi, NA_real_, NaN, Inf, -Inf), point)),
  "numeric precision and nonfinite values")
check(result(list(list(value = 1L, optional = NULL), list(value = 2, optional = "中文"))),
  "integer/double and optional text columns")
check(result(list(list(value = 1), list(value = 2, extra = TRUE))), "heterogeneous records")
check(result(list(list(values = c(1, 2)), list(values = 3))), "variable-length arrays")
check(result(list(list(values = c(1, 2)), list(values = c(NA_real_, Inf)))), "uniform intervals and missing bounds")
check(result(list(list(values = c("中文", "a")), list(values = c("b", "c")))), "uniform text arrays")
check(result(list(first = point(1), second = point(2))), "named record collections remain objects")
check(result(list(list(a = list()), list(a = list(x = 1)))), "empty and populated nested objects")
check(result(list(list(value = TRUE), list(value = 1))), "heterogeneous scalar types")
check(result(list(list(value = NULL, flag = NA), list(value = NULL, flag = TRUE))),
  "all-null and missing logical columns")
check(result(list(list(value = structure(1, class = "AsIs")), list(value = structure(2, class = "AsIs")))),
  "classed values")
check(list(input = data.frame(Year = c(2000L, 2001L), Sex = c("Both", "女性")),
  points = list(point(1), point(2, TRUE))), "existing data frames remain compatible")

args <- commandArgs(trailingOnly = TRUE)
if (length(args)) {
  snapshot <- readRDS(args[1])
  check(snapshot$result, "complete retained result")
}
cat(sprintf("JSON representation checks passed: %d; result objects and RNG unchanged.\n", checked))
