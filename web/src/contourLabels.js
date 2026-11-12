const finite = value => typeof value === 'number' && Number.isFinite(value);
const pointIsFinite = point => Array.isArray(point) && finite(point[0]) && finite(point[1]);
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const samePoint = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

function shortNumber(value, precision) {
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  let text = magnitude >= 10000 || magnitude < 0.001
    ? value.toExponential(precision - 1) : String(Number(value.toPrecision(precision)));
  const [mantissa, exponent] = text.split('e');
  text = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
  if (exponent !== undefined) text += `e${Number(exponent)}`;
  return text;
}

/** Short display values, increasing precision only when distinct levels collide. */
export function formatContourLevels(levels) {
  const unique = [...new Set((Array.isArray(levels) ? levels : []).filter(finite))];
  const labels = new Map(unique.map(level => [level, shortNumber(level, 3)]));
  for (let precision = 4; precision <= 17; precision++) {
    const counts = new Map();
    for (const text of labels.values()) counts.set(text, (counts.get(text) || 0) + 1);
    const duplicates = unique.filter(level => counts.get(labels.get(level)) > 1);
    if (!duplicates.length) break;
    for (const level of duplicates) labels.set(level, shortNumber(level, precision));
  }
  return labels;
}

// Liang–Barsky clipping retains a segment even when both original ends are offscreen.
function clipSegment(a, b, rect) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (!finite(dx) || !finite(dy)) return null;
  let start = 0, end = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - rect.x, rect.x + rect.width - a[0], a[1] - rect.y, rect.y + rect.height - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; }
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) start = Math.max(start, t);
      else end = Math.min(end, t);
      if (start > end) return null;
    }
  }
  return [[a[0] + start * dx, a[1] + start * dy], [a[0] + end * dx, a[1] + end * dy]];
}

function visibleRuns(points, dataToPixel, rect) {
  const runs = [];
  let previous = null, current = [];
  const finish = () => { if (current.length > 1) runs.push(current); current = []; };
  for (const point of Array.isArray(points) ? points : []) {
    let pixel = null;
    if (pointIsFinite(point)) {
      try { pixel = dataToPixel([point[0], point[1]]); } catch { /* An unavailable chart coordinate is a path break. */ }
    }
    if (!pointIsFinite(pixel)) { previous = null; finish(); continue; }
    if (previous) {
      const segment = clipSegment(previous, pixel, rect);
      if (!segment) finish();
      else if (!samePoint(segment[0], segment[1])) {
        if (current.length && !samePoint(current.at(-1), segment[0])) finish();
        if (!current.length) current.push(segment[0]);
        current.push(segment[1]);
      }
    }
    previous = pixel;
  }
  finish();
  return runs;
}

function measuredRun(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths.at(-1) + distance(points[i - 1], points[i]));
  const length = lengths.at(-1);
  if (!finite(length) || length <= 0) return null;
  const at = position => {
    let low = 1, high = lengths.length - 1;
    while (low < high) { const middle = (low + high) >> 1; if (lengths[middle] < position) low = middle + 1; else high = middle; }
    const a = points[low - 1], b = points[low], span = lengths[low] - lengths[low - 1];
    const fraction = span > 0 ? (position - lengths[low - 1]) / span : 0;
    return [a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1])];
  };
  return { length, at };
}

function inside(bounds, rect, padding) {
  return bounds.x >= rect.x + padding && bounds.y >= rect.y + padding &&
    bounds.x + bounds.width <= rect.x + rect.width - padding &&
    bounds.y + bounds.height <= rect.y + rect.height - padding;
}
function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function candidatesForRun(points, text, rect, settings) {
  const run = measuredRun(points);
  // Reserve a small amount of space between the digits and the contour ends.
  const width = text.length * settings.fontSize * 0.66 + 6;
  const height = settings.fontSize * 1.2 + 2;
  const halfSpan = Math.max(22, (width + 16) / 2);
  if (!run || run.length < halfSpan * 2 + 12) return [];
  const candidates = [];
  for (let i = 0; i < 25; i++) {
    const fraction = 0.5 + (i % 2 ? -1 : 1) * Math.ceil(i / 2) / 26;
    const position = halfSpan + (run.length - halfSpan * 2) * fraction;
    const a = run.at(position - halfSpan), b = run.at(position + halfSpan), center = run.at(position);
    const dx = b[0] - a[0], dy = b[1] - a[1], chord = Math.hypot(dx, dy);
    const straightness = chord / (2 * halfSpan);
    if (straightness < 0.97 || !finite(straightness)) continue;
    // A text-sized window must be locally straight; a loop or hairpin has no label.
    const deviation = Math.abs(dx * (center[1] - a[1]) - dy * (center[0] - a[0])) / chord;
    if (deviation > settings.fontSize * 0.45) continue;
    let angle = Math.atan2(dy, dx);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle <= -Math.PI / 2) angle += Math.PI;
    const rotatedWidth = Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height + settings.labelGap;
    const rotatedHeight = Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height + settings.labelGap;
    const bounds = { x: center[0] - rotatedWidth / 2, y: center[1] - rotatedHeight / 2, width: rotatedWidth, height: rotatedHeight };
    if (!inside(bounds, rect, settings.edgePadding)) continue;
    const edgeDistance = Math.min(center[0] - rect.x, rect.x + rect.width - center[0], center[1] - rect.y, rect.y + rect.height - center[1]);
    const positionPenalty = settings.targetX === undefined ? Math.abs(fraction - 0.5) * 12
      : Math.abs((center[0] - rect.x) / rect.width - settings.targetX) * 80;
    const score = straightness * 50 + Math.min(edgeDistance, 70) * 0.2 + Math.min(run.length, 600) * 0.02 - positionPenalty - deviation;
    candidates.push({ text, x: center[0], y: center[1], rotation: -angle, fontSize: settings.fontSize, width, height, bounds, score });
  }
  return candidates;
}

/**
 * Place sparse labels on retained contour paths, without changing data or coordinates.
 * dataToPixel([x, y]) returns the current zoom's pixel position. plotRect is the
 * ECharts coordinate system's {x, y, width, height}. Re-run after zoom or resize.
 * Returned x/y are text centres; rotation is in ECharts radians (positive CCW).
 * width/height include line-gap clearance; bounds also include labelGap spacing.
 */
export function placeContourLabels(contours, dataToPixel, plotRect, options = {}) {
  if (!Array.isArray(contours) || typeof dataToPixel !== 'function' || !plotRect ||
      ![plotRect.x, plotRect.y, plotRect.width, plotRect.height, plotRect.x + plotRect.width, plotRect.y + plotRect.height].every(finite) ||
      plotRect.width <= 0 || plotRect.height <= 0) return [];
  const settings = {
    fontSize: finite(options.fontSize) && options.fontSize > 0 ? options.fontSize : 11,
    edgePadding: finite(options.edgePadding) && options.edgePadding >= 0 ? options.edgePadding : 8,
    labelGap: finite(options.labelGap) && options.labelGap >= 0 ? options.labelGap : 10,
  };
  const requestedLimit = finite(options.maxLabels) && options.maxLabels >= 0 ? Math.floor(options.maxLabels) : 8;
  const areaLimit = Math.max(1, Math.floor(plotRect.width * plotRect.height / (settings.fontSize ** 2 * 100)));
  const limit = Math.min(requestedLimit, areaLimit);
  if (!limit) return [];
  const texts = formatContourLevels(contours.map(contour => contour?.level));
  const orderedLevels = [...texts.keys()].sort((a, b) => a - b);
  const groups = new Map();
  for (const contour of contours) {
    if (!finite(contour?.level)) continue;
    const text = texts.get(contour.level);
    const placement = options.stagger ? { ...settings, targetX: [0.28, 0.67, 0.46][orderedLevels.indexOf(contour.level) % 3] } : settings;
    const candidates = visibleRuns(contour.points, dataToPixel, plotRect)
      .flatMap(points => candidatesForRun(points, text, plotRect, placement));
    if (!groups.has(contour.level)) groups.set(contour.level, []);
    groups.get(contour.level).push(...candidates);
  }
  const levels = [...groups.keys()].filter(level => groups.get(level).length).sort((a, b) => a - b);
  // Give a reduced label set an even spread of values, rather than only low levels.
  const preferred = limit === 1 ? [levels[Math.floor(levels.length / 2)]]
    : Array.from({ length: Math.min(limit, levels.length) }, (_, i) => levels[Math.round(i * (levels.length - 1) / (Math.min(limit, levels.length) - 1 || 1))]);
  const order = [...new Set([...preferred, ...levels])].filter(level => level !== undefined);
  const labels = [];
  for (const level of order) {
    const candidate = groups.get(level).sort((a, b) => b.score - a.score)
      .find(item => labels.every(label => !overlaps(item.bounds, label.bounds)));
    if (!candidate) continue;
    const { score, ...label } = candidate;
    labels.push({ level, ...label });
    if (labels.length >= limit) break;
  }
  return labels.sort((a, b) => a.level - b.level);
}
