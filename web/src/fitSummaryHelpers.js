export function formatPValue(value, { permutations } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  if (Number.isInteger(permutations) && permutations > 0) {
    if (value === 0) return `<${Number((1 / permutations).toPrecision(3))}`;
    return value.toFixed(Math.max(3, Math.min(6, Math.ceil(Math.log10(permutations)) + 1)));
  }
  return value < 0.001 ? '<0.001' : value.toFixed(3);
}

export function jointSmoothDiagnostics(diagnostics = {}) {
  const tests = Array.isArray(diagnostics.smoothTests) ? diagnostics.smoothTests : [];
  const smooth = tests.find(test => /Year/.test(test.term || '') && /Age_Mid/.test(test.term || '')) ||
    (tests.length === 1 ? tests[0] : null);
  const checks = Array.isArray(diagnostics.basisChecks) ? diagnostics.basisChecks : [];
  return { smooth, basis: smooth ? checks.find(check => check.term === smooth.term) || null : null };
}
