import { parseAgeGroup } from './ageGroups.js';

function recognizedSex(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function derivationWarning(code, message) {
  return { code, row: null, column: 'Sex', message };
}

function ageBounds(row) {
  if (row.Age_Group === undefined) return null;
  const group = parseAgeGroup(row.Age_Group);
  return group && group.midpoint === row.Age_Mid ? group : false;
}

/** Sum matched counts/exposures only; rates and fitted quantities are never averaged. */
export function deriveBothRows(rows) {
  const unchanged = warning => ({ rows, derivedBoth: null, warning });
  if (!Array.isArray(rows) || rows.length === 0) return unchanged(null);

  const labels = new Set(rows.map(row => row.Sex).filter(label => typeof label === 'string'));
  if ([...labels].some(label => recognizedSex(label) === 'both')) return unchanged(null);
  const males = [...labels].filter(label => recognizedSex(label) === 'male');
  const females = [...labels].filter(label => recognizedSex(label) === 'female');
  if (males.length > 1 || females.length > 1) {
    return unchanged(derivationWarning('BOTH_GROUP_AMBIGUOUS', 'Both could not be combined: use one consistent Male label and one consistent Female label.'));
  }
  if (males.length !== 1 || females.length !== 1) return unchanged(null);

  const sourceSexes = [males[0], females[0]];
  const maleRows = rows.filter(row => row.Sex === sourceSexes[0]);
  const femaleRows = rows.filter(row => row.Sex === sourceSexes[1]);
  const mismatch = () => unchanged(derivationWarning('BOTH_GROUP_MISMATCH', 'Both could not be combined: Male and Female must contain the same periods and age groups, with matching age-range bounds.'));
  if (maleRows.length !== femaleRows.length) return mismatch();

  const key = row => JSON.stringify([row.Year, row.Age_Mid]);
  const maleKeys = new Set(maleRows.map(key));
  const femaleMap = new Map(femaleRows.map(row => [key(row), row]));
  if (maleKeys.size !== maleRows.length || femaleMap.size !== femaleRows.length) return mismatch();

  const bothRows = [];
  for (const male of maleRows) {
    const female = femaleMap.get(key(male));
    if (!female) return mismatch();
    const maleBounds = ageBounds(male);
    const femaleBounds = ageBounds(female);
    if (maleBounds === false || femaleBounds === false || Boolean(maleBounds) !== Boolean(femaleBounds) ||
        (maleBounds && (maleBounds.lower !== femaleBounds.lower || maleBounds.upper !== femaleBounds.upper))) return mismatch();

    const Deaths = male.Deaths + female.Deaths;
    const Pop = male.Pop + female.Pop;
    if (![male.Year, male.Age_Mid, male.Deaths, male.Pop, female.Year, female.Age_Mid, female.Deaths, female.Pop, Deaths, Pop].every(Number.isFinite) ||
        male.Deaths < 0 || female.Deaths < 0 || male.Pop <= 0 || female.Pop <= 0 || Pop <= 0) {
      return unchanged(derivationWarning('BOTH_GROUP_INVALID_SUM', 'Both could not be combined: counts and population sums must be finite, with nonnegative counts and positive populations.'));
    }
    bothRows.push({
      Year: male.Year,
      ...(maleBounds ? { Age_Group: maleBounds.label } : {}),
      Age_Mid: male.Age_Mid, Deaths, Pop, Sex: 'Both',
    });
  }
  bothRows.sort((a, b) => a.Year - b.Year || a.Age_Mid - b.Age_Mid);
  return {
    rows: [...rows, ...bothRows],
    derivedBoth: { sex: 'Both', sourceSexes, rows: bothRows.length, method: 'SUM_MATCHED_COUNTS_AND_EXPOSURE' },
    warning: null,
  };
}
