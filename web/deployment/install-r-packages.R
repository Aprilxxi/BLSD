packages <- c("mgcv", "jsonlite", "scales", "ggplot2")
missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing)) install.packages(missing, repos = "https://cloud.r-project.org")
remaining <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]
if (length(remaining)) stop("R packages are still missing: ", paste(remaining, collapse = ", "))
cat("Required R packages are available. Run deployment/check-environment.mjs next.\n")
