const finite = value => typeof value === 'number' && Number.isFinite(value);
const isObservation = point => point && finite(point.year) && finite(point.age) &&
  finite(point.fittedRate) && point.fittedRate > 0 && finite(point.devianceResidual);

/** Plot retained fitted rates directly; the log axis changes spacing, never these values. */
export function residualScatterData(result) {
  return (Array.isArray(result?.residuals) ? result.residuals : []).filter(isObservation)
    .map(point => ({ value: [point.fittedRate, point.devianceResidual, point.age], source: point }));
}

/** Select only a retained observed residual; prediction-grid cells are not observations. */
export function nearestResidualObservation(result, year, age) {
  if (!finite(year) || !finite(age)) return null;
  const observations = (Array.isArray(result?.residuals) ? result.residuals : []).filter(isObservation);
  if (!observations.length) return null;
  const exact = observations.find(point => point.year === year && point.age === age);
  if (exact) return exact;
  const years = observations.map(point => point.year), ages = observations.map(point => point.age);
  const yearSpan = Math.max(1, Math.max(...years) - Math.min(...years));
  const ageSpan = Math.max(1, Math.max(...ages) - Math.min(...ages));
  let nearest = null, shortest = Infinity;
  for (const point of observations) {
    const distance = ((point.year - year) / yearSpan) ** 2 + ((point.age - age) / ageSpan) ** 2;
    if (distance < shortest) { shortest = distance; nearest = point; }
  }
  return nearest;
}

/** Resolve chart event data back to its actual row before passing coordinates to the inspector. */
export function residualObservationSelection(result, source) {
  if (!isObservation(source) || !Array.isArray(result?.residuals)) return null;
  const residualIndex = result.residuals.findIndex(point => isObservation(point) &&
    point.year === source.year && point.age === source.age);
  if (residualIndex < 0) return null;
  const point = result.residuals[residualIndex];
  return { year: point.year, age: point.age, residualIndex };
}
