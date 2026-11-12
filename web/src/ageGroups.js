/** Closed integer ages [lower, upper + 1) used as model coordinates. */
export function parseAgeGroup(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+)\s*[-–]\s*(\d+)\s*(?:years|岁)?$/iu);
  if (!match) return null;
  const lower = Number(match[1]);
  const upper = Number(match[2]);
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || lower > upper) return null;
  const doubledMidpoint = BigInt(lower) + BigInt(upper) + 1n;
  const midpoint = Number(doubledMidpoint) / 2;
  if (!Number.isFinite(midpoint) || BigInt(midpoint * 2) !== doubledMidpoint) return null;
  return { lower, upper, midpoint, label: `${lower}–${upper}` };
}

/** Return only supplied closed age bounds, never infer bounds from Age_Mid. */
export function ageGroupsForRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = parseAgeGroup(row.Age_Group);
    if (!group) continue;
    const key = `${group.lower}:${group.upper}`;
    if (!groups.has(key)) groups.set(key, { midpoint: group.midpoint, lower: group.lower, upper: group.upper });
  }
  return [...groups.values()].sort((a, b) => a.midpoint - b.midpoint || a.lower - b.lower);
}
