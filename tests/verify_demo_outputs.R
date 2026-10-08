# Inspect an already completed demonstration; never refit a model here.
# Usage: Rscript tests/verify_demo_outputs.R [output_directory]

script_arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
if (!length(script_arg)) stop("Run this file with Rscript.")
repo_dir <- dirname(dirname(normalizePath(sub("^--file=", "", script_arg[1L]), mustWork = TRUE)))
args <- commandArgs(trailingOnly = TRUE)
output_dir <- if (length(args)) args[1L] else file.path(repo_dir, "outputs", "demo")
output_dir <- normalizePath(output_dir, mustWork = TRUE)
table_dir <- file.path(output_dir, "tables")
figure_dir <- file.path(output_dir, "figures")

assert <- function(ok, message) {
  if (!isTRUE(ok)) stop(message, call. = FALSE)
}
same_numeric <- function(actual, expected, label, tolerance = 1e-9) {
  assert(identical(dim(actual), dim(expected)) && length(actual) == length(expected),
         paste(label, "has the wrong dimensions."))
  assert(identical(as.logical(is.na(actual)), as.logical(is.na(expected))),
         paste(label, "has inconsistent missing values."))
  valid <- !is.na(expected)
  assert(all(is.finite(actual[valid])) && all(is.finite(expected[valid])),
         paste(label, "contains a non-finite retained value."))
  if (any(valid)) {
    error <- max(abs(actual[valid] - expected[valid]))
    assert(error <= tolerance * max(1, max(abs(expected[valid]))),
           paste(label, "does not agree with the saved draws; maximum absolute error", error))
  }
  invisible(TRUE)
}
check_summary <- function(table, label) {
  assert(is.data.frame(table) && nrow(table) > 0L, paste(label, "is empty."))
  for (lower in grep("_lower$", names(table), value = TRUE)) {
    upper <- sub("_lower$", "_upper", lower)
    assert(upper %in% names(table), paste(label, "is missing", upper))
    assert(identical(is.na(table[[lower]]), is.na(table[[upper]])),
           paste(label, "has one-sided missing interval bounds."))
    retained <- !is.na(table[[lower]])
    assert(all(is.finite(table[[lower]][retained])) &&
             all(is.finite(table[[upper]][retained])) &&
             all(table[[lower]][retained] <= table[[upper]][retained]),
           paste(label, "has invalid interval bounds."))
  }
  bounded <- grep("(_valid_fraction$|^Effective_Draw_Fraction$|^Pr_)", names(table), value = TRUE)
  for (column in bounded) {
    retained <- !is.na(table[[column]])
    assert(all(table[[column]][retained] >= 0 & table[[column]][retained] <= 1),
           paste(label, "has values outside [0, 1] in", column))
  }
  invisible(TRUE)
}
check_draw_summary <- function(table, draws, value, label) {
  draws[!is.finite(draws)] <- NA_real_
  count <- rowSums(!is.na(draws))
  mean_value <- rowMeans(draws, na.rm = TRUE)
  mean_value[count == 0] <- NA_real_
  quantile_value <- function(probability) apply(draws, 1L, function(x) {
    if (all(is.na(x))) NA_real_ else unname(quantile(x, probability, na.rm = TRUE))
  })
  assert(all(c(value, paste0(value, "_lower"), paste0(value, "_upper")) %in% names(table)),
         paste(label, "is missing the requested summary fields."))
  same_numeric(table[[value]], mean_value, paste(label, "mean"))
  same_numeric(table[[paste0(value, "_lower")]], quantile_value(0.025), paste(label, "lower"))
  same_numeric(table[[paste0(value, "_upper")]], quantile_value(0.975), paste(label, "upper"))
  if (paste0(value, "_valid_n") %in% names(table)) {
    same_numeric(table[[paste0(value, "_valid_n")]], count, paste(label, "retained count"))
    same_numeric(table[[paste0(value, "_valid_fraction")]], count / ncol(draws),
                 paste(label, "retained fraction"))
  }
  check_summary(table, label)
  invisible(TRUE)
}

assert(dir.exists(table_dir) && dir.exists(figure_dir), "Figure/table directories are missing.")
csv_paths <- list.files(table_dir, pattern = "\\.csv$", full.names = TRUE)
png_paths <- list.files(figure_dir, pattern = "\\.png$", full.names = TRUE)
pdf_paths <- list.files(figure_dir, pattern = "\\.pdf$", full.names = TRUE)
assert(length(csv_paths) >= 10L, "The demonstration must export at least ten analysis tables.")
assert(length(png_paths) >= 13L && length(pdf_paths) >= 13L,
       "The demonstration must export its thirteen figures in PNG and PDF.")
assert(setequal(sub("\\.png$", "", basename(png_paths)),
                sub("\\.pdf$", "", basename(pdf_paths))), "PNG/PDF figure pairs do not match.")
assert(all(file.info(c(csv_paths, png_paths, pdf_paths))$size > 0), "An exported artifact is empty.")
for (path in png_paths) {
  assert(identical(readBin(path, "raw", n = 8L),
                    as.raw(c(137, 80, 78, 71, 13, 10, 26, 10))),
         paste("Invalid PNG signature:", basename(path)))
}
for (path in pdf_paths) {
  assert(identical(rawToChar(readBin(path, "raw", n = 5L)), "%PDF-"),
         paste("Invalid PDF signature:", basename(path)))
}
tables <- setNames(lapply(csv_paths, read.csv, check.names = FALSE), basename(csv_paths))
assert(all(c("figure_manifest.csv", "summary_metrics.csv") %in% names(tables)),
       "Figure manifest or summary metrics are missing.")
invisible(lapply(names(tables), function(name) check_summary(tables[[name]], name)))
manifest_values <- unlist(tables[["figure_manifest.csv"]], use.names = FALSE)
manifest_files <- as.character(manifest_values[grepl("\\.(png|pdf)$", manifest_values)])
assert(setequal(basename(manifest_files), basename(c(png_paths, pdf_paths))),
       "The figure manifest does not list every PNG and PDF artifact.")
assert(!any(grepl("^([A-Za-z]:[/\\\\]|/|\\\\\\\\)", manifest_files)),
       "The manifest must use portable relative figure paths.")

rds_path <- file.path(output_dir, "demo_result.rds")
assert(file.exists(rds_path), "Saved demonstration result is missing.")
result <- readRDS(rds_path)
required <- c("data", "fit", "prediction", "discrete_fields", "continuous_fields", "apc", "transformed")
assert(all(required %in% names(result)), "Saved demonstration result lacks required components.")
data <- result$data
assert(nrow(data) == 540L && length(unique(data$Age_Mid)) == 18L &&
         identical(sort(unique(data$Year)), 1990:2019), "Saved data differ from the original example grid.")
assert(!anyDuplicated(data[c("Age_Mid", "Year")]) && all(data$Pop > 0),
       "Saved data contain duplicate cells or invalid exposures.")
prediction <- result$prediction
assert(is.matrix(prediction$eta_draws) && is.matrix(prediction$coefficient_draws) &&
         ncol(prediction$eta_draws) == prediction$n_draws && prediction$n_draws >= 20,
       "Saved curve/coefficient draws are incomplete.")
assert(all(prediction$ages >= min(data$Age_Mid) & prediction$ages <= max(data$Age_Mid)) &&
         all(prediction$years >= min(data$Year) & prediction$years <= max(data$Year)),
       "Prediction grid extrapolates beyond the example data domain.")
grid <- expand.grid(Age_Mid = prediction$ages, Year = prediction$years,
                    KEEP.OUT.ATTRS = FALSE, stringsAsFactors = FALSE)
assert(isTRUE(all.equal(prediction$grid, grid, check.attributes = FALSE)),
       "Saved prediction grid is not complete and age-fastest ordered.")
same_numeric(prediction$rate_draws, exp(prediction$eta_draws) * prediction$rate_scale,
             "Rate-draw scaling")
check_draw_summary(prediction$rate_summary, prediction$rate_draws, "Rate", "Mortality rate")
assert(requireNamespace("mgcv", quietly = TRUE), "Install mgcv to verify coefficient reconstruction.")
newdata <- prediction$grid
newdata$Pop <- 1
eta_from_coefficients <- predict(result$fit$model, newdata = newdata, type = "lpmatrix") %*%
  prediction$coefficient_draws
same_numeric(eta_from_coefficients, prediction$eta_draws, "Coefficient/surface alignment", 1e-10)

continuous <- result$continuous_fields
for (name in c("velocity", "acceleration", "age_gradient", "iso_risk_velocity")) {
  value <- c(velocity = "Velocity", acceleration = "Acceleration", age_gradient = "Age_Gradient",
             iso_risk_velocity = "Iso_Risk_Velocity")[[name]]
  check_draw_summary(continuous[[name]], continuous$draws[[name]], value, paste("Continuous", name))
}
iso <- continuous$iso_risk_velocity
same_numeric(iso$Effective_Draw_Fraction, rowMeans(is.finite(continuous$draws$iso_risk_velocity)),
             "Continuous iso-risk retained fraction")
same_numeric(iso$Effective_Draw_N, rowSums(is.finite(continuous$draws$iso_risk_velocity)),
             "Continuous iso-risk retained count")
assert(all(is.finite(continuous$draws$iso_risk_velocity) |
             is.na(continuous$draws$iso_risk_velocity)), "Iso-risk values must not be infinite.")
expected_iso <- -continuous$draws$velocity / continuous$draws$age_gradient
expected_iso[is.na(continuous$draws$iso_risk_velocity)] <- NA_real_
same_numeric(continuous$draws$iso_risk_velocity, expected_iso, "Continuous iso-risk formula")

discrete <- result$discrete_fields
for (name in c("velocity", "acceleration", "age_gradient", "iso_risk_velocity")) {
  check_summary(discrete[[name]], paste("Discrete", name))
}
for (name in c("velocity", "iso_risk_velocity")) {
  table <- discrete[[name]]
  assert(all(table$Year == table$Interval_End) &&
           all(table$Interval_Start < table$Interval_End) &&
           all(table$Interval_Midpoint == (table$Interval_Start + table$Interval_End) / 2),
         paste("Incorrect interval labels for", name))
}
assert(all(discrete$acceleration$Interval_Start < discrete$acceleration$Center_Year &
             discrete$acceleration$Center_Year < discrete$acceleration$Interval_End) &&
         all(discrete$acceleration$Year == discrete$acceleration$Interval_End),
       "Incorrect three-year acceleration labels.")
same_numeric(discrete$iso_risk_velocity$Effective_Draw_Fraction,
             discrete$iso_risk_velocity$Effective_Draw_N / prediction$n_draws,
             "Discrete iso-risk retained fraction")

apc <- result$apc
assert(apc$diagnostics$design_rank == ncol(apc$design), "APC design is rank deficient.")
reconstruction <- Reduce(`+`, apc$component_draws)
assert(max(abs(reconstruction - prediction$eta_draws)) < 1e-10,
       "APC components fail to reconstruct the saved curve draws.")
remainder <- apc$component_draws$Residual_Dynamic_Surface
normalized_crossproduct <- sweep(crossprod(apc$design, remainder), 1L,
                                sqrt(colSums(apc$design^2)), "/")
assert(max(abs(normalized_crossproduct)) < 1e-8,
       "APC remainder is not orthogonal to the retained design for every draw.")
assert(nrow(apc$diagnostics$per_draw) == prediction$n_draws &&
         all(apc$diagnostics$per_draw$Max_Abs_Reconstruction_Error < 1e-10) &&
         all(apc$diagnostics$per_draw$Max_Normalized_Residual_Crossproduct < 1e-8),
       "Saved per-draw APC numerical diagnostics fail.")
check_summary(apc$summary, "APC components")

transformed <- result$transformed
assert(all(c("age_gradient_percent", "velocity_percent") %in% names(transformed)),
       "Converted age/year percentage summaries are missing.")
percentage_specs <- list(
  age_gradient_percent = list(draws = continuous$draws$age_gradient, value = "Age_Change_Pct"),
  velocity_percent = list(draws = continuous$draws$velocity, value = "Annual_Change_Pct")
)
for (name in names(percentage_specs)) {
  specification <- percentage_specs[[name]]
  expected_draws <- 100 * expm1(specification$draws)
  check_draw_summary(transformed[[name]], expected_draws, specification$value, name)
  assert(isTRUE(all.equal(transformed[[name]][c("Age_Mid", "Year")], grid,
                          check.attributes = FALSE)),
         paste(name, "uses an inconsistent grid."))
  candidate <- Filter(function(table) {
    specification$value %in% names(table) && nrow(table) == nrow(grid) &&
      isTRUE(all.equal(table[c("Age_Mid", "Year")], grid, check.attributes = FALSE))
  }, tables)
  assert(length(candidate) > 0L, paste(name, "was not exported to a matching CSV table."))
  invisible(lapply(seq_along(candidate), function(index) {
    check_draw_summary(candidate[[index]], expected_draws, specification$value,
                       paste(name, "CSV", index))
  }))
}
assert("remainder_mortality_multiplier.csv" %in% names(tables),
       "Remainder multiplier table is missing.")
check_draw_summary(tables[["remainder_mortality_multiplier.csv"]], exp(remainder),
                   "Mortality_Multiplier", "Remainder multiplier CSV")
assert("count_fit_diagnostics.csv" %in% names(tables), "Count diagnostics table is missing.")
count_diagnostics <- tables[["count_fit_diagnostics.csv"]]
assert(nrow(count_diagnostics) == nrow(data), "Count diagnostics must refer to observed cells.")
same_numeric(count_diagnostics$Observed_Rate,
             count_diagnostics$Deaths / count_diagnostics$Pop * prediction$rate_scale,
             "Observed rate in count diagnostics")
message("PASS: ", length(png_paths), " PNG/PDF pairs and ", length(csv_paths), " CSV tables.")
message("PASS: coefficient alignment, rate intervals, retained fractions, interval labels,",
        " every-draw APC reconstruction/orthogonality, draw-wise percentage conversion,",
        " and exported remainder mortality multipliers.")
