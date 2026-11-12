import viridis from './generated/referenceViridis.json' with { type: 'json' };

// The scientific palette follows the supplied R figures. Interpolation is in
// CIE Lab, as in ggplot2's gradient scales, rather than browser RGB blending.
export const VIRIDIS = viridis;
export const AGE_PALETTE = ['#346D8C', '#F7F5F0', '#CE8D5E'];
export const SIGNED_PALETTE = ['#2166AC', '#FFFFFF', '#B2182B'];
export const PERIOD_COLORS = ['#F8766D', '#00BA38', '#619CFF'];
export const TREND_LINE = '#2166AC';
export const TREND_RIBBON = '#2C7FB8';

function toLab(hex) {
  const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb;
  const f = v => v > 216 / 24389 ? Math.cbrt(v) : v * 841 / 108 + 4 / 29;
  const x = f((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047);
  const y = f(r * 0.2126729 + g * 0.7151522 + b * 0.0721750);
  const z = f((r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function fromLab([l, a, b]) {
  const y = (l + 16) / 116, x = y + a / 500, z = y - b / 200;
  const f = v => v ** 3 > 216 / 24389 ? v ** 3 : (v - 4 / 29) * 108 / 841;
  const xx = f(x) * 0.95047, yy = f(y), zz = f(z) * 1.08883;
  const rgb = [xx * 3.2404542 - yy * 1.5371385 - zz * 0.4985314,
    -xx * 0.9692660 + yy * 1.8760108 + zz * 0.0415560,
    xx * 0.0556434 - yy * 0.2040259 + zz * 1.0572252];
  return `#${rgb.map(v => Math.round(Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)) * 255).toString(16).padStart(2, '0')).join('')}`;
}
export function labColor(palette, fraction) {
  const value = Math.max(0, Math.min(1, fraction)) * (palette.length - 1);
  const i = Math.min(palette.length - 2, Math.floor(value)), weight = value - i;
  const a = toLab(palette[i]), b = toLab(palette[i + 1]);
  return fromLab(a.map((v, j) => v + (b[j] - v) * weight));
}
export function figurePalette(metric, range) {
  if (metric === 'surface' || metric === 'residuals') return VIRIDIS;
  const base = ['annual', 'acceleration'].includes(metric) ? SIGNED_PALETTE : AGE_PALETTE;
  const extent = Math.max(Math.abs(range.min), Math.abs(range.max)) || 1;
  return Array.from({ length: 256 }, (_, i) => {
    const fraction = i / 255;
    // Age gradient is a sequential full-range scale; annual change and the
    // ratio/acceleration keep their neutral colour at the actual numeric zero.
    return labColor(base, metric === 'gradient' ? fraction :
      0.5 + (range.min + (range.max - range.min) * fraction) / (2 * extent));
  });
}
