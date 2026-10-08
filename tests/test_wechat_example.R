# Verify that the public demonstration reproduces the original WeChat example.
# The independent reference below contains only its simulation specification;
# it never sources the original analysis script or any private-data workflow.

script_arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
if (!length(script_arg)) stop("Run this file with Rscript.")
script_path <- normalizePath(sub("^--file=", "", script_arg[1L]), mustWork = TRUE)
repo_dir <- dirname(dirname(script_path))
source(file.path(repo_dir, "R", "wechat_example.R"), local = TRUE)

assert <- function(ok, message) {
  if (!isTRUE(ok)) stop(message, call. = FALSE)
}

reference_wechat_example <- function(seed) {
  set.seed(seed)
  years <- 1990:2019
  age_starts <- seq(0, 85, by = 5)
  age_groups <- paste0(age_starts, "-", age_starts + 4)
  age_groups[length(age_groups)] <- "85+"
  reference <- expand.grid(Year = years, Age_Group = age_groups)
  reference$Age_Mid <- rep(c(seq(2.5, 82.5, by = 5), 90), each = length(years))
  reference$Pop <- round(runif(nrow(reference), 10000, 50000) *
                           (1 + (reference$Age_Mid / 100)^2))
  time_index <- reference$Year - 1990
  baseline <- -12 + 0.12 * reference$Age_Mid
  period <- -0.02 * time_index
  interaction <- 0.0005 * reference$Age_Mid * time_index
  noise <- rnorm(nrow(reference), 0, 0.05)
  rebound <- ifelse(reference$Age_Mid < 50 & reference$Year > 2010,
                    0.05 * (reference$Year - 2010), 0)
  reference$Rate_True <- exp(baseline + period - interaction + rebound + noise)
  reference$Deaths <- rpois(nrow(reference), reference$Pop * reference$Rate_True)
  reference$Mortality_Rate <- reference$Deaths / reference$Pop * 100000
  reference
}

for (seed in c(123L, 42L)) {
  reference <- reference_wechat_example(seed)
  actual <- simulate_wechat_example(seed = seed)
  expected_columns <- c("Year", "Age_Group", "Age_Mid", "Pop", "Rate_True",
                        "Deaths", "Mortality_Rate")
  assert(is.data.frame(actual), "Simulation must return a data frame.")
  assert(all(expected_columns %in% names(actual)), "Original simulation columns are missing.")
  assert(nrow(actual) == 540L, "The original example must have 540 observed cells.")
  assert(length(unique(actual$Age_Mid)) == 18L &&
           identical(sort(unique(actual$Year)), 1990:2019),
         "The example must contain 18 age groups and all 30 original years.")
  assert(!anyDuplicated(actual[c("Year", "Age_Mid")]), "Age-year cells must be unique.")
  assert(identical(as.character(actual$Age_Group), as.character(reference$Age_Group)),
         "Age-group order differs from the original example.")
  for (column in setdiff(expected_columns, "Age_Group")) {
    assert(isTRUE(all.equal(actual[[column]], reference[[column]],
                            tolerance = 0, check.attributes = FALSE)),
           paste("Original simulation values differ for", column, "at seed", seed))
  }
  assert(all(actual$Age_Mid[as.character(actual$Age_Group) == "85+"] == 90),
         "The original 85+ demonstration assumption must be labelled at age 90.")
  assert(all(actual$Pop > 0) && all(actual$Deaths >= 0) &&
           all(actual$Deaths == round(actual$Deaths)), "Invalid simulated count/exposure values.")
  message("PASS: original simulation exactly reproduced for seed ", seed, ".")
}
message("WeChat example provenance checks passed.")
