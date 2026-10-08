# Run once before the demonstration.
packages <- c("mgcv", "ggplot2", "gridExtra")
missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing)) {
  install.packages(missing, repos = "https://cloud.r-project.org")
} else {
  message("All BLSD demonstration dependencies are already installed.")
}

