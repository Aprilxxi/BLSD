import test from 'node:test';
import assert from 'node:assert/strict';
import { figurePalette, labColor, AGE_PALETTE, PERIOD_COLORS, VIRIDIS } from '../src/figureStyle.js';

test('reference palettes distinguish full-range gradient from signed annual and shift', () => {
  assert.equal(figurePalette('surface', { min: 1, max: 10 }), VIRIDIS);
  assert.deepEqual([VIRIDIS[0], VIRIDIS.at(-1)], ['#440154', '#FDE725']);
  const gradient = figurePalette('gradient', { min: 6, max: 16 });
  assert.equal(gradient[0].toUpperCase(), AGE_PALETTE[0]);
  assert.equal(gradient.at(-1).toUpperCase(), AGE_PALETTE[2]);
  const negativeAnnual = figurePalette('annual', { min: -8, max: 0 });
  assert.equal(negativeAnnual[0].toUpperCase(), '#2166AC');
  assert.equal(negativeAnnual.at(-1).toUpperCase(), '#FFFFFF');
  assert.equal(labColor(AGE_PALETTE, 0.5).toUpperCase(), '#F7F5F0');
  assert.deepEqual(PERIOD_COLORS, ['#F8766D', '#00BA38', '#619CFF']);
});
