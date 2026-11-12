import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createJobLifecycle } from './job-lifecycle.mjs';
import { createAsyncTaskManager, bufferedTaskResponse } from './async-tasks.mjs';
import { createTaskResultStore } from './task-results.mjs';
import { completeResultCsv, completeResultZip, publicCountResult, zipFiles } from './results-download.mjs';
import { readableResultCsv, readableResultZip } from './readable-results.mjs';
import { resultWorkbook } from './results-workbook.mjs';
import { analysisWorkbookZip, analysisResultZip, analysisGroupPath } from './analysis-downloads.mjs';
import { parseAgeGroup, ageGroupsForRows } from '../src/ageGroups.js';
import { deriveBothRows } from '../src/bothGroups.js';

const execFileAsync = promisify(execFile);
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const METHODS = new Set(['quasi-gcv', 'quasi-reml', 'nb-reml']);
const METRICS = new Set(['surface', 'annual', 'acceleration', 'gradient', 'shift', 'ageSections', 'timeTrends', 'residuals']);
const EXPORT_FORMATS = { pdf: 'application/pdf', png: 'image/png', tiff: 'image/tiff' };
const FIGURE_BUNDLE = [
  ['surface', '01_fitted_surface'], ['annual', '02_annual_rate_change'],
  ['acceleration', '03_log_rate_acceleration'], ['ageSections', '04_age_sections'],
  ['timeTrends', '05_age_specific_time_trends'], ['gradient', '06_age_gradient'],
  ['shift', '07_equivalent_age_shift'], ['residuals', '08_fitted_residuals'],
];
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_FIGURE_CACHE_BYTES = 64 * 1024 * 1024;
const FIT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DEFAULT_SETTINGS = { method: 'quasi-gcv', draws: 1000, seed: 123, kAge: 10, kYear: 10, threshold: 0.005 };

class ApiError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new ApiError(code, message, status); };

function throwIfCancelled(signal) {
  if (signal?.aborted) fail('REQUEST_CANCELLED', 'This analysis was cancelled.', 499);
}

/** Forwarded identities are accepted only from an explicitly trusted local proxy. */
export function clientRateLimitAddress(req, trustProxy) {
  const remote = req.socket.remoteAddress ?? 'local';
  const local = remote === '::1' || (isIP(remote) === 4 && remote.startsWith('127.')) ||
    (remote.toLowerCase().startsWith('::ffff:') && isIP(remote.slice(7)) === 4 && remote.slice(7).startsWith('127.'));
  const forwarded = req.headers['x-real-ip'];
  if (trustProxy === 'loopback' && local && typeof forwarded === 'string' && isIP(forwarded.trim()))
    return forwarded.trim();
  return remote;
}

function requestCancellation(req, res) {
  const controller = new AbortController();
  const cancel = () => { if (!res.writableFinished) controller.abort(); };
  req.once('aborted', cancel);
  res.once('close', cancel);
  if (req.aborted || res.destroyed) controller.abort();
  return { signal: controller.signal, cancel: () => controller.abort(), dispose() { req.off('aborted', cancel); res.off('close', cancel); } };
}

function safeError(error) {
  return { code: error instanceof ApiError ? error.code : 'SERVER_ERROR',
    message: error instanceof ApiError ? error.message : 'The local model service could not complete this request.' };
}

function sexFilenameSuffix(sex) {
  if (typeof sex !== 'string' || !sex.trim()) return '';
  let label = Buffer.from(sex.trim(), 'utf8').toString('utf8').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^\.+|[. ]+$/g, '');
  while (Buffer.byteLength(label, 'utf8') > 120) label = Array.from(label).slice(0, -1).join('');
  return `_${label || 'Group'}`;
}

function attachmentDisposition(filename) {
  // Quoted ASCII fallback plus RFC 5987 preserves Chinese/other UTF-8 labels.
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function validateSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_SETTINGS', 'Model settings must be an object.');
  const settings = { ...DEFAULT_SETTINGS, method: input.method ?? DEFAULT_SETTINGS.method };
  if (!METHODS.has(settings.method)) fail('INVALID_SETTINGS', 'The fitting method is unsupported.');
  for (const [key, min, max, integer] of [['draws', 100, 10000, true], ['seed', 0, 2147483647, true],
    ['kAge', 4, 40, true], ['kYear', 4, 40, true], ['threshold', Number.MIN_VALUE, 1, false]]) {
    const raw = input[key] ?? settings[key];
    if ((typeof raw !== 'number' && typeof raw !== 'string') || (typeof raw === 'string' && !raw.trim()))
      fail('INVALID_SETTINGS', 'Model settings contain an invalid numeric value.');
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      fail('INVALID_SETTINGS', 'Model settings are outside the supported ranges.');
    settings[key] = value;
  }
  return settings;
}

function validateProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) || JSON.stringify(provenance).length > 1024 * 1024)
    fail('INVALID_DATA', 'Input provenance must be a small metadata object.');
  return provenance;
}

// Count is the public response variable. Keep the retained R model's existing
// internal name so relabelling input cannot alter its fit or coefficient draws.
function normalizeCountRecord(row) {
  if (Object.hasOwn(row, 'Count') && Object.hasOwn(row, 'count'))
    fail('DUPLICATE_COLUMN', 'Use one Count column.');
  const columns = ['Count', 'count', 'Deaths'].filter(column => Object.hasOwn(row, column));
  if (!columns.length || columns.some(column => typeof row[column] !== 'number' || !Number.isFinite(row[column])))
    fail('INVALID_DATA', 'Count must contain finite numbers.');
  if (columns.some(column => row[column] !== row[columns[0]]))
    fail('CONFLICTING_COUNT_COLUMNS', 'Count and legacy count columns must contain the same values when supplied together.');
  const { Count: _count, count: _lowercaseCount, ...normalized } = row;
  normalized.Deaths = row[columns[0]];
  return normalized;
}

export function validateFitRequest(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > 100000)
    fail('INVALID_DATA', 'A nonempty data table of at most 100,000 rows is required.');
  const seen = new Set(), years = new Set(), ages = new Set(), sexes = new Set(), ageGroups = new Map();
  const rows = body.rows.map(sourceRow => {
    const row = sourceRow && typeof sourceRow === 'object' ? normalizeCountRecord(sourceRow) : sourceRow;
    if (!row || typeof row !== 'object') fail('INVALID_DATA', 'Each observation must be a numeric record.');
    const clean = {};
    for (const column of ['Year', 'Age_Mid', 'Deaths', 'Pop']) {
      if (typeof row[column] !== 'number' || !Number.isFinite(row[column]))
        fail('INVALID_DATA', 'All four required columns must contain finite numbers.');
      clean[column] = row[column];
    }
    if (row.Age_Group !== undefined) {
      const group = parseAgeGroup(row.Age_Group);
      if (!group || group.midpoint !== clean.Age_Mid)
        fail('INVALID_DATA', 'Age_Group must be a closed integer age range matching Age_Mid.');
      const previous = ageGroups.get(group.midpoint);
      if (previous && (previous.lower !== group.lower || previous.upper !== group.upper))
        fail('INVALID_DATA', 'Each age midpoint must refer to one consistent age group.');
      ageGroups.set(group.midpoint, group);
      clean.Age_Group = group.label;
    }
    if (row.Sex !== undefined) {
      if (typeof row.Sex !== 'string' || !row.Sex.trim() || row.Sex.length > 100)
        fail('INVALID_DATA', 'Sex must be a nonempty label when supplied.');
      clean.Sex = row.Sex.trim();
    }
    sexes.add(clean.Sex ?? '');
    if (clean.Deaths < 0 || clean.Pop <= 0) fail('INVALID_DATA', 'Count must be nonnegative and population exposure positive.');
    const key = `${clean.Year}|${clean.Age_Mid}`;
    if (seen.has(key)) fail('DUPLICATE_YEAR_AGE', 'Each age and year combination must occur once.');
    seen.add(key); years.add(clean.Year); ages.add(clean.Age_Mid);
    return clean;
  });
  const sortedGroups = [...ageGroups.values()].sort((a, b) => a.lower - b.lower);
  if (sortedGroups.some((group, index) => index > 0 && group.lower <= sortedGroups[index - 1].upper))
    fail('INVALID_DATA', 'Age groups must not overlap within one sex group.');
  if (sexes.size > 1) fail('MIXED_SEX_GROUPS', 'Select one sex group for each independent fit.');
  if (years.size < 5 || ages.size < 5) fail('INSUFFICIENT_DOMAIN', 'At least five distinct years and ages are required.');
  const settings = validateSettings(body.settings ?? {});
  // Match the core model's explicit unique-count minus one restriction.
  settings.kAge = Math.min(settings.kAge, ages.size - 1);
  settings.kYear = Math.min(settings.kYear, years.size - 1);
  if (rows.length <= settings.kAge * settings.kYear)
    fail('INSUFFICIENT_DATA', 'There are too few observations for the requested basis dimensions.');
  let provenance = validateProvenance(body.provenance ?? {
    inputFormat: ageGroups.size ? 'Year,Age_Group,Count,Pop' : 'Year,Age_Mid,Count,Pop', sex: rows[0].Sex ?? null,
  });
  if (ageGroups.size) provenance = { ...provenance, ageGroups: ageGroupsForRows(rows) };
  return { rows, settings, provenance };
}

/** Each selected group goes through the single-fit contract separately. */
export function validateGroupFitRequest(body, maxGroups = 32) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > 100000)
    fail('INVALID_DATA', 'A nonempty data table of at most 100,000 rows is required.');
  const settings = validateSettings(body.settings ?? {});
  const inputProvenance = validateProvenance(body.provenance ?? {
    inputFormat: body.rows.some(row => row?.Age_Group !== undefined) ? 'Year,Age_Group,Count,Pop' : 'Year,Age_Mid,Count,Pop',
  });
  // The server establishes derivation from source rows; a client metadata flag
  // cannot turn submitted Both observations into a verified combined group.
  const { derivedBoth: _unverifiedDerivation, ...provenance } = inputProvenance;
  const bySex = new Map();
  for (const row of body.rows) {
    if (!row || typeof row !== 'object') fail('INVALID_DATA', 'Each observation must be a numeric record.');
    let sex = null;
    if (row.Sex !== undefined) {
      if (typeof row.Sex !== 'string' || !row.Sex.trim() || row.Sex.length > 100)
        fail('INVALID_DATA', 'Sex must be a nonempty label when supplied.');
      sex = row.Sex.trim();
    }
    if (!bySex.has(sex)) bySex.set(sex, []);
    bySex.get(sex).push(sex === null ? row : { ...row, Sex: sex });
  }
  const groupProvenanceFor = (sex, groupRows) => {
    const groupAges = new Set(groupRows.map(row => row.Age_Mid));
    const groupProvenance = { ...provenance, sex };
    // Labelled rows supply their own true bounds in validateFitRequest. For
    // existing midpoint clients, retain only supplied bounds used by this fit.
    if (Array.isArray(provenance.ageGroups)) groupProvenance.ageGroups = provenance.ageGroups.filter(group =>
      group && groupAges.has(group.midpoint) && (group.sex === undefined || group.sex === sex));
    return groupProvenance;
  };
  let derivedBoth = null, derivedAgeGroups = null;
  const hasBoth = [...bySex.keys()].some(sex => typeof sex === 'string' && sex.toLowerCase() === 'both');
  if (!hasBoth) {
    const sourceSexes = [...bySex.keys()].filter(sex => typeof sex === 'string' && ['male', 'female'].includes(sex.toLowerCase()));
    try {
      // Invalid source groups remain independent per-group failures. They must
      // never supply an apparently valid combined group through cancellation.
      const sourceRequests = sourceSexes.map(sex => {
        const sourceRows = bySex.get(sex), sourceProvenance = groupProvenanceFor(sex, sourceRows);
        try { return validateFitRequest({ rows: sourceRows, settings, provenance: sourceProvenance }); }
        catch (error) {
          // Domain and basis-size failures occur after every cell and supplied
          // age range is checked. Keep them as each derived/source fit's own
          // failure, rather than blocking unrelated selected groups.
          if (!['INSUFFICIENT_DOMAIN', 'INSUFFICIENT_DATA'].includes(error.code)) throw error;
          if (sourceRows.some(row => row.Age_Group !== undefined)) sourceProvenance.ageGroups = ageGroupsForRows(sourceRows);
          return { rows: sourceRows.map(normalizeCountRecord), provenance: sourceProvenance };
        }
      });
      const prepared = deriveBothRows(sourceRequests.flatMap(request => request.rows));
      if (prepared.derivedBoth) {
        // Known bounds supplied by legacy midpoint clients must also agree.
        const bounds = sourceRequests.map(request => request.provenance.ageGroups);
        const comparableBounds = groups => groups.map(({ midpoint, lower, upper }) => ({ midpoint, lower, upper }))
          .sort((a, b) => a.midpoint - b.midpoint);
        const boundsAgree = bounds.every(groups => !Array.isArray(groups)) ||
          (bounds.every(Array.isArray) && JSON.stringify(comparableBounds(bounds[0])) === JSON.stringify(comparableBounds(bounds[1])));
        if (boundsAgree) {
          derivedBoth = prepared.derivedBoth;
          derivedAgeGroups = Array.isArray(bounds[0]) ? comparableBounds(bounds[0]) : null;
          bySex.set(derivedBoth.sex, prepared.rows.filter(row => row.Sex === derivedBoth.sex));
        }
      }
    } catch { /* Only verified matched sources make Both available. */ }
  }
  let selected = body.selectedSexes;
  if (selected === undefined) {
    if (bySex.size !== 1) fail('INVALID_GROUP_SELECTION', 'Select the sex groups to fit independently.');
    selected = [...bySex.keys()];
  }
  if (!Array.isArray(selected) || !selected.length || selected.some(sex => sex !== null && (typeof sex !== 'string' || !sex.trim())))
    fail('INVALID_GROUP_SELECTION', 'Select at least one available sex group.');
  selected = selected.map(sex => sex === null ? null : sex.trim());
  if (new Set(selected).size !== selected.length || selected.some(sex => !bySex.has(sex)))
    fail('INVALID_GROUP_SELECTION', 'Selected sex groups must be unique and present in the data.');
  if (selected.length > maxGroups) fail('TOO_MANY_GROUPS', `Select at most ${maxGroups} groups per analysis.`, 413);
  return selected.map(sex => {
    try {
      const groupRows = bySex.get(sex);
      const groupProvenance = groupProvenanceFor(sex, groupRows);
      if (derivedBoth && sex === derivedBoth.sex) {
        groupProvenance.derivedBoth = derivedBoth;
        if (derivedAgeGroups) groupProvenance.ageGroups = derivedAgeGroups;
      }
      return { sex, request: validateFitRequest({ rows: groupRows, settings, provenance: groupProvenance }) };
    } catch (error) { return { sex, error: safeError(error) }; }
  });
}

export function validateExportRequest(body) {
  if (!body || !FIT_ID.test(body.fitId ?? '')) fail('INVALID_EXPORT_SETTINGS', 'A valid retained fit is required.');
  const result = { fitId: body.fitId, metric: body.metric, format: body.format, locale: body.locale ?? 'en',
    widthMm: Number(body.widthMm ?? 180), dpi: Number(body.dpi ?? 600) };
  if (!METRICS.has(result.metric) || typeof result.format !== 'string' || !Object.hasOwn(EXPORT_FORMATS, result.format) ||
      !['en', 'zh'].includes(result.locale) || result.widthMm !== 180 || result.dpi !== 600)
    fail('INVALID_EXPORT_SETTINGS', 'The export format or figure settings are unsupported.');
  for (const name of ['showContours', 'showIntervals']) {
    if (body[name] !== undefined && typeof body[name] !== 'boolean')
      fail('INVALID_EXPORT_SETTINGS', 'Figure display switches must be boolean values.');
    result[name] = body[name] ?? true;
  }
  for (const name of ['sectionYears', 'trendAges']) {
    if (body[name] !== undefined) {
      if (!Array.isArray(body[name]) || !body[name].length ||
          body[name].some(x => typeof x !== 'number' || !Number.isFinite(x)))
        fail('INVALID_EXPORT_SETTINGS', 'Selected curve coordinates must be finite numbers.');
      result[name] = [...new Set(body[name])];
    }
  }
  return result;
}

async function resolveRscript(explicit) {
  async function directRuntime(candidate) {
    // Windows installations also ship a bin/ launcher. Prefer the real
    // executable so cancelling a child always stops the R computation itself.
    if (process.platform === 'win32' && path.basename(candidate).toLowerCase() === 'rscript.exe' &&
        path.basename(path.dirname(candidate)).toLowerCase() === 'bin') {
      const direct = path.join(path.dirname(candidate), 'x64', 'Rscript.exe');
      try { if ((await stat(direct)).isFile()) return direct; } catch { /* use the supplied executable */ }
    }
    return candidate;
  }
  if (explicit || process.env.BLSD_RSCRIPT) return directRuntime(explicit || process.env.BLSD_RSCRIPT);
  const baseDirs = [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'R'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'R'),
    process.platform === 'win32' && path.join(path.parse(SERVER_DIR).root, 'Program Files', 'R')].filter(Boolean);
  for (const base of baseDirs) {
    let versions = [];
    try { versions = (await readdir(base)).sort().reverse(); } catch { continue; }
    for (const version of versions) {
      for (const suffix of [['bin', 'x64', 'Rscript.exe'], ['bin', 'Rscript.exe']]) {
        const candidate = path.join(base, version, ...suffix);
        try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* next candidate */ }
      }
    }
  }
  return 'Rscript';
}

async function readJson(req, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    fail('UNSUPPORTED_CONTENT_TYPE', 'Send an application/json request.', 415);
  if (Number(req.headers['content-length']) > limit) { req.resume(); fail('BODY_TOO_LARGE', 'The request is too large.', 413); }
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) { req.resume(); fail('BODY_TOO_LARGE', 'The request is too large.', 413); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('INVALID_JSON', 'The request body is not valid JSON.'); }
}

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

/** Vite/Connect-compatible middleware. All R execution uses fixed files, no shell. */
export function createBlsdMiddleware(options = {}) {
  const jobRoot = path.resolve(options.jobRoot ?? path.join(SERVER_DIR, '.jobs'));
  const adapter = path.resolve(options.adapterPath ?? path.join(SERVER_DIR, 'blsd_adapter.R'));
  const exporter = path.resolve(options.exporterPath ?? path.join(SERVER_DIR, 'blsd_export.R'));
  const timeout = options.timeoutMs ?? 180000;
  const queueLimit = options.queueLimit ?? 3;
  // A multi-group run is one analysis; none of its fits evict their siblings.
  const maxAnalyses = options.maxAnalyses ?? options.maxFits ?? 5;
  const maxGroups = options.maxGroups ?? 32;
  const fitTtl = options.fitTtlMs ?? 3600000;
  const maxBody = options.bodySizeLimit ?? 8 * 1024 * 1024;
  const figureCacheLimit = options.figureCacheBytes ?? MAX_FIGURE_CACHE_BYTES;
  const taskResponseLimit = options.taskBytes ?? MAX_BUNDLE_BYTES;
  const synchronousRequests = new Set();
  const cache = new Map(), analyses = new Map(), recent = new Map();
  const figureArchives = new Map();
  let figureArchiveBytes = 0;
  let jobs = 0, serial = Promise.resolve(), healthPromise = null, healthAt = 0;
  const runtimePromise = resolveRscript(options.rscriptPath);
  // The host may inherit Unix C.UTF-8, which Windows R rejects and falls back
  // to C. A supported UCRT locale keeps UTF-8 R source and Chinese labels intact.
  const env = { ...process.env, ...(process.platform === 'win32' ? { LC_ALL: 'English_United States.utf8' } : {}), ...(options.env ?? {}) };
  const lifecycle = createJobLifecycle({ jobRoot, ...options.jobLifecycle });
  const taskStore = createTaskResultStore({ lifecycle, maxBytes: taskResponseLimit });
  const taskManager = createAsyncTaskManager({ maxBytes: taskResponseLimit, ...options.asyncTasks, store: taskStore });
  const { newJob, removeJob } = lifecycle;
  function removeFigureArchive(key) {
    const entry = figureArchives.get(key);
    if (!entry) return;
    figureArchiveBytes -= entry.result.data.length;
    figureArchives.delete(key);
  }
  function retainedFigureArchive(key) {
    const entry = figureArchives.get(key);
    if (!entry) return null;
    figureArchives.delete(key);
    figureArchives.set(key, entry);
    return entry.result;
  }
  function retainFigureArchive(key, analysisId, result) {
    if (figureCacheLimit <= 0 || result.data.length > figureCacheLimit) return;
    removeFigureArchive(key);
    while (figureArchiveBytes + result.data.length > figureCacheLimit && figureArchives.size)
      removeFigureArchive(figureArchives.keys().next().value);
    figureArchives.set(key, { analysisId, result });
    figureArchiveBytes += result.data.length;
  }
  async function removeAnalysis(id, analysis) {
    if (!analysis) return;
      analyses.delete(id);
      for (const [key, archive] of figureArchives) if (archive.analysisId === id) removeFigureArchive(key);
      const fits = analysis.fitIds.map(fitId => cache.get(fitId)).filter(Boolean);
      // Remove every lookup before awaiting disk cleanup, so a download can
      // never observe a surviving sibling of an expired analysis.
      for (const fitId of analysis.fitIds) {
        cache.delete(fitId);
      }
      for (const fit of fits) await removeJob(fit.directory);
  }
  async function expireFits() {
    for (const [id, analysis] of analyses) if (analysis.expiresAt <= Date.now()) {
      await removeAnalysis(id, analysis);
    }
    while (analyses.size > maxAnalyses) {
      const [id, analysis] = analyses.entries().next().value;
      await removeAnalysis(id, analysis);
    }
  }
  async function execute(script, args, resultPath, operationTimeout = timeout, signal) {
    throwIfCancelled(signal);
    let processError = null, timedOut = false;
    let operation, childClosed, termination, timer;
    const stop = () => {
      if (termination || !operation?.child.pid || operation.child.exitCode !== null || operation.child.signalCode !== null) return;
      const child = operation.child;
      termination = (async () => {
        if (process.platform === 'win32') {
          // The Windows Rscript launcher creates another R process. Killing
          // only the launcher leaves the fit running and its files open.
          try {
            await execFileAsync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
              ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, shell: false });
          } catch { if (child.exitCode === null && child.signalCode === null) child.kill(); }
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
        }
      })();
    };
    try {
      const runtime = await runtimePromise;
      throwIfCancelled(signal);
      operation = execFileAsync(runtime, ['--vanilla', script, ...args],
        { env, windowsHide: true, maxBuffer: 1024 * 1024, shell: false, detached: process.platform !== 'win32' });
      childClosed = new Promise(resolve => operation.child.once('close', resolve));
      signal?.addEventListener('abort', stop, { once: true });
      timer = setTimeout(() => { timedOut = true; stop(); }, operationTimeout);
      timer.unref();
      await operation;
    }
    catch (error) { processError = error; }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      await termination;
    }
    if ((signal?.aborted || timedOut) && childClosed) await childClosed;
    throwIfCancelled(signal);
    if (timedOut) fail('FIT_TIMEOUT', 'The R operation exceeded the time limit.', 504);
    let result;
    try { result = JSON.parse(await readFile(resultPath, 'utf8')); } catch { /* classified below */ }
    if (result?.error) {
      const safeCodes = new Set(['R_PACKAGES_MISSING', 'INVALID_DATA', 'DUPLICATE_COLUMN', 'CONFLICTING_COUNT_COLUMNS', 'DUPLICATE_YEAR_AGE', 'INSUFFICIENT_DOMAIN',
        'INVALID_SETTINGS', 'INSUFFICIENT_DATA', 'FIT_NOT_CONVERGED', 'FIT_NUMERICAL_ERROR', 'FIT_FAILED',
        'CAIRO_UNAVAILABLE', 'TIFF_UNAVAILABLE', 'INVALID_EXPORT_SETTINGS', 'EXPORT_FAILED']);
      const code = safeCodes.has(result.error.code) ? result.error.code : 'FIT_FAILED';
      fail(code, code === 'R_PACKAGES_MISSING' ? 'A required R package is unavailable.' :
        code === 'CAIRO_UNAVAILABLE' ? 'The R Cairo graphics device is unavailable.' :
        code === 'TIFF_UNAVAILABLE' ? 'The R TIFF graphics device is unavailable. Use an R installation with libtiff support.' :
        code.startsWith('EXPORT') ? 'The publication figure could not be exported.' : 'The R model could not fit these data and settings.', 422);
    }
    if (processError?.code === 'ENOENT') fail('R_UNAVAILABLE', 'The R runtime is unavailable.', 503);
    if (processError?.killed) fail('FIT_TIMEOUT', 'The R operation exceeded the time limit.', 504);
    if (processError || !result) fail('FIT_FAILED', 'The R operation did not produce a valid result.', 422);
    return result;
  }
  async function fitGroup(request, analysisId, verifiedDerivation = null, signal) {
    throwIfCancelled(signal);
    const directory = await newJob(); let fittedSuccessfully = false;
    try {
      const input = path.join(directory, 'request.json'), output = path.join(directory, 'response.json');
      await writeFile(input, JSON.stringify({ ...request, gridOptions: options.gridOptions ?? {} }));
      const result = await execute(adapter, [input, output], output, timeout, signal);
      if (result.schemaVersion !== '1' || result.meta?.fitted !== true || !Array.isArray(result.points) ||
          !result.points.length || !(await stat(path.join(directory, 'fit.rds'))).isFile())
        fail('FIT_FAILED', 'The R model did not return a verified fit.', 422);
      const fitId = randomUUID();
      result.fitId = fitId; result.analysisId = analysisId;
      result.meta.fitId = fitId; result.meta.analysisId = analysisId;
      result.meta.publicationExportAvailable = true; result.meta.completeDownloadAvailable = true;
      result.meta.sex = request.rows[0].Sex ?? null;
      if (verifiedDerivation) result.meta.derivedBoth = verifiedDerivation;
      result.input = request.rows; result.provenance = request.provenance;
      throwIfCancelled(signal);
      fittedSuccessfully = true;
      return { result, directory, method: result.settings.method, grid: result.grid };
    } finally { if (!fittedSuccessfully) await removeJob(directory); }
  }
  async function retainAnalysis(analysisId, fits, signal) {
    throwIfCancelled(signal);
    if (!fits.length) return null;
    const expiresAt = Date.now() + fitTtl;
    const fitExpiresAt = new Date(expiresAt).toISOString();
    // Start every group's lifetime after the last fit finishes, then persist
    // the exact response used by the browser and the existing download API.
    for (const fit of fits) {
      throwIfCancelled(signal);
      fit.result.meta.fitExpiresAt = fitExpiresAt;
      await writeFile(path.join(fit.directory, 'response.json'), JSON.stringify(fit.result));
    }
    throwIfCancelled(signal);
    analyses.set(analysisId, { expiresAt, fitIds: fits.map(fit => fit.result.fitId) });
    for (const fit of fits) cache.set(fit.result.fitId, { directory: fit.directory, analysisId,
      method: fit.method, grid: fit.grid, sex: fit.result.meta.sex });
    await expireFits();
    if (signal?.aborted) {
      await removeAnalysis(analysisId, analyses.get(analysisId));
      throwIfCancelled(signal);
    }
    return fitExpiresAt;
  }
  function enqueue(operation, signal) {
    throwIfCancelled(signal);
    if (jobs >= queueLimit + 1) fail('SERVER_BUSY', 'The fitting queue is full. Try again shortly.', 429);
    jobs += 1;
    let released = false, started = false, rejectCancelled, operationToRun = operation;
    operation = null;
    const release = () => { if (!released) { released = true; jobs -= 1; } };
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    const cancel = () => {
      if (!started) { operationToRun = null; release(); }
      rejectCancelled(new ApiError('REQUEST_CANCELLED', 'This analysis was cancelled.', 499));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const scheduled = serial.then(async () => {
      throwIfCancelled(signal);
      started = true;
      const run = operationToRun;
      operationToRun = null;
      return run();
    });
    serial = scheduled.catch(() => {}).finally(() => {
      signal?.removeEventListener('abort', cancel);
      release();
    });
    return signal ? Promise.race([scheduled, cancelled]) : scheduled;
  }
  function retainedAnalysisFits(fitId) {
    const fit = cache.get(fitId), analysis = fit && analyses.get(fit.analysisId);
    if (!fit || !analysis) fail('FIT_EXPIRED', 'This fit is no longer available. Run the model again.', 410);
    return analysis.fitIds.map(id => ({ ...cache.get(id), fitId: id }));
  }
  function prepareFigureExport(request, body, bundle) {
    const fit = cache.get(request.fitId);
    if (!fit) fail('FIT_EXPIRED', 'This fit is no longer available. Run the model again.', 410);
    const fits = bundle ? retainedAnalysisFits(request.fitId) : [{ ...fit, fitId: request.fitId }];
    const selections = new Map();
    if (bundle && body.groupSelections !== undefined) {
      if (!Array.isArray(body.groupSelections)) fail('INVALID_EXPORT_SETTINGS', 'Group curve selections must be an array.');
      const allowed = new Set(fits.map(group => group.fitId));
      for (const selection of body.groupSelections) {
        if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
            !allowed.has(selection.fitId) || selections.has(selection.fitId))
          fail('INVALID_EXPORT_SETTINGS', 'Group curve selections must identify unique fits from this analysis.');
        selections.set(selection.fitId, { sectionYears: selection.sectionYears, trendAges: selection.trendAges });
      }
    }
    const { sectionYears: _sectionYears, trendAges: _trendAges, ...common } = request;
    const sharedSelections = {};
    for (const [key, axis] of [['sectionYears', 'years'], ['trendAges', 'ages']])
      if (request[key] && fits.every(group => request[key].every(value => group.grid[axis].includes(value)))) sharedSelections[key] = request[key];
    const requests = fits.map(group => {
      const groupRequest = bundle ? validateExportRequest({ ...common, fitId: group.fitId,
        ...(body.groupSelections !== undefined ? selections.get(group.fitId) : sharedSelections) }) : request;
      for (const [key, axis] of [['sectionYears', 'years'], ['trendAges', 'ages']])
        if (groupRequest[key]?.some(value => !group.grid[axis].includes(value)))
          fail('INVALID_EXPORT_SETTINGS', 'Select coordinates from the retained prediction grid.');
      return groupRequest;
    });
    return { fit, fits, requests };
  }
  function rateLimit(req) {
    const key = clientRateLimitAddress(req, options.trustProxy ?? process.env.BLSD_TRUST_PROXY);
    const now = Date.now();
    const timestamps = (recent.get(key) ?? []).filter(time => now - time < 60000);
    if (timestamps.length >= (options.requestsPerMinute ?? 12)) fail('RATE_LIMITED', 'Too many fitting or export requests. Try again shortly.', 429);
    timestamps.push(now); recent.set(key, timestamps);
    for (const [ip, times] of recent) if (times.at(-1) < now - 60000) recent.delete(ip);
  }
  async function health() {
    if (!healthPromise || Date.now() - healthAt > 30000) {
      healthAt = Date.now();
      healthPromise = (async () => {
        try {
          const { stdout } = await execFileAsync(await runtimePromise, ['--vanilla', '-e',
            'cat(if (requireNamespace("mgcv", quietly=TRUE) && requireNamespace("jsonlite", quietly=TRUE)) "READY" else "MISSING")'],
            { env, timeout: 15000, windowsHide: true, maxBuffer: 8192, shell: false });
          const available = stdout.includes('READY');
          return { available, code: available ? null : 'R_PACKAGES_MISSING', methods: [...METHODS], exportFormats: Object.keys(EXPORT_FORMATS) };
        } catch { return { available: false, code: 'R_UNAVAILABLE', methods: [...METHODS], exportFormats: Object.keys(EXPORT_FORMATS) }; }
      })();
    }
    return healthPromise;
  }
  function checkOrigin(req) {
    if (!req.headers.origin) return;
    let sameOrigin = false;
    try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* invalid origin */ }
    if (!sameOrigin) fail('ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.', 403);
  }
  async function sendTaskResponse(res, result) {
    if (res.destroyed || res.writableEnded) return;
    if (result.send) {
      try { await result.send(res); }
      catch (error) { if (res.headersSent || res.destroyed) { res.destroy(); return; } throw error; }
      return;
    }
    res.writeHead(result.status, result.headers); res.end(result.data);
  }
  const handleRequest = async (req, res, next, context = {}) => {
    let cancellation;
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); }
      catch { fail('INVALID_URL', 'The request URL is invalid.'); }
      const pathname = url.pathname;
      const downloadMatch = /^\/api\/results\/([^/]+)\/download$/.exec(pathname);
      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
      if (taskMatch) {
        checkOrigin(req);
        if (!FIT_ID.test(taskMatch[1])) fail('INVALID_TASK_ID', 'A valid task identifier is required.');
        if (!['GET', 'DELETE'].includes(req.method)) fail('METHOD_NOT_ALLOWED', 'Use GET or DELETE for a task.', 405);
        await sendTaskResponse(res, req.method === 'GET' ? taskManager.get(taskMatch[1]) : taskManager.cancel(taskMatch[1]));
        return;
      }
      if (!downloadMatch && !['/api/fit', '/api/fit-groups', '/api/export', '/api/export-bundle', '/api/health'].includes(pathname)) { await next?.(); return; }
      if (!context.signal && /(?:^|,)\s*respond-async\s*(?:,|$)/i.test(req.headers.prefer ?? '') && pathname !== '/api/health') {
        checkOrigin(req);
        if (req.method !== (downloadMatch ? 'GET' : 'POST')) fail('METHOD_NOT_ALLOWED', 'Use the supported request method.', 405);
        if (req.method === 'POST') rateLimit(req);
        const body = downloadMatch ? undefined : await readJson(req, maxBody);
        const taskId = taskManager.submit(async signal => {
          const capture = bufferedTaskResponse(signal, taskResponseLimit);
          try {
            await handleRequest(req, capture.res, undefined, { signal, body, skipRateLimit: true });
            return capture.response;
          } finally { capture.dispose(); }
        });
        sendJson(res, 202, { taskId }); return;
      }
      if (pathname !== '/api/health') {
        cancellation = context.signal ? { signal: context.signal, dispose() {} } : requestCancellation(req, res);
        if (cancellation.cancel) synchronousRequests.add(cancellation);
      }
      if (pathname === '/api/health') {
        if (req.method !== 'GET') fail('METHOD_NOT_ALLOWED', 'Use GET for the health check.', 405);
        sendJson(res, 200, await health()); return;
      }
      if (downloadMatch) {
        if (req.method !== 'GET') fail('METHOD_NOT_ALLOWED', 'Use GET for complete result downloads.', 405);
        const fitId = downloadMatch[1], format = url.searchParams.get('format') ?? 'zip';
        const scope = url.searchParams.get('scope') ?? 'fit', contents = url.searchParams.get('contents');
        const allGroups = scope === 'analysis';
        const layout = url.searchParams.get('layout'), readable = layout === 'readable-v1' || format === 'xlsx';
        const locale = url.searchParams.get('locale') ?? 'en';
        if (!FIT_ID.test(fitId) || !['csv', 'json', 'zip', 'xlsx'].includes(format) ||
            !['fit', 'analysis'].includes(scope) ||
            (allGroups && (format !== 'zip' || layout !== 'readable-v1' || !['excel', 'archive'].includes(contents))) ||
            (layout !== null && layout !== 'readable-v1') || (readable && !['en', 'zh'].includes(locale)))
          fail('INVALID_DOWNLOAD_SETTINGS', 'Use a retained fit, a supported download format, layout and language.');
        checkOrigin(req);
        const download = await enqueue(async () => {
          throwIfCancelled(cancellation.signal);
          await expireFits(); const fit = cache.get(fitId);
          if (!fit) fail('FIT_EXPIRED', 'This fit is no longer available. Run the model again.', 410);
          if (allGroups) {
            const entries = [];
            for (const sibling of retainedAnalysisFits(fitId)) entries.push({
              fitId: sibling.fitId, analysisId: sibling.analysisId, sex: sibling.sex, method: sibling.method,
              result: JSON.parse(await readFile(path.join(sibling.directory, 'response.json'), 'utf8')),
              ...(contents === 'archive' ? { rds: await readFile(path.join(sibling.directory, 'fit.rds')) } : {}),
            });
            let data;
            try { data = contents === 'excel' ? analysisWorkbookZip(entries, locale) : analysisResultZip(entries, locale); }
            catch (error) {
              if (error.code === 'EXPORT_TOO_LARGE') fail('EXPORT_FAILED', 'The analysis archive exceeds the supported size.', 422);
              throw error;
            }
            return { data, filename: `BLSD_${contents === 'excel' ? 'tables' : 'archive'}_all_sexes.zip` };
          }
          const result = JSON.parse(await readFile(path.join(fit.directory, 'response.json'), 'utf8'));
          let data;
          if (format === 'xlsx') data = resultWorkbook(result, locale);
          else if (format === 'json') data = Buffer.from(JSON.stringify(publicCountResult(result)));
          else if (format === 'csv') data = Buffer.from(readable ? readableResultCsv(result, locale) : completeResultCsv(result), 'utf8');
          else {
            const rds = await readFile(path.join(fit.directory, 'fit.rds'));
            data = readable ? readableResultZip(result, rds, locale) : completeResultZip(result, rds);
          }
          const filename = readable
            ? `BLSD_${format === 'xlsx' ? 'tables' : format === 'zip' ? 'archive' : 'results'}_${fit.method}${sexFilenameSuffix(fit.sex)}.${format}`
            : `BLSD_complete_${fit.method}_${fitId}${sexFilenameSuffix(fit.sex)}.${format}`;
          return { data, filename };
        }, cancellation.signal);
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(200, { 'Content-Type': { json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[format],
            'Content-Disposition': attachmentDisposition(download.filename), 'Content-Length': download.data.length,
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(download.data);
        }
        return;
      }
      if (req.method !== 'POST') fail('METHOD_NOT_ALLOWED', 'Use POST for this operation.', 405);
      checkOrigin(req);
      if (!context.skipRateLimit) rateLimit(req);
      const body = Object.hasOwn(context, 'body') ? context.body : await readJson(req, maxBody);
      if (pathname === '/api/fit') {
        const request = validateFitRequest(body);
        const result = await enqueue(async () => {
          throwIfCancelled(cancellation.signal);
          await expireFits();
          const analysisId = randomUUID();
          const fit = await fitGroup(request, analysisId, null, cancellation.signal); let retained = false;
          try {
            await retainAnalysis(analysisId, [fit], cancellation.signal); retained = true; return fit.result;
          } finally { if (!retained && lifecycle.hasJob(fit.directory)) await removeJob(fit.directory); }
        }, cancellation.signal);
        sendJson(res, 200, result);
      } else if (pathname === '/api/fit-groups') {
        const groups = validateGroupFitRequest(body, maxGroups);
        const result = await enqueue(async () => {
          throwIfCancelled(cancellation.signal);
          await expireFits();
          const analysisId = randomUUID(), fits = [], results = []; let retained = false;
          try {
            for (const group of groups) {
              throwIfCancelled(cancellation.signal);
              if (group.error) { results.push({ sex: group.sex, status: 'rejected', error: group.error }); continue; }
              try {
                const fit = await fitGroup(group.request, analysisId, group.request.provenance.derivedBoth ?? null, cancellation.signal);
                fits.push(fit);
                results.push({ sex: group.sex, status: 'fulfilled', fitId: fit.result.fitId, result: fit.result });
              } catch (error) {
                throwIfCancelled(cancellation.signal);
                results.push({ sex: group.sex, status: 'rejected', error: safeError(error) });
              }
            }
            const fitExpiresAt = await retainAnalysis(analysisId, fits, cancellation.signal); retained = true;
            return { schemaVersion: '1', analysisId, fitExpiresAt, results };
          } finally {
            if (!retained) for (const fit of fits) if (lifecycle.hasJob(fit.directory)) await removeJob(fit.directory);
          }
        }, cancellation.signal);
        sendJson(res, 200, result);
      } else {
        const bundle = pathname === '/api/export-bundle';
        const request = validateExportRequest(bundle ? { ...body, metric: 'surface' } : body);
        let cachedBundle;
        if (bundle) {
          const retainedFit = cache.get(request.fitId), analysis = retainedFit && analyses.get(retainedFit.analysisId);
          if (analysis?.expiresAt > Date.now()) {
            const { requests } = prepareFigureExport(request, body, true);
            const renderer = await stat(exporter);
            // Cached bytes require no R work. Recheck lifetime after the stat
            // await, then let this read pass an unrelated queued computation.
            if (cache.get(request.fitId) === retainedFit && analyses.get(retainedFit.analysisId) === analysis && analysis.expiresAt > Date.now())
              cachedBundle = retainedFigureArchive(JSON.stringify({ renderer: [renderer.mtimeMs, renderer.size], requests }));
          }
        }
        const result = cachedBundle ?? await enqueue(async () => {
          if (bundle && res.destroyed) return null;
          await expireFits();
          const { fit, fits, requests } = prepareFigureExport(request, body, bundle);
          let archiveKey;
          if (bundle) {
            const renderer = await stat(exporter);
            archiveKey = JSON.stringify({ renderer: [renderer.mtimeMs, renderer.size], requests });
            const retained = retainedFigureArchive(archiveKey);
            if (retained) return retained;
          }
          const directory = await newJob();
          const cancelFile = path.join(directory, 'cancelled');
          const cancel = () => { writeFile(cancelFile, '').catch(() => {}); };
          if (bundle) res.once('close', cancel);
          try {
            const figures = bundle ? FIGURE_BUNDLE : [[request.metric, 'figure']], files = {};
            if (bundle) {
              if (res.destroyed) return null;
              const input = path.join(directory, 'export-batch.json');
              const statusFile = path.join(directory, 'batch-status.json');
              const groups = fits.map((group, index) => {
                const { metric: _metric, ...settings } = requests[index];
                return { rdsPath: path.join(group.directory, 'fit.rds'), settings,
                  figures: figures.map(([metric, name]) => ({ metric, file: `${index + 1}-${name}.${request.format}` })) };
              });
              await writeFile(input, JSON.stringify({ groups, cancelFile }));
              // Reuse one R process for the archive and one snapshot load per
              // group. Keep the former per-figure time budget for a full batch.
              await execute(exporter, ['--batch', input, directory, statusFile], statusFile,
                timeout * fits.length * figures.length, cancellation.signal);
            }
            let totalBytes = 0;
            for (const [index, group] of fits.entries()) for (const [metric, name] of figures) {
              if (bundle && res.destroyed) return null;
              const stem = bundle ? `${index + 1}-${name}` : name;
              const output = path.join(directory, `${stem}.${request.format}`);
              if (!bundle) {
                const input = path.join(directory, 'export.json');
                const statusFile = path.join(directory, 'status.json');
                await writeFile(input, JSON.stringify({ ...requests[index], metric }));
                await execute(exporter, [path.join(group.directory, 'fit.rds'), input, output, statusFile], statusFile, timeout, cancellation.signal);
              }
              const info = await stat(output);
              if (!info.isFile() || info.size <= 0 || info.size > 32 * 1024 * 1024) fail('EXPORT_FAILED', 'The figure output is invalid.', 422);
              if (bundle && res.destroyed) return null;
              totalBytes += info.size;
              if (bundle && totalBytes > MAX_BUNDLE_BYTES) fail('EXPORT_FAILED', 'The figure archive exceeds the supported size.', 422);
              const data = await readFile(output);
              if (!bundle) return { data, filename: `BLSD_${request.metric}_${fit.method}_${request.locale}${sexFilenameSuffix(fit.sex)}.${request.format}` };
              files[`${analysisGroupPath(group, index)}/${name}.${request.format}`] = data;
            }
            const archive = { data: zipFiles(files), filename: `BLSD_figures_${fit.method}_all_sexes.${request.format}.zip` };
            if (!res.destroyed) retainFigureArchive(archiveKey, fit.analysisId, archive);
            return archive;
          } finally {
            if (bundle) res.off('close', cancel);
            await removeJob(directory);
          }
        }, cancellation.signal);
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(200, { 'Content-Type': bundle ? 'application/zip' : EXPORT_FORMATS[request.format],
            'Content-Disposition': attachmentDisposition(result.filename), 'Content-Length': result.data.length,
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(result.data);
        }
      }
    } catch (error) {
      if (error?.code === 'TASK_RESULT_TOO_LARGE' && error.status === 413)
        sendJson(res, 413, { error: { code: 'TASK_RESULT_TOO_LARGE', message: 'The task response exceeds the supported size.' } });
      else if (error?.code === 'TASK_STORAGE_FAILED' && error.status === 507)
        sendJson(res, 507, { error: { code: 'TASK_STORAGE_FAILED', message: 'The task result could not be stored or accessed.' } });
      else if (!(error instanceof ApiError) && error?.code === 'SERVER_BUSY' && error.status === 429)
        sendJson(res, 429, { error: { code: 'SERVER_BUSY', message: 'The task result store is full. Download or cancel existing tasks, then retry.' } });
      else sendJson(res, error instanceof ApiError ? error.status : 500, { error: safeError(error) });
    } finally { if (cancellation) synchronousRequests.delete(cancellation); cancellation?.dispose(); }
  };
  const middleware = (req, res, next) => handleRequest(req, res, next);
  const cleanupTimer = setInterval(() => { if (!jobs) expireFits().catch(() => {}); }, Math.min(fitTtl, 60000));
  cleanupTimer.unref();
  let closing;
  middleware.close = () => closing ??= (async () => {
    clearInterval(cleanupTimer);
    for (const request of synchronousRequests) request.cancel();
    const errors = [];
    try { await taskManager.close(); } catch (error) { errors.push(error); }
    try { await serial; } catch (error) { errors.push(error); }
    try { await lifecycle.close(); } catch (error) { errors.push(error); }
    cache.clear(); analyses.clear();
    figureArchives.clear(); figureArchiveBytes = 0;
    if (errors.length) throw new AggregateError(errors, 'Some service resources could not be safely removed.');
  })();
  middleware.health = health;
  return middleware;
}
