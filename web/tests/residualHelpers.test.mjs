import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestResidualObservation, residualObservationSelection, residualScatterData } from '../src/residualHelpers.js';

const observations = Object.freeze([
  Object.freeze({ year: 2000, age: 32.5, cohort: 1967.5, devianceResidual: -1.2, observedRate: 12.8, fittedRate: 13.4 }),
  Object.freeze({ year: 2005, age: 42.5, cohort: 1962.5, devianceResidual: 0.8, observedRate: 27.1, fittedRate: 25.9 }),
  Object.freeze({ year: 2010, age: 52.5, cohort: 1957.5, devianceResidual: 0, observedRate: 58, fittedRate: 58 }),
]);
const result = Object.freeze({ residuals: observations,
  grid: { years: [2000, 2005, 2010], ages: [32.5, 40, 42.5, 52.5] },
  points: [{ year: 2005, age: 40, rate: 22, devianceResidual: 999 }] });

test('the residual inspector selects a retained observation, never a dense prediction cell', () => {
  const selected = nearestResidualObservation(result, 2005, 40);
  assert.equal(selected, observations[1]);
  assert.equal(selected.devianceResidual, 0.8);
  assert.equal(selected.age, 42.5);
  assert.equal(selected.observedRate, 27.1);
  assert.equal(selected.fittedRate, 25.9);
});

test('an exact clicked observation keeps its original coordinates and all values', () => {
  for (const observation of observations) {
    assert.equal(nearestResidualObservation(result, observation.year, observation.age), observation);
  }
  assert.deepEqual(residualObservationSelection(result, observations[1]), { year: 2005, age: 42.5, residualIndex: 1 });
  assert.deepEqual(residualObservationSelection(result, { ...observations[1] }), { year: 2005, age: 42.5, residualIndex: 1 });
});

test('a chart event cannot invent an unobserved residual row', () => {
  assert.equal(residualObservationSelection(result, { ...observations[1], age: 40 }), null);
  assert.equal(residualObservationSelection(result, result.points[0]), null);
  assert.equal(residualObservationSelection(result, null), null);
});

test('empty or nonfinite residuals and unselected coordinates produce no numerical readout', () => {
  assert.equal(nearestResidualObservation(result, null, null), null);
  assert.equal(nearestResidualObservation(result, '2005', 42.5), null);
  assert.equal(nearestResidualObservation(result, NaN, 42.5), null);
  assert.equal(nearestResidualObservation({ residuals: [] }, 2005, 42.5), null);
  assert.equal(nearestResidualObservation({ residuals: [{ year: 2005, age: 42.5, cohort: 1962.5, devianceResidual: null }] }, 2005, 42.5), null);
  assert.equal(nearestResidualObservation(null, 2005, 42.5), null);
});

test('sparse residual lookup returns an available observation with unchanged zero residual', () => {
  assert.equal(nearestResidualObservation(result, 2008, 51), observations[2]);
  assert.equal(nearestResidualObservation(result, 2008, 51).devianceResidual, 0);
});

test('residual scatter uses the actual fitted rate, residual and age without a cohort coordinate or transformation', () => {
  const displayed = residualScatterData(result);
  assert.deepEqual(displayed.map(point => point.value), observations.map(point => [point.fittedRate, point.devianceResidual, point.age]));
  displayed.forEach((point, index) => assert.equal(point.source, observations[index]));
  const noCohort = { year: 2000, age: 32.5, fittedRate: 13.4, devianceResidual: -1.2 };
  assert.deepEqual(residualScatterData({ residuals: [noCohort] }), [{ value: [13.4, -1.2, 32.5], source: noCohort }]);
  assert.equal(nearestResidualObservation({ residuals: [noCohort] }, 2000, 32.5), noCohort);
});

test('a logarithmic fitted-rate axis only displays actual positive finite fitted rates and finite residuals', () => {
  const invalid = [0, -1, Infinity, NaN, null, '13.4'].map(fittedRate => ({ ...observations[0], fittedRate }));
  invalid.push({ ...observations[0], devianceResidual: null }, { ...observations[0], devianceResidual: Infinity });
  assert.deepEqual(residualScatterData({ residuals: invalid }), []);
  assert.equal(nearestResidualObservation({ residuals: invalid }, 2000, 32.5), null);
  invalid.forEach(point => assert.equal(residualObservationSelection({ residuals: invalid }, point), null));
  assert.deepEqual(residualScatterData(null), []);
});
