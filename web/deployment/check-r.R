packages <- c("mgcv", "jsonlite", "scales", "ggplot2")
missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]
cat(R.version.string, "\n")
for (package in packages)
  cat(package, if (package %in% missing) "MISSING" else as.character(packageVersion(package)), "\n")
cat("Cairo:", isTRUE(capabilities("cairo")), "\n")
cat("TIFF:", isTRUE(capabilities("tiff")), "\n")
if (length(missing)) {
  cat("Install missing packages with: Rscript --vanilla deployment/install-r-packages.R\n")
  quit(status = 1L)
}
if (!isTRUE(capabilities("cairo"))) {
  cat("This R installation needs Cairo support for PDF, PNG and TIFF export.\n")
  quit(status = 1L)
}
if (!isTRUE(capabilities("tiff"))) {
  cat("This R installation needs libtiff support for TIFF export.\n")
  quit(status = 1L)
}
