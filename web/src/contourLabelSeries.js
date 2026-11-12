import { placeContourLabels } from './contourLabels.js';
import { contourInlinePaths } from './contourInlinePaths.js';

/** Labels share the current Cartesian pixels on every render, including zoom/resize. */
export function contourLabelSeries(contours, anchor, font, { metric = 'surface' } = {}) {
  return {
    id: 'contour-labels', type: 'custom', coordinateSystem: 'cartesian2d',
    data: [anchor], encode: { x: 0, y: 1 }, silent: true, z: 6,
    tooltip: { show: false }, emphasis: { disabled: true },
    renderItem: (params, api) => {
      const toPixel = coordinate => api.coord(coordinate), rect = params.coordSys;
      const labels = placeContourLabels(contours, toPixel, rect, { fontSize: 12, maxLabels: 6, stagger: true });
      const lines = contourInlinePaths(contours, labels, toPixel, rect).map(path => ({
        type: 'polyline', silent: true, shape: { points: path.points },
        style: { fill: null, stroke: metric === 'surface' ? '#ffffff' : '#333333',
          lineWidth: metric === 'surface' ? 0.8 : 0.65, opacity: metric === 'surface' ? 0.88 : 0.45 },
      }));
      return {
        type: 'group', $mergeChildren: false,
        clipPath: { type: 'rect', shape: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } },
        children: [...lines, ...labels.map(label => ({
          type: 'text', x: label.x, y: label.y, rotation: label.rotation,
          silent: true, style: {
            text: label.text, fill: metric === 'surface' ? '#ffffff' : '#333333',
            align: 'center', verticalAlign: 'middle', font: `${label.fontSize}px ${font}`,
          },
        }))],
      };
    },
  };
}
