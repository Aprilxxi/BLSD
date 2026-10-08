# Simulated demonstration. The runner never reads the real-data report folders.
parse_blsd_demo_args <- function(args) {
  settings <- list(draws = 1000L, seed = 123L, age_step = 1,
                   output = "outputs/demo", help = FALSE)
  for (arg in args) {
    if (arg %in% c("--help", "-h")) { settings$help <- TRUE; next }
    if (!grepl("^--(draws|seed|age-step|output)=", arg)) {
      stop("Unknown argument: ", arg, call. = FALSE)
    }
    key <- sub("^--([^=]+)=.*$", "\\1", arg)
    value <- sub("^--[^=]+=", "", arg)
    if (key == "output") {
      if (!nzchar(value)) stop("output must not be empty.", call. = FALSE)
      settings$output <- value
    } else {
      number <- suppressWarnings(as.numeric(value))
      if (length(number) != 1L || !is.finite(number)) {
        stop("Invalid numeric argument: ", arg, call. = FALSE)
      }
      if (key == "age-step") {
        if (number <= 0 || number > 5) {
          stop("age-step must be greater than 0 and at most 5.", call. = FALSE)
        }
        settings$age_step <- number
      } else {
        if (number != floor(number) || number < 0 ||
            number > .Machine$integer.max ||
            (key == "draws" && number < 20)) {
          stop("draws must be an integer >= 20; seed must be a nonnegative integer.",
               call. = FALSE)
        }
        settings[[key]] <- as.integer(number)
      }
    }
  }
  settings
}

run_blsd_demo <- function(root, args = character()) {
  settings <- parse_blsd_demo_args(args)
  if (settings$help) {
    cat("BLSD simulated example\n",
        "Rscript BLSD_Model_Analysis.R [--draws=1000] [--seed=123]",
        " [--age-step=1] [--output=outputs/demo]\n", sep = "")
    return(invisible(NULL))
  }
  dependencies <- c("mgcv", "ggplot2", "gridExtra")
  missing <- dependencies[!vapply(dependencies, requireNamespace,
                                  logical(1), quietly = TRUE)]
  if (length(missing)) {
    stop("Missing packages: ", paste(missing, collapse = ", "),
         ". Run Rscript install_dependencies.R first.", call. = FALSE)
  }
  source(file.path(root, "R", "blsd_models.R"), encoding = "UTF-8")
  source(file.path(root, "R", "wechat_example.R"), encoding = "UTF-8")
  source(file.path(root, "R", "blsd_plotting.R"), encoding = "UTF-8")
  output_dir <- settings$output
  if (!grepl("^([A-Za-z]:[/\\\\]|/|\\\\\\\\)", output_dir)) {
    output_dir <- file.path(root, output_dir)
  }
  dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
  dir.create(file.path(output_dir, "tables"), recursive = TRUE, showWarnings = FALSE)
  dir.create(file.path(output_dir, "figures"), recursive = TRUE, showWarnings = FALSE)
  output_dir <- normalizePath(output_dir, winslash = "/", mustWork = TRUE)
  csv <- function(x, name) {
    write.csv(x, file.path(output_dir, "tables", paste0(name, ".csv")),
              row.names = FALSE, na = "", fileEncoding = "UTF-8")
  }

  cat("[1/6] Reproducing the original simulated data...\n")
  data <- simulate_wechat_example(settings$seed)
  csv(data, "simulated_data")
  cat("[2/6] Fitting the negative-binomial age-period surface...\n")
  fit <- fit_blsd_s(data, k_age = 10L, k_period = 10L, family = "nb")
  ages <- sort(unique(c(seq(min(data$Age_Mid), max(data$Age_Mid),
                            by = settings$age_step), data$Age_Mid)))
  prediction <- predict_blsd_s(fit, ages = ages, years = 1990:2019,
                               n_draws = settings$draws, seed = settings$seed)
  cat("[3/6] Deriving interval and continuous fields...\n")
  discrete_fields <- derive_blsd_fields(prediction, min_abs_age_gradient = 0.005)
  continuous_fields <- derive_blsd_continuous_fields(
    fit, prediction, h_age = 0.01, h_year = 0.01,
    min_abs_age_gradient = 0.005
  )
  # Transform each draw first. exp(mean(g)) is not mean(exp(g)).
  # These are local one-year approximations, not exact finite-age contrasts.
  transformed <- list(
    age_gradient_percent = summarize_draw_matrix(
      100 * expm1(continuous_fields$draws$age_gradient),
      prediction$grid, "Age_Change_Pct"),
    velocity_percent = summarize_draw_matrix(
      100 * expm1(continuous_fields$draws$velocity),
      prediction$grid, "Annual_Change_Pct")
  )
  cat("[4/6] Projecting the same draws onto the constrained APC structure...\n")
  apc <- decompose_blsd_apc(prediction, df_age = 6L, df_period = 6L,
                          df_cohort = 8L)
  csv(prediction$rate_summary, "surface")
  for (name in c("velocity", "acceleration", "age_gradient", "iso_risk_velocity")) {
    csv(discrete_fields[[name]], paste0("interval_", name))
    csv(continuous_fields[[name]], paste0("continuous_", name))
  }
  csv(transformed$age_gradient_percent, "age_gradient_percent")
  csv(transformed$velocity_percent, "velocity_percent")
  csv(apc$summary, "apc_components")
  csv(apc$drift_summary, "apc_drift")
  csv(apc$diagnostics$per_draw, "apc_draw_checks")
  csv(continuous_fields$diagnostics$stencil, "derivative_stencils")
  fitted_counts <- stats::fitted(fit$model)
  count_diagnostics <- data
  count_diagnostics$Fitted_Deaths <- fitted_counts
  count_diagnostics$Fitted_Rate <- fitted_counts / data$Pop * 100000
  count_diagnostics$Pearson_Residual <- stats::residuals(fit$model, type = "pearson")
  count_diagnostics$Deviance_Residual <- stats::residuals(fit$model, type = "deviance")
  count_diagnostics$Cohort <- data$Year - data$Age_Mid
  csv(count_diagnostics, "count_diagnostics")

  metrics <- data.frame(
    Metric = c("Observed_Cells", "Prediction_Cells", "Draws", "Data_Seed",
               "Coefficient_Seed", "NB_Theta", "Smooth_EDF",
               "Design_Rank", "Design_Columns", "Design_Condition_Number",
               "Max_Reconstruction_Error", "Max_Normalized_Residual_Crossproduct",
               "Min_Iso_Effective_Draw_Fraction"),
    Value = c(nrow(data), nrow(prediction$grid), prediction$n_draws,
              settings$seed, settings$seed, fit$model$family$getTheta(TRUE),
              sum(fit$model$edf), apc$diagnostics$design_rank,
              apc$diagnostics$design_columns,
              apc$diagnostics$design_condition_number,
              max(apc$diagnostics$per_draw$Max_Abs_Reconstruction_Error),
              max(apc$diagnostics$per_draw$Max_Normalized_Residual_Crossproduct),
              min(continuous_fields$iso_risk_velocity$Effective_Draw_Fraction))
  )
  csv(metrics, "summary_metrics")
  capture.output(summary(fit$model),
                 file = file.path(output_dir, "tables", "model_summary.txt"))
  capture.output(mgcv::concurvity(fit$model, full = TRUE),
                 file = file.path(output_dir, "tables", "concurvity.txt"))

  cat("[5/6] Rendering the figure collection...\n")
  figure_manifest <- make_blsd_demo_figures(
    data, fit, prediction, discrete_fields, continuous_fields,
    apc, transformed, output_dir
  )
  csv(figure_manifest, "figure_manifest")
  cat("[6/6] Saving reproducible results and session information...\n")
  result <- list(
    data = data, fit = fit, prediction = prediction,
    discrete_fields = discrete_fields,
    continuous_fields = continuous_fields,
    apc = apc, transformed = transformed,
    settings = settings, figure_manifest = figure_manifest
  )
  saveRDS(result, file.path(output_dir, "demo_result.rds"), compress = "gzip")
  capture.output(sessionInfo(), file = file.path(output_dir, "tables", "session_info.txt"))
  cat("Completed: ", nrow(figure_manifest), " figures (PNG and PDF)\n",
      "Output directory: ", output_dir, "\n", sep = "")
  invisible(result)
}
