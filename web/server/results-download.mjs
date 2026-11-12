import { deflateRawSync } from 'node:zlib';

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Keep source strings inert in spreadsheet software, while numeric negatives remain numbers.
  const safe = typeof value === 'string' && /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function flattenRecord(record, prefix = '', output = {}) {
  for (const [key, value] of Object.entries(record ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenRecord(value, name, output);
    else if (Array.isArray(value) && value.length === 2 && value.every(x => x === null || typeof x === 'number')) {
      output[`${name}.lower95`] = value[0]; output[`${name}.upper95`] = value[1];
    } else output[name] = value;
  }
  return output;
}

export function tableCsv(rows) {
  const flat = rows.map(row => flattenRecord(row));
  const columns = [...new Set(flat.flatMap(row => Object.keys(row)))];
  return '\uFEFF' + [columns.map(csvCell).join(','), ...flat.map(row => columns.map(c => csvCell(row[c])).join(','))].join('\r\n');
}

/** Public downloads use event-count names, including older retained results. */
export function publicCountResult(value, parentKey = '') {
  if (Array.isArray(value)) return value.map(entry => publicCountResult(entry, parentKey));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && ['formula', 'inputFormat'].includes(parentKey)
      ? value.replace(/\bDeaths\b/g, 'Count') : value;
  }
  const aliases = { Deaths: 'Count', deaths: 'count', fittedDeaths: 'fittedCount', nonIntegerDeaths: 'nonIntegerCount' };
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = aliases[key] ?? key;
    // Prefer the new name when a response also contains a compatibility alias.
    if (name !== key && Object.hasOwn(value, name)) continue;
    output[name] = publicCountResult(entry, name);
  }
  return output;
}

export function resultTables(result) {
  result = publicCountResult(result);
  return {
    standardized_input: result.input ?? [],
    prediction_grid: result.points ?? [],
    residuals: result.residuals ?? [],
    age_sections: result.ageSections?.points ?? [],
    age_sections_observed: result.ageSections?.observed ?? [],
    time_trends: result.timeTrends?.points ?? [],
    time_trends_observed: result.timeTrends?.observed ?? [],
    cohort_smooth: result.cohortSmooth ?? [],
    observed_predictions: result.observedPredictions ?? [],
    contours: Object.entries(result.contours ?? {}).flatMap(([metric, lines]) =>
      (lines ?? []).map(line => ({ metric, level: line.level, points: line.points }))),
    analysis_metadata: [{ schemaVersion: result.schemaVersion, fitId: result.fitId,
      meta: result.meta, settings: result.settings, diagnostics: result.diagnostics,
      parameters: result.parameters, units: result.units ?? result.meta?.units, defaults: result.defaults, grid: result.grid }],
    input_provenance: [{ provenance: result.provenance ?? null }],
  };
}

// A CSV download includes every table. The ZIP offers the same tables separately.
export function completeResultCsv(result) {
  const rows = Object.entries(resultTables(result)).flatMap(([table, entries]) => entries.map((row, index) => ({ Table: table, Record: index + 1, ...flattenRecord(row) })));
  return tableCsv(rows);
}

let crcTable;
function crc32(bytes) {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, i) => {
    let crc = i; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; return crc >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

/** In-memory ZIP with fixed, generated names; no filesystem paths or external archiver. */
export function zipFiles(files) {
  const chunks = [], central = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const filename = Buffer.from(name, 'utf8'), bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const packed = deflateRawSync(bytes); const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    chunks.push(local, filename, packed); central.push(entry, filename); offset += local.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

export function completeResultZip(result, rds) {
  result = publicCountResult(result);
  const files = {
    'results.json': JSON.stringify(result),
    'metadata.json': JSON.stringify({ schemaVersion: result.schemaVersion, fitId: result.fitId,
      meta: result.meta, settings: result.settings, diagnostics: result.diagnostics,
      parameters: result.parameters, units: result.units ?? result.meta?.units, grid: result.grid, defaults: result.defaults }),
    'provenance.json': JSON.stringify(result.provenance ?? null),
    'contours.json': JSON.stringify(result.contours ?? {}),
    'README.txt': 'BLSD complete retained result. All tables, figures and intervals use the same saved model and coefficient draws. Empty CSV fields / JSON null are unavailable display values; raw values and mask reasons are separate fields. 95% UI denotes approximate pointwise model uncertainty intervals, using the 2.5% and 97.5% quantiles of fitted quantities from joint Gaussian coefficient draws. Input-estimation uncertainty and future-observation variation are not propagated. These are not prediction intervals (PI) or simultaneous uncertainty bands, and exact frequentist pointwise coverage is not asserted for all derived quantities. The fit.rds retains the fitted R model and betaDraws. fitId is a temporary local cache identifier, not a permanent sharing link. CSV Table names identify heterogeneous rows. Source strings beginning with spreadsheet formula operators are escaped with a leading apostrophe. JSON preserves the original source strings.\n',
    'fit.rds': rds,
  };
  for (const [name, rows] of Object.entries(resultTables(result))) files[`${name}.csv`] = tableCsv(rows);
  return zipFiles(files);
}
