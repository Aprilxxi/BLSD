const finite = value => typeof value === 'number' && Number.isFinite(value);
const validPoint = point => Array.isArray(point) && finite(point[0]) && finite(point[1]);
const samePoint = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

function clipInterval(a, b, rect) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (!finite(dx) || !finite(dy)) return null;
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - rect.x, rect.x + rect.width - a[0], a[1] - rect.y, rect.y + rect.height - a[1]];
  let start = 0, end = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; }
    else {
      const position = q[i] / p[i];
      if (p[i] < 0) start = Math.max(start, position);
      else end = Math.min(end, position);
      if (start > end) return null;
    }
  }
  return [start, end];
}

function labelGap(label) {
  if (![label?.x, label?.y, label?.rotation, label?.width, label?.height].every(finite) || label.width <= 0 || label.height <= 0) return null;
  const cosine = Math.cos(label.rotation), sine = Math.sin(label.rotation);
  return {
    // ECharts rotation is positive CCW in downward-y pixel coordinates.
    local: point => {
      const x = point[0] - label.x, y = point[1] - label.y;
      return [cosine * x - sine * y, sine * x + cosine * y];
    },
    rect: { x: -label.width / 2, y: -label.height / 2, width: label.width, height: label.height },
  };
}

function segmentPieces(a, b, rect, gaps) {
  const visible = clipInterval(a, b, rect);
  if (!visible) return [];
  const cuts = gaps.flatMap(gap => {
    const localA = gap.local(a), localB = gap.local(b);
    if (!validPoint(localA) || !validPoint(localB)) return [];
    const interval = clipInterval(localA, localB, gap.rect);
    if (!interval) return [];
    const start = Math.max(visible[0], interval[0]), end = Math.min(visible[1], interval[1]);
    return end > start ? [[start, end]] : [];
  }).sort((left, right) => left[0] - right[0]);
  const pieces = [];
  let cursor = visible[0];
  for (const [start, end] of cuts) {
    if (start > cursor) pieces.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < visible[1]) pieces.push([cursor, visible[1]]);
  const at = t => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  return pieces.map(([start, end]) => [at(start), at(end)]).filter(([start, end]) => !samePoint(start, end));
}

/**
 * Project retained paths and cut only each label's own level under its glyph box.
 * Long segments are split at exact rectangle intersections, even when neither
 * endpoint is inside. Returned points are disposable pixels; inputs stay intact.
 */
export function contourInlinePaths(contours, labels, dataToPixel, plotRect) {
  if (!Array.isArray(contours) || typeof dataToPixel !== 'function' || !plotRect ||
      ![plotRect.x, plotRect.y, plotRect.width, plotRect.height, plotRect.x + plotRect.width, plotRect.y + plotRect.height].every(finite) ||
      plotRect.width <= 0 || plotRect.height <= 0) return [];
  const gaps = new Map();
  for (const label of Array.isArray(labels) ? labels : []) {
    if (!finite(label?.level)) continue;
    const gap = labelGap(label);
    if (!gap) continue;
    if (!gaps.has(label.level)) gaps.set(label.level, []);
    gaps.get(label.level).push(gap);
  }
  const paths = [];
  for (const contour of contours) {
    if (!finite(contour?.level) || !Array.isArray(contour.points)) continue;
    let previous = null, current = [];
    const finish = () => { if (current.length > 1) paths.push({ level: contour.level, points: current }); current = []; };
    for (const point of contour.points) {
      let pixel = null;
      if (validPoint(point)) {
        try { pixel = dataToPixel([point[0], point[1]]); } catch { /* Unavailable coordinates break a path. */ }
      }
      if (!validPoint(pixel)) { previous = null; finish(); continue; }
      pixel = [pixel[0], pixel[1]];
      if (previous && !samePoint(previous, pixel)) {
        const pieces = segmentPieces(previous, pixel, plotRect, gaps.get(contour.level) || []);
        if (!pieces.length) finish();
        for (const [start, end] of pieces) {
          if (current.length && !samePoint(current.at(-1), start)) finish();
          if (!current.length) current.push(start);
          current.push(end);
        }
      }
      previous = pixel;
    }
    finish();
  }
  return paths;
}
