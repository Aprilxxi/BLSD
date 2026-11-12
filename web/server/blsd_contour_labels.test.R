# Portable retained-path tests: no fit, sampling, fixtures or graphics devices.
# Rscript --vanilla server/blsd_contour_labels.test.R
source("server/blsd_export.R")
checks <- 0L
check <- function(value, message) {
  if (!isTRUE(value)) stop(message)
  checks <<- checks + 1L
}
path <- function(level, x, y) list(level = level,
  points = lapply(seq_along(x), function(i) c(x[i], y[i])))

values <- c(-0, 0, -2.66666666666667, 1.28333333333333, 1000, 10000,
  1e-9, -1e-9, 1, 1 + .Machine$double.eps, 1 + 2 * .Machine$double.eps)
text <- blsd_export_contour_text(values)
check(identical(text[1:8], c("0", "0", "-2.67", "1.28", "1000", "1e4", "1e-9", "-1e-9")),
  "Common, small and signed contour levels must retain their units and sign")
check(!anyDuplicated(text[9:11]), "Adjacent floating-point levels must have distinct labels")
check(!any(grepl("%|e\\+|^-0$", text)), "Labels must not add units or negative zero")
check(identical(blsd_export_contour_text(numeric()), character()), "Empty levels must remain empty")

x <- seq(0, 100, length.out = 51L)
paths <- list(path(1.25, x, rep(30, length(x))),
  path(1.25, c(2, 3, 4), c(75, 75, 75)),
  path(-2.5, x, 70 + 0.05 * x),
  path(3.75, c(30, 31, 32), c(50, 50, 50)),
  path(5, x, rep(0.5, length(x))))
before <- serialize(paths, NULL)
set.seed(6281)
rng <- .Random.seed
labels <- blsd_export_contour_labels(paths, c(0, 100), c(0, 100))
check(identical(sort(labels$Level), c(-2.5, 1.25)), "Short and border paths must be skipped")
check(!anyDuplicated(labels$Level), "A level must have at most one label across paths")
check(all(labels$Path %in% c(1L, 3L)), "Labels must use a suitable retained path")
check(all(labels$XLow >= 2.5 & labels$XHigh <= 133.5 & labels$YLow >= 2.5 & labels$YHigh <= 93.5),
  "The complete label footprint must stay inside panel margins")
check(identical(before, serialize(paths, NULL)) && identical(rng, .Random.seed),
  "Label selection must not mutate retained paths or RNG")
check(identical(labels, blsd_export_contour_labels(paths, c(0, 100), c(0, 100))),
  "Label selection must be deterministic")
check(abs(labels$Angle[labels$Level == -2.5] - atan(0.05 * 96 / 136) * 180 / pi) < 1e-8,
  "Tangent angles must account for the physical panel aspect ratio")
check(identical(blsd_export_contour_labels(list(), c(0, 100), c(0, 100))$Label, character()),
  "No retained contours must produce no labels")

crowded <- lapply(seq_len(20), function(i) path(i, x, rep(45 + i / 10, length(x))))
sparse <- blsd_export_contour_labels(crowded, c(0, 100), c(0, 100))
check(nrow(sparse) <= 6L, "Label count must be bounded")
if (nrow(sparse) > 1L) for (i in 2:nrow(sparse)) for (j in seq_len(i - 1L))
  check(!(sparse$XLow[i] < sparse$XHigh[j] + 2 && sparse$XHigh[i] > sparse$XLow[j] - 2 &&
    sparse$YLow[i] < sparse$YHigh[j] + 2 && sparse$YHigh[i] > sparse$YLow[j] - 2),
    "Label footprints must not overlap")

spread <- blsd_export_contour_labels(lapply(seq_len(6), function(i)
  path(i, x, rep(10 + 14 * (i - 1), length(x)))), c(0, 100), c(0, 100))
check(nrow(spread) == 6L && diff(range(spread$Year)) > 25,
  "Labels on parallel contours must be staggered rather than forming a middle column")
gap <- data.frame(Year = 50, Age = 50, Label = "1", Angle = 0, Level = 1)
straight <- list(path(1, c(0, 100), c(50, 50)))
original <- serialize(straight, NULL)
clipped <- blsd_export_contour_paths(straight, gap, c(0, 100), c(0, 100), c(100, 100))
check(isTRUE(all.equal(clipped$Year, c(0, 48.2, 51.8, 100), tolerance = 1e-14)) &&
  identical(clipped$Path, c(1L, 1L, 2L, 2L)),
  "A segment crossing a label must be split even if both retained endpoints are outside")
check(identical(original, serialize(straight, NULL)), "Display clipping must not mutate retained contours")
unclipped <- blsd_export_contour_paths(straight, gap[FALSE, ], c(0, 100), c(0, 100), c(100, 100))
check(identical(unclipped$Year, c(0, 100)) && identical(unclipped$Age, c(50, 50)),
  "Without labels, display paths must preserve all original endpoints")
other <- gap
other$Age <- 80
check(identical(unclipped, blsd_export_contour_paths(straight, other,
  c(0, 100), c(0, 100), c(100, 100))), "Labels away from a line must not alter it")
overlap <- rbind(gap, transform(gap, Year = 52))
merged <- blsd_export_contour_paths(straight, overlap, c(0, 100), c(0, 100), c(100, 100))
check(isTRUE(all.equal(merged$Year, c(0, 48.2, 53.8, 100), tolerance = 1e-14)),
  "Overlapping label gaps must merge without introducing a bridging segment")
turned <- gap
turned$Angle <- 45
diagonal <- blsd_export_contour_paths(list(path(1, c(0, 100), c(0, 100))), turned,
  c(0, 100), c(0, 100), c(100, 100))
check(isTRUE(all.equal(diagonal$Year, c(0, 50 - 1.8 / sqrt(2), 50 + 1.8 / sqrt(2), 100), tolerance = 1e-14)) &&
  identical(diagonal$Year, diagonal$Age), "Gaps must follow the rotated label rectangle")
check(nrow(blsd_export_contour_paths(list(path(1, c(49, 51), c(50, 50))), gap,
  c(0, 100), c(0, 100), c(100, 100))) == 0L, "A fully covered segment must disappear from display only")
check(identical(unclipped, blsd_export_contour_paths(straight, transform(gap, Level = 2),
  c(0, 100), c(0, 100), c(100, 100))), "Only paths with the labelled level may be clipped")

if (requireNamespace("ggplot2", quietly = TRUE) && requireNamespace("scales", quietly = TRUE)) {
  grid <- expand.grid(year = c(0, 100), age = c(0, 100))
  fit <- list(points = lapply(seq_len(nrow(grid)), function(i)
    list(year = grid$year[i], age = grid$age[i], surface = i, annual = i - 2)),
    grid = list(years = c(0, 100), ages = c(0, 100)), contours = list(surface = paths, annual = paths))
  for (metric in c("surface", "annual")) {
    settings <- list(metric = metric, locale = "en", widthMm = 180, dpi = 600)
    on <- blsd_export_plot(fit, settings)$plot
    settings$showContours <- FALSE
    off <- blsd_export_plot(fit, settings)$plot
    has_geom <- function(p, name) any(vapply(p$layers,
      function(layer) inherits(layer$geom, name), logical(1)))
    check(has_geom(on, "GeomPath") && has_geom(on, "GeomText"),
      paste(metric, "must show retained paths and labels together"))
    check(!has_geom(off, "GeomPath") && !has_geom(off, "GeomText"),
      paste(metric, "must hide both paths and labels when disabled"))
    check(!has_geom(on, "GeomLabel"), paste(metric, "must not draw rectangular label backings"))
    check(identical(on$data, off$data) && identical(on$coordinates$limits, off$coordinates$limits),
      paste(metric, "contour switches must preserve field data and axes"))
    built <- ggplot2::ggplot_build(on)
    label_index <- which(vapply(on$layers, function(layer) inherits(layer$geom, "GeomText"), logical(1)))
    label_data <- built$data[[label_index]]
    check(length(unique(label_data$colour)) == 1L &&
      all(label_data$colour == if (metric == "surface") "#ffffff" else "#333333"),
      paste(metric, "labels must use one uniform colour across every retained level"))
    glyphs <- on$layers[[label_index]]$geom$draw_panel(label_data,
      built$layout$panel_params[[1]], built$layout$coord)
    check(inherits(glyphs, "text") && is.null(glyphs$children),
      paste(metric, "must draw one native text grob without any halo or backing"))
    check(identical(as.character(glyphs$label), as.character(label_data$label)) &&
      identical(glyphs$rot, label_data$angle), paste(metric, "must preserve plain labels and rotation"))
  }
} else stop("This test requires the runtime ggplot2 and scales packages")
cat(sprintf("PASS: %d contour label assertions\n", checks))
