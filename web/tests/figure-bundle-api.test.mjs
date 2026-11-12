import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createBlsdServer } from '../server/index.mjs';
import { taskRequest } from '../src/taskRequest.js';

// Ownership records are files beside the actual fit/export directories.
const jobDirectories = async root => (await readdir(root, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && entry.name.startsWith('blsd-')).map(entry => entry.name).sort();

const missingFitId = '11111111-1111-4111-8111-111111111111';
const entries = [
  ['surface', '01_fitted_surface'], ['annual', '02_annual_rate_change'],
  ['acceleration', '03_log_rate_acceleration'], ['ageSections', '04_age_sections'],
  ['timeTrends', '05_age_specific_time_trends'], ['gradient', '06_age_gradient'],
  ['shift', '07_equivalent_age_shift'], ['residuals', '08_fitted_residuals'],
];
const settings = { method: 'quasi-gcv', draws: 100, seed: 123, kAge: 4, kYear: 4, threshold: 0.005 };
const signature = { png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pdf: Buffer.from('%PDF-controlled\n'), tiff: Buffer.from([73, 73, 42, 0]) };
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function observations() {
  return Array.from({ length: 5 }, (_, yi) => Array.from({ length: 5 }, (_, ai) => {
    const Year = 2000 + yi, Age_Mid = 32.5 + ai * 5, Pop = 200000 + ai * 7000;
    const Count = Math.round(Pop * Math.exp(-8 + 0.065 * ai * 5 - 0.02 * yi)
      * (1 + 0.09 * Math.sin(yi * 1.8 + ai * 1.2))) + 0.125;
    return { Year, Age_Mid, Count, Pop, Sex: 'Male' };
  })).flat();
}

function unzip(bytes) {
  const files = {}; let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString('utf8');
    const start = offset + 30 + length + extra;
    files[name] = inflateRawSync(bytes.subarray(start, start + size)); offset = start + size;
  }
  return files;
}

function filename(response) {
  const header = response.headers.get('content-disposition') ?? '';
  assert.doesNotMatch(header, /[\r\n]/);
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  assert.ok(encoded);
  return decodeURIComponent(encoded[1]);
}

async function withServer(options, operation) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blsd-figure-bundle-'));
  const jobRoot = path.join(root, 'jobs');
  const dynamic = typeof options === 'function' ? await options(root) : options;
  const server = createBlsdServer({ requestsPerMinute: 60, gridOptions: { maxAgePoints: 7, maxYearPoints: 5 }, ...dynamic, jobRoot });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await operation(`http://127.0.0.1:${server.address().port}`, { root, jobRoot }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blsd-figure-bundle-'));
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
}

const post = (base, endpoint, body, signal) => fetch(`${base}${endpoint}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
});
async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
}
async function logEntries(filename) {
  try { return (await readFile(filename, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function until(check, message) {
  const expires = Date.now() + 15000;
  while (Date.now() < expires) { if (await check()) return; await wait(50); }
  assert.fail(message);
}

test('figure bundle validates publication settings and retained coordinates', async () => {
  await withServer({}, async base => {
    const valid = { fitId: missingFitId, format: 'png' };
    for (const body of [{ ...valid, format: 'zip' }, { ...valid, format: 'tif' }, { ...valid, locale: 'fr' },
      { ...valid, widthMm: 90 }, { ...valid, dpi: 300 }, { ...valid, showContours: 'false' },
      { ...valid, showIntervals: 0 }, { ...valid, sectionYears: [] }, { ...valid, trendAges: ['32.5'] },
      { ...valid, fitId: '../../fit' }])
      await expectError(await post(base, '/api/export-bundle', body), 400, 'INVALID_EXPORT_SETTINGS');
    await expectError(await fetch(`${base}/api/export-bundle`), 405, 'METHOD_NOT_ALLOWED');
    // A metric is deliberately unnecessary: the bundle always covers all eight.
    await expectError(await post(base, '/api/export-bundle', valid), 410, 'FIT_EXPIRED');
    await expectError(await post(base, '/api/export-bundle', { ...valid, metric: 'ignored' }), 410, 'FIT_EXPIRED');
  });
});

test('figure bundles render eight retained metrics in one R process, clean failures and preserve single-image exports', { timeout: 180000 }, async t => {
  let capturePath, invocationPath, failPath, realPath, delayPath;
  await withServer(async root => {
    capturePath = path.join(root, 'calls.jsonl'); invocationPath = path.join(root, 'invocations.jsonl');
    failPath = path.join(root, 'fail-metric.txt');
    realPath = path.join(root, 'use-real-exporter'); delayPath = path.join(root, 'delay-exporter');
    const exporterPath = path.join(root, 'controlled-export.R');
    const adapterPath = path.join(root, 'routing-fit.R'), fixturePath = path.join(root, 'retained-real-fixture.rds');
    const r = value => JSON.stringify(value.replaceAll('\\', '/'));
    const realExporter = fileURLToPath(new URL('../server/blsd_export.R', import.meta.url));
    const realAdapter = fileURLToPath(new URL('../server/blsd_adapter.R', import.meta.url));
    // Fit one genuine fixture. Later, identical numerical inputs reuse it for
    // routing tests, updating only each controlled group's source/sex metadata.
    await writeFile(adapterPath, `args <- commandArgs(trailingOnly=TRUE)
if (!file.exists(${r(fixturePath)})) {
  source(${r(realAdapter)})
  blsd_main()
  stopifnot(file.copy(file.path(dirname(args[2]), "fit.rds"), ${r(fixturePath)}))
} else {
  request <- jsonlite::fromJSON(args[1])
  snapshot <- readRDS(${r(fixturePath)})
  sex <- if ("Sex" %in% names(request$rows)) request$rows$Sex[1] else NULL
  snapshot$result$meta$sex <- sex
  snapshot$result$input <- request$rows
  snapshot$result$provenance <- request$provenance
  snapshot$observedData$Sex <- request$rows$Sex
  saveRDS(snapshot, file.path(dirname(args[2]), "fit.rds"))
  jsonlite::write_json(snapshot$result, args[2], auto_unbox=TRUE, null="null", na="null", digits=15)
}
`);
    await writeFile(exporterPath, `args <- commandArgs(trailingOnly=TRUE)
batch <- identical(args[1], "--batch")
manifest <- if (batch) jsonlite::fromJSON(args[2], simplifyVector=FALSE) else NULL
invocation <- paste(Sys.getpid(), format(Sys.time(), "%Y-%m-%dT%H:%M:%OS6"), sep=":")
mode <- if (batch) "batch" else "single"
cat(jsonlite::toJSON(list(invocation=invocation, mode=mode, pid=Sys.getpid(), manifest=manifest), auto_unbox=TRUE, null="null", digits=NA), "\\n", file=${r(invocationPath)}, append=TRUE, sep="")
record_call <- function(request, rds, snapshot) {
  call <- list(settings=request, rds=normalizePath(rds, winslash="/"), sex=snapshot$result$meta$sex, invocation=invocation, mode=mode)
  cat(jsonlite::toJSON(call, auto_unbox=TRUE, null="null", digits=NA), "\\n", file=${r(capturePath)}, append=TRUE, sep="")
  call
}
render_fake <- function(request, rds, snapshot, output) {
  call <- record_call(request, rds, snapshot)
  if (file.exists(${r(delayPath)})) Sys.sleep(0.5)
  failure <- if (file.exists(${r(failPath)})) readLines(${r(failPath)}, warn=FALSE) else character()
  if (length(failure) && identical(request$metric, failure[1]) && (length(failure) < 2L || identical(call$sex, failure[2]))) {
    jsonlite::write_json(list(error=list(code="EXPORT_FAILED", message="Controlled bundle failure")), args[4], auto_unbox=TRUE)
    quit(status=2L)
  }
  signature <- switch(request$format, png=as.raw(c(137,80,78,71,13,10,26,10)), pdf=charToRaw("%PDF-controlled\\n"), tiff=as.raw(c(73,73,42,0)))
  writeBin(c(signature, charToRaw(jsonlite::toJSON(call, auto_unbox=TRUE, null="null", digits=NA))), output)
}
if (file.exists(${r(realPath)})) {
  # Record the manifest once, then run the actual CLI once. Calling its main
  # inside a per-figure helper would recursively render the complete batch.
  if (batch) {
    for (group in manifest$groups) {
      snapshot <- readRDS(group$rdsPath)
      for (figure in group$figures) {
        request <- group$settings
        request$metric <- figure$metric
        record_call(request, group$rdsPath, snapshot)
      }
    }
  } else record_call(jsonlite::fromJSON(args[2], simplifyVector=FALSE), args[1], readRDS(args[1]))
  source(${r(realExporter)})
  blsd_export_main()
} else if (batch) {
  for (group in manifest$groups) {
    snapshot <- readRDS(group$rdsPath)
    for (figure in group$figures) {
      if (!is.null(manifest$cancelFile) && file.exists(manifest$cancelFile)) {
        jsonlite::write_json(list(ok=FALSE, cancelled=TRUE, refitted=FALSE, resampled=FALSE), args[4], auto_unbox=TRUE)
        quit(status=0L)
      }
      request <- group$settings
      request$metric <- figure$metric
      render_fake(request, group$rdsPath, snapshot, file.path(args[3], figure$file))
    }
  }
  jsonlite::write_json(list(ok=TRUE, refitted=FALSE, resampled=FALSE), args[4], auto_unbox=TRUE)
} else {
  render_fake(jsonlite::fromJSON(args[2], simplifyVector=FALSE), args[1], readRDS(args[1]), args[3])
  jsonlite::write_json(list(ok=TRUE, refitted=FALSE, resampled=FALSE), args[4], auto_unbox=TRUE)
}
`);
    return { exporterPath, adapterPath };
  }, async (base, { jobRoot }) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    const fitted = await post(base, '/api/fit', { rows: observations(), settings,
      provenance: { source: 'FIGURE_BUNDLE_HTTP_SIMULATED_COUNTS', simulated: true } });
    const result = await fitted.json(); assert.equal(fitted.status, 200, JSON.stringify(result));
    const [retainedName] = await jobDirectories(jobRoot), retained = path.join(jobRoot, retainedName);
    const rdsPath = path.join(retained, 'fit.rds'), responsePath = path.join(retained, 'response.json');
    const before = { rds: sha256(await readFile(rdsPath)), response: sha256(await readFile(responsePath)) };
    const body = { fitId: result.fitId, locale: 'zh', format: 'png', sectionYears: [2000, 2002],
      trendAges: [32.5, 42.5], showContours: false, showIntervals: false };
    let firstPngZip, groupedPngZip, groupedCacheRequest;
    const resetCapture = async () => { await writeFile(capturePath, ''); await writeFile(invocationPath, ''); };
    const assertBatchInvocation = async (calls, groupCount = 1) => {
      const invocations = await logEntries(invocationPath);
      assert.equal(invocations.length, 1, 'A complete bundle starts exactly one R process.');
      assert.equal(invocations[0].mode, 'batch');
      assert.equal(invocations[0].manifest.groups.length, groupCount);
      assert.ok(calls.length > 0);
      assert.ok(calls.every(call => call.mode === 'batch' && call.invocation === invocations[0].invocation));
      for (const group of invocations[0].manifest.groups) {
        assert.ok(path.isAbsolute(group.rdsPath));
        assert.ok(!Object.hasOwn(group.settings, 'metric'), 'Batch settings separate shared options from individual metrics.');
        assert.deepEqual(group.figures.map(figure => figure.metric), entries.map(([metric]) => metric));
        assert.ok(group.figures.every(figure => !path.isAbsolute(figure.file) && !/[\\/]/.test(figure.file)));
      }
      assert.ok(path.isAbsolute(invocations[0].manifest.cancelFile));
    };

    await t.test('PNG, PDF and TIFF protocols carry eight named figures from one Sex and one RDS', async () => {
      for (const format of ['png', 'pdf', 'tiff']) {
        await resetCapture();
        const submitted = { ...body, format, ...(format === 'pdf' ? { locale: 'en', showContours: true, showIntervals: true } : {}), metric: 'ignored' };
        const response = await post(base, '/api/export-bundle', submitted);
        assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(filename(response), `BLSD_figures_quasi-gcv_all_sexes.${format}.zip`);
        const zipBytes = Buffer.from(await response.arrayBuffer());
        if (format === 'png') firstPngZip = zipBytes;
        const files = unzip(zipBytes);
        assert.deepEqual(Object.keys(files), entries.map(([, name]) => `01_Male/${name}.${format}`));
        const calls = await logEntries(capturePath);
        await assertBatchInvocation(calls);
        assert.deepEqual(calls.map(call => call.settings.metric), entries.map(([metric]) => metric));
        assert.equal(new Set(calls.map(call => call.rds)).size, 1);
        assert.equal(path.resolve(calls[0].rds), path.resolve(rdsPath));
        for (const [index, [metric, name]] of entries.entries()) {
          const bytes = files[`01_Male/${name}.${format}`];
          assert.deepEqual(bytes.subarray(0, signature[format].length), signature[format]);
          const payload = JSON.parse(bytes.subarray(signature[format].length).toString());
          assert.equal(payload.sex, 'Male'); assert.equal(payload.settings.metric, metric);
          for (const key of ['format', 'locale', 'sectionYears', 'trendAges', 'showContours', 'showIntervals'])
            assert.deepEqual(payload.settings[key], submitted[key], `${metric}: ${key}`);
          assert.equal(payload.settings.widthMm, 180); assert.equal(payload.settings.dpi, 600);
          assert.deepEqual(payload, calls[index]);
        }
        assert.deepEqual(await jobDirectories(jobRoot), [retainedName], 'Successful bundle jobs leave only the retained fit.');
      }
    });

    await t.test('invalid coordinates and a failed renderer never return a partial ZIP', async () => {
      await resetCapture();
      await expectError(await post(base, '/api/export-bundle', { ...body,
        groupSelections: [{ fitId: result.fitId, sectionYears: [2100] }] }), 400, 'INVALID_EXPORT_SETTINGS');
      assert.equal((await logEntries(capturePath)).length, 0);
      await writeFile(failPath, 'ageSections');
      // Use settings that have never completed successfully, so this exercises
      // the renderer failure instead of retrieving the earlier PNG cache entry.
      const failed = await post(base, '/api/export-bundle', { ...body, showContours: true });
      assert.match(failed.headers.get('content-type'), /^application\/json/);
      assert.equal(failed.headers.get('content-disposition'), null);
      await expectError(failed, 422, 'EXPORT_FAILED');
      assert.deepEqual((await logEntries(capturePath)).map(call => call.settings.metric), entries.slice(0, 4).map(([metric]) => metric));
      await assertBatchInvocation(await logEntries(capturePath));
      assert.deepEqual(await jobDirectories(jobRoot), [retainedName], 'A failed bundle removes every temporary figure.');
      await rm(failPath);
    });

    await t.test('a disconnected client stops before rendering the remaining figures', async () => {
      await resetCapture(); await writeFile(delayPath, 'delay');
      const controller = new AbortController();
      const pending = post(base, '/api/export-bundle', { ...body, locale: 'en' }, controller.signal).catch(error => error);
      await until(async () => (await logEntries(capturePath)).length > 0, 'The controlled exporter did not start.');
      controller.abort();
      const cancelled = await pending; assert.equal(cancelled.name, 'AbortError');
      await until(async () => (await jobDirectories(jobRoot)).length === 1, 'The cancelled bundle left a temporary job.');
      assert.equal((await logEntries(capturePath)).length, 1, 'The batch sees the cancel marker before rendering the remaining seven figures.');
      await assertBatchInvocation(await logEntries(capturePath));
      await rm(delayPath);
    });

    await t.test('the old single-image endpoint keeps its image MIME and attachment name', async () => {
      await resetCapture();
      const response = await post(base, '/api/export', { ...body, metric: 'gradient', format: 'png' });
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(filename(response), 'BLSD_gradient_quasi-gcv_zh_Male.png');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(bytes.subarray(0, 8), signature.png);
      assert.equal((await logEntries(capturePath)).length, 1);
      const invocations = await logEntries(invocationPath);
      assert.equal(invocations.length, 1); assert.equal(invocations[0].mode, 'single');
    });

    await t.test('all-sex bundles isolate the analysis and preserve each group selection and safe directory', async () => {
      const sexes = ['Female', 'Male/../../恶意'];
      const batchResponse = await post(base, '/api/fit-groups', { rows: sexes.flatMap(Sex => observations().map(row => ({ ...row, Sex }))),
        selectedSexes: sexes, settings, provenance: { source: 'CONTROLLED_IDENTICAL_NUMERICAL_ROUTING_FIXTURE', simulated: true } });
      const batch = await batchResponse.json(); assert.equal(batchResponse.status, 200, JSON.stringify(batch));
      assert.ok(batch.results.every(group => group.status === 'fulfilled'), JSON.stringify(batch));
      const selections = batch.results.map((group, index) => ({ fitId: group.fitId,
        sectionYears: [index ? 2002 : 2000], trendAges: [index ? 42.5 : 32.5] }));
      const stored = new Map();
      for (const name of await jobDirectories(jobRoot)) {
        const directory = path.join(jobRoot, name);
        stored.set(directory, { rds: sha256(await readFile(path.join(directory, 'fit.rds'))),
          response: sha256(await readFile(path.join(directory, 'response.json'))) });
      }
      const groupedBody = { ...body, fitId: batch.results[1].fitId, groupSelections: selections };
      await resetCapture();
      for (const groupSelections of [null, [{ fitId: missingFitId }], [{ fitId: result.fitId }],
        [selections[0], selections[0]], [{ fitId: batch.results[0].fitId, trendAges: [999] }]])
        await expectError(await post(base, '/api/export-bundle', { ...groupedBody, groupSelections }), 400, 'INVALID_EXPORT_SETTINGS');
      assert.equal((await logEntries(capturePath)).length, 0, 'Invalid group settings start no renderer.');

      const response = await post(base, '/api/export-bundle', groupedBody);
      assert.equal(response.status, 200);
      groupedPngZip = Buffer.from(await response.arrayBuffer());
      groupedCacheRequest = { ...groupedBody, fitId: batch.results[0].fitId };
      const files = unzip(groupedPngZip);
      assert.equal(Object.keys(files).length, 16, 'Both successful fits contribute eight figures.');
      const directories = [...new Set(Object.keys(files).map(name => name.split('/')[0]))];
      assert.equal(directories.length, 2); assert.equal(directories[0], '01_Female'); assert.match(directories[1], /^02_/);
      for (const name of Object.keys(files)) {
        assert.equal(path.posix.normalize(name), name); assert.equal(name.split('/').length, 2);
        assert.doesNotMatch(name, /[\\<>:"|?*\u0000-\u001f]/); assert.ok(!name.startsWith('/'));
      }
      const calls = await logEntries(capturePath);
      await assertBatchInvocation(calls, 2);
      assert.equal(calls.length, 16); assert.equal(new Set(calls.map(call => call.rds)).size, 2);
      assert.ok(calls.every(call => path.resolve(call.rds) !== path.resolve(rdsPath)), 'A different analysis is excluded.');
      for (const [index, group] of batch.results.entries()) {
        assert.deepEqual(Object.keys(files).filter(name => name.startsWith(`${directories[index]}/`)),
          entries.map(([, name]) => `${directories[index]}/${name}.png`));
        for (const call of calls.slice(index * 8, index * 8 + 8)) {
          assert.equal(call.sex, group.sex); assert.equal(call.settings.fitId, group.fitId);
          assert.deepEqual(call.settings.sectionYears, selections[index].sectionYears);
          assert.deepEqual(call.settings.trendAges, selections[index].trendAges);
        }
      }

      // Without explicit per-group settings, incompatible shared coordinates
      // are omitted so each retained group's genuine R defaults apply.
      await resetCapture();
      const fallback = await post(base, '/api/export-bundle', { ...body, fitId: batch.results[0].fitId,
        sectionYears: [2100], trendAges: [999] });
      assert.equal(fallback.status, 200); await fallback.arrayBuffer();
      await assertBatchInvocation(await logEntries(capturePath), 2);
      for (const call of await logEntries(capturePath)) {
        assert.ok(!Object.hasOwn(call.settings, 'sectionYears')); assert.ok(!Object.hasOwn(call.settings, 'trendAges'));
      }
      await resetCapture(); await writeFile(failPath, `gradient\n${sexes[1]}`);
      const failed = await post(base, '/api/export-bundle', { ...groupedBody, showIntervals: true });
      assert.equal(failed.headers.get('content-disposition'), null);
      await expectError(failed, 422, 'EXPORT_FAILED');
      assert.equal((await logEntries(capturePath)).length, 14,
        'A failure in the second group discards all previously rendered groups instead of sending a partial archive.');
      await assertBatchInvocation(await logEntries(capturePath), 2);
      await rm(failPath);
      for (const [directory, hashes] of stored) {
        assert.equal(sha256(await readFile(path.join(directory, 'fit.rds'))), hashes.rds);
        assert.equal(sha256(await readFile(path.join(directory, 'response.json'))), hashes.response);
      }
      assert.equal((await jobDirectories(jobRoot)).length, stored.size, 'All batch export directories are cleaned.');
    });

    await t.test('successful figure ZIPs are reused byte-for-byte without invoking R again', async () => {
      for (const [request, expected] of [[body, firstPngZip], [groupedCacheRequest, groupedPngZip]]) {
        assert.ok(expected?.length, 'The cache comparison uses a previously rendered complete PNG ZIP.');
        await resetCapture();
        const response = await post(base, '/api/export-bundle', request);
        assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
        assert.deepEqual(await logEntries(invocationPath), [], 'A cache hit starts no R process.');
        assert.deepEqual(await logEntries(capturePath), [], 'A cache hit renders no additional figures.');
      }
      // The second request anchors the same multi-sex analysis at its other fit.
      // Above protocol/failure/cancellation cases also verify that changing a
      // format, locale, curve selection or display switch still invokes R.
    });

    await t.test('one real PDF batch produces eight distinct valid publication figures without fitting again', async () => {
      await resetCapture(); await writeFile(realPath, 'real');
      const retainedBefore = await jobDirectories(jobRoot);
      // The earlier PDF protocol used both switches=true; these false switches
      // select an uncached request and therefore exercise the real R exporter.
      const response = await post(base, '/api/export-bundle', { ...body, format: 'pdf', locale: 'en' });
      assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
      const zipBytes = Buffer.from(await response.arrayBuffer());
      const files = unzip(zipBytes);
      assert.deepEqual(Object.keys(files), entries.map(([, name]) => `01_Male/${name}.pdf`));
      for (const [name, bytes] of Object.entries(files)) {
        assert.match(bytes.subarray(0, 8).toString('ascii'), /^%PDF-\d\.\d/);
        assert.match(bytes.subarray(-30).toString('ascii'), /%%EOF\s*$/);
        assert.ok(bytes.length > 5000, `${name} must contain the full rendered figure.`);
      }
      assert.equal(new Set(Object.values(files).map(sha256)).size, 8, 'Each metric is rendered independently.');
      assert.deepEqual((await logEntries(capturePath)).map(call => call.settings.metric), entries.map(([metric]) => metric));
      await assertBatchInvocation(await logEntries(capturePath));
      const asyncBytes = await taskRequest('/api/export-bundle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, format: 'pdf', locale: 'en' }),
      }, {
        async consume(download) {
          assert.equal(download.status, 200);
          for (const name of ['content-type', 'content-disposition', 'content-length'])
            assert.equal(download.headers.get(name), response.headers.get(name));
          return Buffer.from(await download.arrayBuffer());
        },
        fetchImpl: (url, options) => fetch(new URL(url, base), options), pollIntervalMs: 20, page: null,
      });
      assert.deepEqual(asyncBytes, zipBytes, 'Spooling and streaming preserve every byte of the eight real publication PDFs.');
      await assertBatchInvocation(await logEntries(capturePath));
      await until(async () => JSON.stringify(await jobDirectories(jobRoot)) === JSON.stringify(retainedBefore),
        'Full-body acknowledgement must remove only its temporary task payload.');
      assert.deepEqual(await jobDirectories(jobRoot), retainedBefore);
    });

    await t.test('cached bundles pass a busy renderer without changing validation or any ZIP bytes', async () => {
      await rm(realPath); await resetCapture(); await writeFile(delayPath, 'delay');
      const retainedBefore = await jobDirectories(jobRoot), controller = new AbortController();
      const pending = post(base, '/api/export-bundle', { ...body, format: 'tiff', locale: 'en' }, controller.signal).catch(error => error);
      try {
        await until(async () => (await logEntries(capturePath)).length > 0, 'The blocking uncached renderer did not start.');
        const cached = taskRequest('/api/export-bundle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }, {
          async consume(response) { assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer()); },
          fetchImpl: (url, options) => fetch(new URL(url, base), options), pollIntervalMs: 20, page: null,
        });
        let timer;
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('A cached download was blocked by unrelated R work.')), 1500); });
        try { assert.deepEqual(await Promise.race([cached, deadline]), firstPngZip); }
        finally { clearTimeout(timer); }
        assert.equal((await logEntries(invocationPath)).length, 1, 'The cached request must start no R process.');
        await expectError(await post(base, '/api/export-bundle', { ...body, groupSelections: [{ fitId: result.fitId, trendAges: [999] }] }),
          400, 'INVALID_EXPORT_SETTINGS');
      } finally {
        controller.abort(); await pending;
        await until(async () => JSON.stringify(await jobDirectories(jobRoot)) === JSON.stringify(retainedBefore),
          'Cancellation and acknowledgement must clean only their temporary jobs.');
        await rm(delayPath);
      }
    });

    assert.equal(sha256(await readFile(rdsPath)), before.rds, 'Bundles retain the exact model and coefficient draws.');
    assert.equal(sha256(await readFile(responsePath)), before.response, 'Bundles never change stored estimates or metadata.');
  });
});
