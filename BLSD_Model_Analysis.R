# Run with: Rscript BLSD_Model_Analysis.R
# Optional: --draws=300 --seed=123 --age-step=1 --output=outputs/demo_smoke
# All data in this example are simulated.
blsd_entry_root <- function() {
  command_file <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  if (length(command_file)) {
    return(dirname(normalizePath(sub("^--file=", "", command_file[1]),
                                 winslash = "/", mustWork = TRUE)))
  }
  for (frame in rev(sys.frames())) {
    if (!is.null(frame$ofile)) {
      return(dirname(normalizePath(frame$ofile, winslash = "/", mustWork = TRUE)))
    }
  }
  if (file.exists("R/blsd_models.R")) return(normalizePath("."))
  stop("Run this file from the BLSD directory, or source its absolute path.",
       call. = FALSE)
}
blsd_root <- blsd_entry_root()
source(file.path(blsd_root, "analysis", "run_blsd_demo.R"), encoding = "UTF-8")
blsd_demo_result <- run_blsd_demo(root = blsd_root,
                                args = commandArgs(trailingOnly = TRUE))

