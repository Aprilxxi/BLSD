# Export the retained fit data. This script never fits or samples a model.
# Usage: Rscript --vanilla blsd_export.R fit.rds request.json figure status.json
# Batch: Rscript --vanilla blsd_export.R --batch manifest.json output-directory status.json
if (.Platform$OS.type == "windows" && !isTRUE(l10n_info()[["UTF-8"]]))
  invisible(suppressWarnings(Sys.setlocale("LC_CTYPE", "Chinese_China.utf8")))

blsd_plot_theme <- function(font, small) {
  # The supplied Figure 1–7 reference uses an open white panel, light grid,
  # compact margins and a quiet typography hierarchy (not a heavy frame).
  ggplot2::theme_minimal(base_size = if (small) 7 else 8.5, base_family = font) +
    ggplot2::theme(
      panel.grid.major = ggplot2::element_line(colour = "#e8e8e8", linewidth = 0.27),
      panel.grid.minor = ggplot2::element_line(colour = "#eeeeee", linewidth = 0.18),
      axis.line = ggplot2::element_blank(),
      axis.ticks = ggplot2::element_line(colour = "#787e86", linewidth = 0.22),
      axis.ticks.length = grid::unit(1, "mm"),
      axis.text = ggplot2::element_text(colour = "#454b54", size = if (small) 6 else 7),
      axis.title = ggplot2::element_text(colour = "#22262d", size = if (small) 7 else 8),
      axis.title.x = ggplot2::element_text(margin = ggplot2::margin(t = 5)),
      axis.title.y = ggplot2::element_text(margin = ggplot2::margin(r = 5)),
      legend.position = if (small) "bottom" else "right",
      legend.direction = if (small) "horizontal" else "vertical",
      legend.title = ggplot2::element_text(size = if (small) 6.5 else 7.5),
      legend.text = ggplot2::element_text(size = if (small) 6 else 7),
      legend.key.width = grid::unit(if (small) 5 else 7, "mm"),
      legend.key.height = grid::unit(4, "mm"),
      legend.margin = ggplot2::margin(0, 0, 0, 0),
      legend.box.spacing = grid::unit(3, "mm"),
      strip.text = ggplot2::element_text(colour = "#333942", size = if (small) 7 else 8,
        margin = ggplot2::margin(b = 4, t = 1)),
      panel.spacing = grid::unit(if (small) 3 else 5, "mm"),
      plot.margin = ggplot2::margin(3, 3, 3, 3, unit = "mm"),
      plot.background = ggplot2::element_rect(fill = "white", colour = NA))
}

blsd_export_height_mm <- function(settings, fit) {
  if (identical(settings$metric, "timeTrends")) {
    n <- length(if (is.null(settings$trendAges)) fit$defaults$trendAges else unique(settings$trendAges))
    return(16 + ceiling(n / 3) * 47)
  }
  if (identical(settings$metric, "ageSections")) {
    n <- length(if (is.null(settings$sectionYears)) fit$defaults$sectionYears else unique(settings$sectionYears))
    return(max(112, 16 + n * 4.5))
  }
  if (settings$metric %in% c("gradient", "shift")) return(119)
  112
}

blsd_export_colourbar <- function(small, bottom = small) {
  ggplot2::guide_colourbar(title.position = "top", title.hjust = if (bottom) 0.5 else 0,
    direction = if (bottom) "horizontal" else "vertical",
    barwidth = grid::unit(if (bottom) if (small) 37 else 44 else 3.6, "mm"),
    barheight = grid::unit(if (bottom) 2.5 else 20, "mm"),
    ticks.colour = "#ffffff", frame.colour = NA)
}

blsd_export_coordinates <- function(supplied, defaults, axis) {
  selected <- if (is.null(supplied)) defaults else supplied
  if (!is.numeric(selected) || !length(selected) || any(!is.finite(selected)) ||
      any(!selected %in% axis)) stop("INVALID_EXPORT_SETTINGS")
  sort(unique(selected))
}

blsd_export_switch <- function(settings, name) {
  if (!name %in% names(settings)) return(TRUE)
  value <- settings[[name]]
  if (!is.logical(value) || length(value) != 1L || is.na(value)) stop("INVALID_EXPORT_SETTINGS")
  value
}

# Labels describe the retained contour levels, in the field's existing units.
# Start with three significant figures, increasing precision only where distinct
# levels would otherwise have the same label. Never turn small values into zero.
blsd_export_contour_text <- function(levels) {
  encode <- function(value, digits) {
    if (value == 0) return("0")
    if (abs(value) < 0.001 || abs(value) >= 10000) {
      parts <- strsplit(formatC(value, format = "e", digits = digits - 1L,
        decimal.mark = "."), "e", fixed = TRUE)[[1]]
      return(paste0(sub("\\.?0+$", "", parts[1]), "e", as.integer(parts[2])))
    }
    places <- max(0L, digits - 1L - floor(log10(abs(value))))
    text <- formatC(value, format = "f", digits = places, decimal.mark = ".")
    if (places > 0L) text <- sub("\\.?0+$", "", text)
    text
  }
  values <- unique(levels[is.finite(levels)])
  if (!length(values)) return(rep(NA_character_, length(levels)))
  precision <- rep(3L, length(values))
  labels <- mapply(encode, values, precision, USE.NAMES = FALSE)
  repeat {
    collision <- duplicated(labels) | duplicated(labels, fromLast = TRUE)
    if (!any(collision & precision < 17L)) break
    precision[collision] <- pmin(17L, precision[collision] + 1L)
    labels <- mapply(encode, values, precision, USE.NAMES = FALSE)
  }
  labels[match(levels, values)]
}

# Select at most one quiet, interior position per level. Coordinates are mapped
# to the approximate physical panel at the fixed 180 x 112 mm publication size,
# so tangent angles and collision checks use the same units on both axes.
# This only inspects retained paths; it neither derives contours nor changes them.
blsd_export_contour_labels <- function(paths, year_limits, age_limits,
    panel_mm = c(136, 96), max_labels = 6L) {
  empty <- data.frame(Year = numeric(), Age = numeric(), Level = numeric(),
    Label = character(), Angle = numeric(), Path = integer(),
    XLow = numeric(), XHigh = numeric(), YLow = numeric(), YHigh = numeric())
  span <- c(diff(year_limits), diff(age_limits))
  if (!length(paths) || any(!is.finite(span)) || any(span <= 0) || max_labels < 1L)
    return(empty)
  levels <- vapply(paths, function(path) path$level, numeric(1))
  unique_levels <- sort(unique(levels[is.finite(levels)]))
  texts <- blsd_export_contour_text(unique_levels)
  candidates <- list()
  for (i in seq_along(paths)) {
    path <- paths[[i]]
    if (!is.finite(levels[i]) || length(path$points) < 3L) next
    coords <- do.call(rbind, path$points)
    if (!is.matrix(coords) || ncol(coords) != 2L || any(!is.finite(coords))) next
    physical <- sweep(sweep(coords, 2L, c(year_limits[1], age_limits[1]), "-"),
      2L, span / panel_mm, "/")
    distance <- c(0, cumsum(sqrt(rowSums((physical[-1L, , drop = FALSE] -
      physical[-nrow(physical), , drop = FALSE]) ^ 2))))
    keep <- !duplicated(distance)
    physical <- physical[keep, , drop = FALSE]
    distance <- distance[keep]
    text <- texts[match(levels[i], unique_levels)]
    # Reserve a small inline gap around 2.8 mm type, without a drawn backing.
    width <- nchar(text) * 1.6 + 2
    height <- 4
    half <- width / 2 + 1
    total <- tail(distance, 1L)
    if (length(distance) < 3L || total < 2 * half + 2) next
    at <- seq(half, total - half, length.out = min(71L, max(9L, ceiling(total / 2))))
    locate <- function(s) c(stats::approx(distance, physical[, 1], xout = s)$y,
      stats::approx(distance, physical[, 2], xout = s)$y)
    for (s in at) {
      centre <- locate(s)
      left <- locate(s - half)
      right <- locate(s + half)
      chord <- right - left
      straightness <- sqrt(sum(chord ^ 2)) / (2 * half)
      if (!is.finite(straightness) || straightness < 0.985) next
      angle <- atan2(chord[2], chord[1]) * 180 / pi
      if (angle > 90) angle <- angle - 180
      if (angle < -90) angle <- angle + 180
      radians <- angle * pi / 180
      bounds <- c(abs(cos(radians)) * width + abs(sin(radians)) * height,
        abs(sin(radians)) * width + abs(cos(radians)) * height) / 2
      low <- centre - bounds
      high <- centre + bounds
      if (any(low < 2.5) || any(high > panel_mm - 2.5)) next
      # Prefer straight segments away from both path ends and panel edges.
      score <- (1 - straightness) * 20 +
        0.2 * (centre[2] / panel_mm[2] - 0.5) ^ 2 + 0.12 * abs(s / total - 0.5)
      candidates[[length(candidates) + 1L]] <- data.frame(
        Year = year_limits[1] + centre[1] * span[1] / panel_mm[1],
        Age = age_limits[1] + centre[2] * span[2] / panel_mm[2],
        Level = levels[i], Label = text, Angle = angle, Path = i,
        XLow = low[1], XHigh = high[1], YLow = low[2], YHigh = high[2], Score = score)
    }
  }
  if (!length(candidates)) return(empty)
  candidates <- do.call(rbind, candidates)
  available <- sort(unique(candidates$Level))
  if (length(available) > max_labels)
    available <- available[unique(round(seq(1, length(available), length.out = max_labels)))]
  selected <- empty
  targets <- c(0.28, 0.67, 0.46)
  for (k in seq_along(available)) {
    level <- available[k]
    options <- candidates[candidates$Level == level, , drop = FALSE]
    centre_x <- (options$XLow + options$XHigh) / (2 * panel_mm[1])
    options$Score <- options$Score + 5 * (centre_x - targets[(k - 1L) %% length(targets) + 1L]) ^ 2
    options <- options[order(options$Score, options$Path), , drop = FALSE]
    for (j in seq_len(nrow(options))) {
      candidate <- options[j, , drop = FALSE]
      if (nrow(selected) && any(candidate$XLow < selected$XHigh + 2 &
          candidate$XHigh > selected$XLow - 2 & candidate$YLow < selected$YHigh + 2 &
          candidate$YHigh > selected$YLow - 2)) next
      selected <- rbind(selected, candidate[, names(empty), drop = FALSE])
      break
    }
  }
  rownames(selected) <- NULL
  selected
}

# Split display-only line segments at each rotated label rectangle. A segment
# may cross a gap even when both its retained endpoints are outside it; clipping
# the segment itself prevents lines through glyphs without hiding a field pixel.
blsd_export_contour_paths <- function(paths, labels, year_limits, age_limits,
    panel_mm = c(136, 96)) {
  empty <- data.frame(Year = numeric(), Age = numeric(), Path = integer())
  if (!length(paths)) return(empty)
  origin <- c(year_limits[1], age_limits[1])
  scale <- c(diff(year_limits), diff(age_limits)) / panel_mm
  boxes <- lapply(seq_len(nrow(labels)), function(i) {
    angle <- labels$Angle[i] * pi / 180
    list(level = labels$Level[i], centre = (c(labels$Year[i], labels$Age[i]) - origin) / scale,
      cosine = cos(angle), sine = sin(angle),
      half = c((nchar(labels$Label[i]) * 1.6 + 2) / 2, 2))
  })
  inside_interval <- function(a, b, box) {
    rotate <- function(point) {
      delta <- point - box$centre
      c(box$cosine * delta[1] + box$sine * delta[2],
        -box$sine * delta[1] + box$cosine * delta[2])
    }
    start <- rotate(a)
    delta <- rotate(b) - start
    low <- 0
    high <- 1
    for (axis in 1:2) {
      if (abs(delta[axis]) < 1e-12) {
        if (abs(start[axis]) > box$half[axis]) return(NULL)
      } else {
        crossings <- sort(c(-box$half[axis] - start[axis], box$half[axis] - start[axis]) / delta[axis])
        low <- max(low, crossings[1])
        high <- min(high, crossings[2])
        if (low >= high) return(NULL)
      }
    }
    c(low, high)
  }
  result <- list()
  group <- 0L
  for (path in paths) {
    if (length(path$points) < 2L) next
    coords <- do.call(rbind, path$points)
    physical <- sweep(sweep(coords, 2L, origin, "-"), 2L, scale, "/")
    level_boxes <- boxes[vapply(boxes, function(box) box$level == path$level, logical(1))]
    active <- FALSE
    for (i in seq_len(nrow(physical) - 1L)) {
      a <- physical[i, ]
      b <- physical[i + 1L, ]
      removed <- lapply(level_boxes, function(box) inside_interval(a, b, box))
      removed <- removed[!vapply(removed, is.null, logical(1))]
      intervals <- list()
      cursor <- 0
      if (length(removed)) {
        removed <- do.call(rbind, removed)
        removed <- removed[order(removed[, 1]), , drop = FALSE]
        for (j in seq_len(nrow(removed))) {
          if (removed[j, 1] > cursor) intervals[[length(intervals) + 1L]] <- c(cursor, removed[j, 1])
          cursor <- max(cursor, removed[j, 2])
        }
      }
      if (cursor < 1) intervals[[length(intervals) + 1L]] <- c(cursor, 1)
      if (!length(intervals)) active <- FALSE
      for (interval in intervals) {
        continuous <- active && interval[1] == 0
        if (!continuous) group <- group + 1L
        # Use exact retained endpoints except at the new clipping intersections.
        locate <- function(t) if (t == 0) coords[i, ] else if (t == 1) coords[i + 1L, ]
          else origin + (a + t * (b - a)) * scale
        if (!continuous) {
          point <- locate(interval[1])
          result[[length(result) + 1L]] <- data.frame(Year = point[1], Age = point[2], Path = group)
        }
        point <- locate(interval[2])
        result[[length(result) + 1L]] <- data.frame(Year = point[1], Age = point[2], Path = group)
        active <- interval[2] == 1
      }
    }
  }
  if (!length(result)) return(empty)
  data <- do.call(rbind, result)
  rownames(data) <- NULL
  data
}

blsd_coordinate_label <- function(value) {
  if (value != 0 && (abs(value) < 0.001 || abs(value) >= 10000))
    formatC(value, format = "e", digits = 2L)
  else format(round(value, 3L), trim = TRUE, scientific = FALSE)
}

blsd_export_age_label <- function(value, fit, zh) {
  # A numeric midpoint alone does not establish any age-group boundaries.
  # Only explicit, consistent closed groups in retained provenance get ranges.
  groups <- fit$provenance$ageGroups
  if (is.data.frame(groups)) groups <- lapply(seq_len(nrow(groups)), function(i) as.list(groups[i, ]))
  if (is.list(groups)) for (group in groups) {
    if (!is.list(group)) next
    bounds <- unlist(group[c("midpoint", "lower", "upper")], use.names = FALSE)
    if (is.numeric(bounds) && length(bounds) == 3L && all(is.finite(bounds)) &&
        bounds[1] == value && bounds[2] <= bounds[3] &&
        abs((bounds[2] + bounds[3] + 1) / 2 - value) < 1e-9) {
      label <- paste0(blsd_coordinate_label(bounds[2]), "\u2013", blsd_coordinate_label(bounds[3]))
      return(label)
    }
  }
  if (zh) paste0("年龄中点 ", blsd_coordinate_label(value))
  else paste0("Age midpoint ", blsd_coordinate_label(value))
}

# Pure plotting tables; no estimates, intervals, rows or stored models change.
# unlist preserves integer/double columns just as the former rbind of one-row
# data.frames did. Missing interval/rate values retain their NA_real_ handling.
blsd_export_prepare <- function(fit, metrics = c("ageSections", "timeTrends", "residuals")) {
  column <- function(rows, value) unlist(lapply(rows, value), use.names = FALSE)
  needs_curves <- any(metrics %in% c("ageSections", "timeTrends"))
  curves <- if (needs_curves && length(fit$points)) data.frame(
    Year = column(fit$points, function(p) p$year),
    Age = column(fit$points, function(p) p$age),
    Rate = column(fit$points, function(p) if (is.null(p$rate)) NA_real_ else p$rate),
    Lower = column(fit$points, function(p) if (is.null(p$intervals$rate)) NA_real_ else p$intervals$rate[1]),
    Upper = column(fit$points, function(p) if (is.null(p$intervals$rate)) NA_real_ else p$intervals$rate[2])) else NULL
  observed <- if (needs_curves && length(fit$residuals)) data.frame(
    Year = column(fit$residuals, function(p) p$year),
    Age = column(fit$residuals, function(p) p$age),
    Rate = column(fit$residuals, function(p) p$observedRate)) else NULL
  residuals <- if ("residuals" %in% metrics && length(fit$residuals)) data.frame(
    FittedRate = column(fit$residuals, function(p) p$fittedRate),
    Residual = column(fit$residuals, function(p) p$devianceResidual),
    Age = column(fit$residuals, function(p) p$age)) else NULL
  list(curves = curves, observed = observed, residuals = residuals,
    themes = new.env(parent = emptyenv()))
}

blsd_export_theme <- function(prepared, font, small) {
  key <- paste(font, small, sep = "::")
  if (!exists(key, prepared$themes, inherits = FALSE))
    assign(key, blsd_plot_theme(font, small), prepared$themes)
  get(key, prepared$themes, inherits = FALSE)
}

blsd_export_plot <- function(fit, settings, prepared = NULL) {
  metric <- settings$metric
  if (is.null(prepared)) prepared <- blsd_export_prepare(fit, metric)
  show_contours <- blsd_export_switch(settings, "showContours")
  show_intervals <- blsd_export_switch(settings, "showIntervals")
  zh <- identical(settings$locale, "zh")
  # Publication figures use the established double-column styling only.
  small <- FALSE
  font <- if (zh) "Microsoft YaHei" else "Arial"
  # Match Figure 1–7 in the user's explicit GBD reference directory.
  # Gradient maps below interpolate in Lab, as the source ggplot2 scales do.
  signed <- c("#2166AC", "#FFFFFF", "#B2182B")
  age_shift <- c("#346D8C", "#F7F5F0", "#CE8D5E")
  axis_year <- if (zh) "时期" else "Period"
  axis_age <- if (zh) "年龄" else "Age"
  axis_rate <- if (zh) "率（每10万人）" else "Rate per 100,000"
  finite_count <- 0L
  legend_shown <- TRUE

  if (metric %in% c("ageSections", "timeTrends")) {
    sections <- identical(metric, "ageSections")
    selected <- blsd_export_coordinates(if (sections) settings$sectionYears else settings$trendAges,
      if (sections) fit$defaults$sectionYears else fit$defaults$trendAges,
      if (sections) fit$grid$years else fit$grid$ages)
    d <- prepared$curves[(if (sections) prepared$curves$Year else prepared$curves$Age) %in% selected, , drop = FALSE]
    rownames(d) <- NULL
    d$Group <- factor(if (sections) d$Year else d$Age, levels = selected)
    observed <- if (is.null(prepared$observed)) NULL else
      prepared$observed[(if (sections) prepared$observed$Year else prepared$observed$Age) %in% selected, , drop = FALSE]
    if (!is.null(observed)) rownames(observed) <- NULL
    if (is.null(observed) || !nrow(observed)) observed <- data.frame(Year = numeric(), Age = numeric(), Rate = numeric())
    observed$Group <- factor(if (sections) observed$Year else observed$Age, levels = selected)
    if (sections) observed <- observed[observed$Rate > 0, , drop = FALSE]
    finite_count <- sum(is.finite(d$Rate))
    colours <- if (length(selected) == 3L) c("#F8766D", "#00BA38", "#619CFF")
      else scales::hue_pal()(length(selected))
    names(colours) <- as.character(selected)
    coordinate_labels <- vapply(selected, blsd_coordinate_label, character(1))
    line_types <- c("solid", "dashed", "dotted")[(seq_along(selected) - 1L) %/% 4L %% 3L + 1L]
    names(line_types) <- as.character(selected)
    if (sections) {
    p <- ggplot2::ggplot(d, ggplot2::aes(x = Age,
      y = Rate, colour = Group, fill = Group, linetype = Group, group = Group))
    if (show_intervals) p <- p +
      ggplot2::geom_ribbon(ggplot2::aes(ymin = Lower, ymax = Upper), colour = NA, alpha = 0.12, na.rm = TRUE)
    else p <- p + ggplot2::geom_blank(ggplot2::aes(ymin = Lower, ymax = Upper))
    # The online age-section domain includes retained intervals even when
    # ribbons are hidden. Train the same domain without drawing an interval.
    p <- p +
      ggplot2::geom_line(linewidth = if (small) 0.4 else 0.5, na.rm = TRUE) +
      ggplot2::geom_point(data = observed, size = if (small) 0.9 else 1.2, stroke = 0, na.rm = TRUE) +
      ggplot2::scale_colour_manual(values = colours, labels = coordinate_labels, drop = FALSE) +
      ggplot2::scale_fill_manual(values = colours, labels = coordinate_labels, drop = FALSE) +
      ggplot2::scale_linetype_manual(values = line_types, labels = coordinate_labels, drop = FALSE) +
      ggplot2::labs(x = if (sections) axis_age else axis_year, y = axis_rate,
        colour = if (zh) "时期" else "Period", fill = if (zh) "时期" else "Period",
        linetype = if (zh) "时期" else "Period") +
      ggplot2::guides(fill = ggplot2::guide_legend(title.position = "top", title.hjust = 0.5,
        ncol = if (small) min(3L, length(selected)) else 1L, byrow = TRUE),
        colour = ggplot2::guide_legend(title.position = "top", title.hjust = 0.5,
        ncol = if (small) min(3L, length(selected)) else 1L, byrow = TRUE)) +
      ggplot2::scale_x_continuous(breaks = scales::breaks_pretty(n = 3), expand = ggplot2::expansion(mult = c(0.01, 0.01))) +
      ggplot2::scale_y_log10(labels = scales::label_number(big.mark = ""),
        expand = ggplot2::expansion(mult = c(0.015, 0.015))) +
      blsd_export_theme(prepared, font, small)
    } else {
      labels <- stats::setNames(vapply(selected, blsd_export_age_label, character(1), fit = fit, zh = zh), as.character(selected))
      p <- ggplot2::ggplot(d, ggplot2::aes(Year, Rate))
      if (show_intervals) p <- p +
        ggplot2::geom_ribbon(ggplot2::aes(ymin = Lower, ymax = Upper), fill = "#2C7FB8", alpha = 0.2, colour = NA, na.rm = TRUE)
      p <- p +
        ggplot2::geom_line(colour = signed[1], linewidth = if (small) 0.4 else 0.5, na.rm = TRUE) +
        ggplot2::geom_point(data = observed, colour = "#000000", size = if (small) 0.7 else 0.9, stroke = 0, na.rm = TRUE) +
        ggplot2::facet_wrap(~Group, scales = "free_y", ncol = if (small) 2 else 3,
          labeller = ggplot2::labeller(Group = labels)) +
        ggplot2::scale_x_continuous(n.breaks = if (small) 3 else 4,
          expand = ggplot2::expansion(mult = c(0.015, 0.015))) +
        ggplot2::scale_y_continuous(n.breaks = 5, labels = scales::label_number(big.mark = ""),
          expand = ggplot2::expansion(mult = c(0.02, 0.02))) +
        ggplot2::labs(x = axis_year, y = axis_rate) + blsd_export_theme(prepared, font, small) +
        ggplot2::theme(legend.position = "none", panel.spacing = grid::unit(if (small) 2.5 else 3, "mm"))
      legend_shown <- FALSE
    }
  } else if (metric == "residuals") {
    d <- prepared$residuals
    finite_count <- sum(is.finite(d$Residual) & is.finite(d$FittedRate) & d$FittedRate > 0)
    p <- ggplot2::ggplot(d, ggplot2::aes(FittedRate, Residual)) +
      ggplot2::geom_hline(yintercept = 0, colour = "#000000", linetype = "dashed", linewidth = 0.28) +
      ggplot2::geom_point(ggplot2::aes(colour = Age), size = if (small) 0.9 else 1.15, alpha = 0.5, stroke = 0) +
      ggplot2::scale_colour_viridis_c(name = axis_age) +
      ggplot2::scale_x_log10(labels = scales::label_number(big.mark = "")) +
      ggplot2::scale_y_continuous(n.breaks = 5) +
      ggplot2::labs(x = if (zh) "拟合率（每10万人）" else "Fitted rate per 100,000",
        y = if (zh) "偏差残差" else "Deviance residual") + blsd_export_theme(prepared, font, small)
    p <- p + ggplot2::guides(colour = blsd_export_colourbar(small))
  } else {
    units <- list(surface = c("ln(rate per 100,000)", "ln（每10万人率）"),
      annual = c("% / year", "% / 年份"), acceleration = c("Log-rate / year²", "对数率 / 年份²"),
      gradient = c("% / age-year", "% / 岁"), shift = c("Age-years / year", "年龄岁 / 年份"))
    d <- data.frame(Year = vapply(fit$points, function(p) p$year, numeric(1)),
      Age = vapply(fit$points, function(p) p$age, numeric(1)),
      Value = vapply(fit$points, function(p) {
        value <- p[[metric]]
        if (is.null(value)) NA_real_ else value
      }, numeric(1)))
    edges <- function(axis) c(axis[1], (head(axis, -1) + tail(axis, -1)) / 2, tail(axis, 1))
    year_edges <- edges(fit$grid$years)
    age_edges <- edges(fit$grid$ages)
    yi <- match(d$Year, fit$grid$years)
    ai <- match(d$Age, fit$grid$ages)
    d$YearLow <- year_edges[yi]
    d$YearHigh <- year_edges[yi + 1L]
    d$AgeLow <- age_edges[ai]
    d$AgeHigh <- age_edges[ai + 1L]
    # Omitted time endpoint cells are never drawn, including as grey rectangles.
    if (metric == "acceleration") d <- d[!d$Year %in% range(fit$grid$years), , drop = FALSE]
    # Trim the displayed panel to its actual cells; masked endpoint years
    # remain available in the retained numerical result and downloads.
    year_limits <- if (metric == "acceleration" && nrow(d)) range(c(d$YearLow, d$YearHigh))
      else range(fit$grid$years)
    finite_count <- sum(is.finite(d$Value))
    p <- ggplot2::ggplot(d, ggplot2::aes(Year, Age)) +
      ggplot2::geom_rect(ggplot2::aes(xmin = YearLow, xmax = YearHigh,
        ymin = AgeLow, ymax = AgeHigh, fill = Value), linewidth = 0) +
      ggplot2::labs(x = axis_year, y = axis_age, fill = units[[metric]][if (zh) 2 else 1]) +
      ggplot2::scale_x_continuous(n.breaks = 4) +
      ggplot2::scale_y_continuous(breaks = scales::breaks_pretty(n = if (metric %in% c("gradient", "shift")) 6 else 3)) +
      ggplot2::coord_cartesian(xlim = year_limits, ylim = range(fit$grid$ages), expand = FALSE) +
      blsd_export_theme(prepared, font, small)
    if (metric == "surface") p <- p + ggplot2::scale_fill_viridis_c(
      labels = scales::label_number(big.mark = ""), na.value = "#BFBFBF")
    else if (metric == "gradient") p <- p + ggplot2::scale_fill_gradientn(
      colours = age_shift, na.value = "#BFBFBF", n.breaks = 5)
    else if (metric == "shift") {
      limit <- if (finite_count) max(abs(d$Value), na.rm = TRUE) else 1
      if (!is.finite(limit) || limit == 0) limit <- 1
      p <- p + ggplot2::scale_fill_gradient2(low = age_shift[1], mid = age_shift[2], high = age_shift[3],
        midpoint = 0, limits = c(-limit, limit), na.value = "#BFBFBF", n.breaks = 5)
    } else p <- p + ggplot2::scale_fill_gradient2(low = signed[1], mid = signed[2], high = signed[3],
      midpoint = 0, na.value = "#BFBFBF", n.breaks = 5)
    if (metric %in% c("gradient", "shift")) p <- p + ggplot2::theme(panel.grid = ggplot2::element_blank())
    bottom <- small || metric %in% c("gradient", "shift")
    if (finite_count) p <- p + ggplot2::guides(fill = blsd_export_colourbar(small, bottom)) +
      ggplot2::theme(legend.position = if (bottom) "bottom" else "right",
        legend.direction = if (bottom) "horizontal" else "vertical")
    else p <- p + ggplot2::theme(legend.position = "none")
    # Both the field and contour paths come from the retained central matrix.
    if (show_contours && metric %in% c("surface", "annual")) {
      paths <- fit$contours[[metric]]
      labels <- blsd_export_contour_labels(paths, year_limits, range(fit$grid$ages))
      contour_data <- blsd_export_contour_paths(paths, labels, year_limits, range(fit$grid$ages))
      if (nrow(contour_data)) p <- p + ggplot2::geom_path(data = contour_data,
        ggplot2::aes(Year, Age, group = Path), inherit.aes = FALSE,
        colour = if (metric == "surface") "#ffffff" else "#293342",
        linewidth = if (small) 0.2 else 0.25, alpha = if (metric == "surface") 0.9 else 0.38)
      if (nrow(labels)) p <- p + ggplot2::geom_text(data = labels,
        ggplot2::aes(Year, Age, label = Label, angle = Angle), inherit.aes = FALSE,
        family = font, size = 2.8,
        colour = if (metric == "surface") "#ffffff" else "#333333",
        show.legend = FALSE)
    }
  }
  if (metric %in% c("surface", "annual", "acceleration", "ageSections", "timeTrends"))
    p <- p + ggplot2::theme(plot.margin = ggplot2::margin(1.5, 1.5, 1.5, 1.5, unit = "mm"),
      legend.box.spacing = grid::unit(2, "mm"))
  list(plot = p, font = font, finitePoints = finite_count,
       legendShown = legend_shown && finite_count > 0L,
       heightMm = blsd_export_height_mm(settings, fit))
}

blsd_export_render <- function(fit, settings, output, prepared = NULL) {
  if (length(settings$metric) != 1L ||
      !settings$metric %in% c("surface", "annual", "acceleration", "gradient", "shift", "ageSections", "timeTrends", "residuals") ||
      !settings$format %in% c("pdf", "png", "tiff") || !settings$locale %in% c("en", "zh") ||
      settings$widthMm != 180 || settings$dpi != 600) stop("INVALID_EXPORT_SETTINGS")
  if (settings$format == "tiff" && !isTRUE(capabilities("tiff"))) stop("TIFF_UNAVAILABLE")
  rendered <- blsd_export_plot(fit, settings, prepared)
  width <- settings$widthMm / 25.4
  height_mm <- rendered$heightMm
  if (settings$format == "pdf") grDevices::cairo_pdf(output, width = width, height = height_mm / 25.4, family = rendered$font)
  else if (settings$format == "tiff") grDevices::tiff(output, width = settings$widthMm, height = height_mm, units = "mm",
    res = settings$dpi, type = "cairo", compression = "lzw", bg = "white")
  else grDevices::png(output, width = settings$widthMm, height = height_mm, units = "mm",
    res = settings$dpi, type = "cairo", bg = "white")
  device <- grDevices::dev.cur()
  tryCatch(print(rendered$plot), finally = {
    if (device %in% grDevices::dev.list()) grDevices::dev.off(device)
  })
  list(ok = TRUE, finitePoints = rendered$finitePoints, legendShown = rendered$legendShown,
    widthMm = settings$widthMm, heightMm = height_mm, dpi = settings$dpi,
    adapterVersion = fit$meta$adapterVersion, dataSource = "RETAINED_FIT_RESULT", refitted = FALSE, resampled = FALSE)
}

blsd_export_batch <- function(manifest, output_directory) {
  if (!is.list(manifest$groups) || !length(manifest$groups) || length(manifest$groups) > 32L ||
      !dir.exists(output_directory)) stop("INVALID_EXPORT_SETTINGS")
  if (!is.null(manifest$cancelFile) &&
      (!is.character(manifest$cancelFile) || length(manifest$cancelFile) != 1L)) stop("INVALID_EXPORT_SETTINGS")
  check_cancelled <- function() {
    if (!is.null(manifest$cancelFile) && file.exists(manifest$cancelFile)) stop("EXPORT_FAILED")
  }
  records <- list()
  seen_files <- character()
  total_bytes <- 0
  for (group_index in seq_along(manifest$groups)) {
    check_cancelled()
    group <- manifest$groups[[group_index]]
    if (!is.character(group$rdsPath) || length(group$rdsPath) != 1L ||
        !is.list(group$settings) || !is.list(group$figures) ||
        !length(group$figures) || length(group$figures) > 8L) stop("INVALID_EXPORT_SETTINGS")
    snapshot <- readRDS(group$rdsPath)
    fit <- if (!is.null(snapshot$result)) snapshot$result else snapshot
    prepared <- blsd_export_prepare(fit)
    settings <- group$settings
    # Keep arrays as arrays when reading the manifest, then recover only the
    # validated numeric coordinate vectors used by the unchanged plot function.
    for (key in c("sectionYears", "trendAges")) if (!is.null(settings[[key]])) {
      coordinates <- settings[[key]]
      if (!length(coordinates) || !all(vapply(coordinates,
          function(value) is.numeric(value) && length(value) == 1L && is.finite(value), logical(1))))
        stop("INVALID_EXPORT_SETTINGS")
      settings[[key]] <- unlist(coordinates, use.names = FALSE)
    }
    for (figure in group$figures) {
      check_cancelled()
      file <- figure$file
      if (!is.character(file) || length(file) != 1L || !nzchar(file) ||
          grepl("[/\\\\]", file) || file %in% c(".", "..") ||
          file %in% seen_files || !endsWith(file, paste0(".", settings$format))) stop("INVALID_EXPORT_SETTINGS")
      settings$metric <- figure$metric
      output <- file.path(output_directory, file)
      info <- blsd_export_render(fit, settings, output, prepared)
      bytes <- file.info(output)$size
      if (length(bytes) != 1L || !is.finite(bytes) || bytes <= 0 || bytes > 32 * 1024 * 1024)
        stop("EXPORT_FAILED")
      total_bytes <- total_bytes + bytes
      if (total_bytes > 256 * 1024 * 1024) stop("EXPORT_FAILED")
      records[[length(records) + 1L]] <- c(list(group = group_index, metric = figure$metric, file = file), info)
      seen_files <- c(seen_files, file)
    }
  }
  list(ok = TRUE, figures = records, dataSource = "RETAINED_FIT_RESULT", refitted = FALSE, resampled = FALSE)
}

blsd_export_main <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) != 4L) stop("Four export file arguments are required.")
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    writeLines('{"error":{"code":"R_PACKAGES_MISSING","message":"The R JSON dependency is unavailable."}}', args[4])
    quit(status = 2L)
  }
  result <- tryCatch({
    if (!requireNamespace("ggplot2", quietly = TRUE)) stop("R_PACKAGES_MISSING")
    if (!isTRUE(capabilities("cairo"))) stop("CAIRO_UNAVAILABLE")
    if (identical(args[1], "--batch")) {
      blsd_export_batch(jsonlite::fromJSON(args[2], simplifyVector = FALSE), args[3])
    } else {
      snapshot <- readRDS(args[1])
      fit <- if (!is.null(snapshot$result)) snapshot$result else snapshot
      blsd_export_render(fit, jsonlite::fromJSON(args[2]), args[3])
    }
  }, error = function(e) {
    allowed <- c("R_PACKAGES_MISSING", "CAIRO_UNAVAILABLE", "TIFF_UNAVAILABLE", "INVALID_EXPORT_SETTINGS")
    code <- if (conditionMessage(e) %in% allowed) conditionMessage(e) else "EXPORT_FAILED"
    list(error = list(code = code, message = "The publication figure could not be exported."))
  })
  jsonlite::write_json(result, args[4], auto_unbox = TRUE, null = "null", digits = 15)
  if (!is.null(result$error)) quit(status = 2L)
}
if (sys.nframe() == 0L) blsd_export_main()
