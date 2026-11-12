import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createBlsdServer } from '../server/index.mjs';

// Owner metadata files are not retained model/export directories.
const jobDirectories = async root => (await readdir(root, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && entry.name.startsWith('blsd-')).map(entry => entry.name).sort();
import { completeResultCsv, completeResultZip, publicCountResult } from '../server/results-download.mjs';

const missingFitId = '11111111-1111-4111-8111-111111111111';
const settings = { method: 'quasi-gcv', draws: 100, seed: 123, kAge: 4, kYear: 4, threshold: 0.005 };
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function observations(sex = 'Male') {
  return Array.from({ length: 5 }, (_, yi) => Array.from({ length: 5 }, (_, ai) => {
    const Year = 2000 + yi, Age_Mid = 32.5 + ai * 5, Pop = 200000.125 + ai * 7000;
    const Count = Math.round(Pop * Math.exp(-8 + 0.065 * ai * 5 - 0.02 * yi)
      * (1 + 0.09 * Math.sin(yi * 1.8 + ai * 1.2))) + 0.125;
    return { Year, Age_Group: `${30 + ai * 5}-${34 + ai * 5}`, Age_Mid, Count, Pop, Sex: sex };
  })).flat();
}

// Read the central directory so both stored and deflated XLSX entries work,
// without assuming the production writer's local-header implementation.
function unzip(bytes) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, 'A download must contain a ZIP end record.');
  const files = {}, count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30);
    const comment = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const packed = bytes.subarray(start, start + size);
    assert.ok(method === 0 || method === 8, 'Generated archives use stored or deflated ZIP entries.');
    files[name] = method === 8 ? inflateRawSync(packed) : packed;
    assert.equal(files[name].length, bytes.readUInt32LE(cursor + 24));
    cursor += 46 + nameLength + extra + comment;
  }
  return files;
}

function filename(response) {
  const header = response.headers.get('content-disposition') ?? '';
  assert.doesNotMatch(header, /[\r\n]/);
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  assert.ok(encoded, 'Downloads include an encoded UTF-8 attachment name.');
  const name = decodeURIComponent(encoded[1]);
  assert.doesNotMatch(name, /[/\\\r\n]/);
  return name;
}

async function withServer(options, operation) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blsd-readable-http-'));
  const jobRoot = path.join(root, 'jobs');
  const server = createBlsdServer({ requestsPerMinute: 50, gridOptions: { maxAgePoints: 7, maxYearPoints: 5 }, ...options, jobRoot });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { return await operation(`http://127.0.0.1:${server.address().port}`, { root, jobRoot }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blsd-readable-http-'));
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
}

const post = (base, endpoint, body) => fetch(`${base}${endpoint}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const download = (base, fitId, query) => fetch(`${base}/api/results/${fitId}/download?${query}`);
async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
}

test('download HTTP validates new layout and language before accessing a retained fit', async () => {
  await withServer({}, async base => {
    for (const query of ['format=pdf', 'format=XLSX', 'format=zip&layout=other', 'format=zip&layout=',
      'format=xlsx&locale=fr', 'format=csv&layout=readable-v1&locale=ZH',
      'format=zip&layout=readable-v1&locale=', 'format=json&layout=readable-v1&locale=fr',
      'format=zip&scope=other', 'format=xlsx&scope=analysis&contents=excel&layout=readable-v1',
      'format=zip&scope=analysis&layout=readable-v1', 'format=zip&scope=analysis&contents=unknown&layout=readable-v1',
      'format=zip&scope=analysis&contents=archive']) {
      await expectError(await download(base, missingFitId, query), 400, 'INVALID_DOWNLOAD_SETTINGS');
    }
    await expectError(await download(base, 'not-a-fit', 'format=xlsx'), 400, 'INVALID_DOWNLOAD_SETTINGS');
    for (const query of ['format=xlsx', 'format=xlsx&locale=zh', 'format=zip&layout=readable-v1&locale=en',
      'format=csv&layout=readable-v1&locale=zh', 'format=json', 'format=csv&locale=fr', 'format=zip&locale=fr',
      'format=zip&scope=analysis&contents=excel&layout=readable-v1&locale=zh',
      'format=zip&scope=analysis&contents=archive&layout=readable-v1&locale=en']) {
      await expectError(await download(base, missingFitId, query), 410, 'FIT_EXPIRED');
    }
    const method = await post(base, `/api/results/${missingFitId}/download?format=xlsx`, {});
    await expectError(method, 405, 'METHOD_NOT_ALLOWED');
  });
});

test('readable HTTP downloads use the exact retained real R fit, preserve old clients and isolate groups', { timeout: 120000 }, async t => {
  await withServer({}, async (base, { root, jobRoot }) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    if (!health.available) { t.skip(`Real R prerequisites unavailable: ${health.code}`); return; }
    const response = await post(base, '/api/fit', { rows: observations(), settings,
      provenance: { source: 'HTTP_READABLE_DOWNLOAD_SIMULATED_COUNTS', simulated: true } });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.ok(result.points.some(point => Array.isArray(point.metricMaskReasons) && !point.metricMaskReasons.length),
      'The real R fixture includes empty-list mask reasons, which must never resolve Array.prototype.shift.');
    const directories = await jobDirectories(jobRoot);
    assert.equal(directories.length, 1);
    const retained = path.join(jobRoot, directories[0]);
    const snapshot = await readFile(path.join(retained, 'response.json'));
    const rds = await readFile(path.join(retained, 'fit.rds'));
    assert.ok(rds.length > 1000, 'The fixture must be a genuine retained R model with coefficient draws.');

    await t.test('legacy CSV, JSON and ZIP remain byte-compatible', async () => {
      const csv = await download(base, result.fitId, 'format=csv');
      assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /^text\/csv/);
      assert.deepEqual(Buffer.from(await csv.arrayBuffer()), Buffer.from(completeResultCsv(result)));
      assert.equal(filename(csv), `BLSD_complete_quasi-gcv_${result.fitId}_Male.csv`);
      const json = await download(base, result.fitId, 'format=json');
      assert.equal(await json.text(), JSON.stringify(publicCountResult(result)));
      const zip = await download(base, result.fitId, 'format=zip');
      assert.deepEqual(Buffer.from(await zip.arrayBuffer()), completeResultZip(result, rds));
    });

    const translatedCsv = {};
    await t.test('readable archives have organized tables and exact full results and RDS', async () => {
      const expected = ['01_tables/input.csv', '01_tables/predictions.csv', '01_tables/derivatives.csv',
        '01_tables/observations.csv', '01_tables/cohort_smooth.csv', '01_tables/contours.csv',
        '01_tables/analysis_summary.csv', '01_tables/field_dictionary.csv', '02_analysis/metadata.json',
        '03_reproducibility/results.json', '03_reproducibility/fit.rds'];
      for (const locale of ['zh', 'en']) {
        const archive = await download(base, result.fitId, `format=zip&layout=readable-v1&locale=${locale}`);
        assert.equal(archive.status, 200); assert.equal(archive.headers.get('content-type'), 'application/zip');
        assert.equal(filename(archive), 'BLSD_archive_quasi-gcv_Male.zip');
        assert.equal(archive.headers.get('cache-control'), 'no-store');
        assert.equal(archive.headers.get('x-content-type-options'), 'nosniff');
        const files = unzip(Buffer.from(await archive.arrayBuffer()));
        assert.deepEqual(Object.keys(files).sort(), [...expected, 'README_zh.txt', 'README_en.txt'].sort());
        assert.deepEqual(files['03_reproducibility/fit.rds'], rds);
        assert.equal(files['03_reproducibility/results.json'].toString(), JSON.stringify(publicCountResult(result)));
        const meta = JSON.parse(files['02_analysis/metadata.json']);
        assert.equal(meta.exportLayout, 'readable-v1'); assert.equal(meta.locale, locale);
        assert.ok(files[`README_${locale}.txt`].length > 200);
        const csv = await download(base, result.fitId, `format=csv&layout=readable-v1&locale=${locale}`);
        assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /^text\/csv/);
        translatedCsv[locale] = await csv.text();
        // Response.text strips a UTF-8 BOM, so compare decoded bodies consistently.
        assert.equal(translatedCsv[locale], files['01_tables/predictions.csv'].toString().replace(/^\uFEFF/, ''));
        assert.doesNotMatch(translatedCsv[locale].split(/\r?\n/)[0], /^(?:Table|Record),/);
        assert.ok(files['01_tables/input.csv'].toString().includes(String(result.input[0].Deaths)),
          'Fractional source event counts retain their precision.');
      }
      assert.notEqual(translatedCsv.zh.split(/\r?\n/)[0], translatedCsv.en.split(/\r?\n/)[0]);
      assert.equal(translatedCsv.en.split(/\r?\n/).length, result.points.length * 6 + 1,
        'The homogeneous prediction CSV retains all six quantities at every fitted grid coordinate.');
      assert.deepEqual(translatedCsv.zh.split(/\r?\n/).slice(1), translatedCsv.en.split(/\r?\n/).slice(1),
        'Language changes headings, while grid coordinates and stored values remain identical.');
    });

    await t.test('XLSX is a localized Excel workbook by default and with explicit readable layout', async () => {
      const workbooks = {};
      for (const locale of ['zh', 'en']) {
        const workbook = await download(base, result.fitId, `format=xlsx&locale=${locale}`);
        assert.equal(workbook.status, 200); assert.equal(workbook.headers.get('content-type'), xlsxMime);
        assert.equal(filename(workbook), 'BLSD_tables_quasi-gcv_Male.xlsx');
        const bytes = Buffer.from(await workbook.arrayBuffer());
        assert.equal(bytes.readUInt32LE(0), 0x04034b50);
        const files = unzip(bytes);
        for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml'])
          assert.ok(files[required]?.length, required);
        const sheets = Object.keys(files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
        assert.equal(sheets.length, 9, 'The everyday workbook keeps only the nine requested core worksheets.');
        const content = Buffer.concat(Object.entries(files).filter(([name]) => name.endsWith('.xml')).map(([, data]) => data)).toString();
        assert.ok(content.includes('Male'), 'The workbook carries the active group identity.');
        assert.ok(content.includes(String(result.input[0].Deaths)), 'Numeric Count precision survives XLSX encoding.');
        workbooks[locale] = files['xl/workbook.xml'].toString();
        const explicit = await download(base, result.fitId, `format=xlsx&layout=readable-v1&locale=${locale}`);
        assert.equal(explicit.status, 200);
        assert.deepEqual(unzip(Buffer.from(await explicit.arrayBuffer()))['xl/workbook.xml'], files['xl/workbook.xml']);
      }
      assert.notEqual(workbooks.zh, workbooks.en, 'Worksheet names follow the selected language.');
    });

    assert.deepEqual(await readFile(path.join(retained, 'response.json')), snapshot,
      'Every download must leave the retained response byte-for-byte unchanged.');
    assert.deepEqual(await readFile(path.join(retained, 'fit.rds')), rds,
      'Every download must leave the fitted model and saved draws byte-for-byte unchanged.');

    // This controlled adapter reuses the one real fixture for lookup/expiry tests.
    // Identical observations/settings are used for each sex; no additional mgcv
    // fitting is needed to check that a fitId downloads only its own input/meta.
    const fixtureJson = path.join(root, 'routing-fixture.json'), fixtureRds = path.join(root, 'routing-fixture.rds');
    const adapterPath = path.join(root, 'routing-fixture.R');
    await writeFile(fixtureJson, snapshot); await writeFile(fixtureRds, rds);
    const rPath = value => JSON.stringify(value.replaceAll('\\', '/'));
    await writeFile(adapterPath, `args <- commandArgs(trailingOnly=TRUE)\nresult <- jsonlite::fromJSON(${rPath(fixtureJson)}, simplifyVector=FALSE)\njsonlite::write_json(result, args[2], auto_unbox=TRUE, null="null", digits=NA)\nstopifnot(file.copy(${rPath(fixtureRds)}, file.path(dirname(args[2]), "fit.rds")))\n`);

    await t.test('single-fit compatibility and all-sex analysis ZIPs preserve independent groups', async () => {
      await withServer({ adapterPath }, async (groupedBase, { jobRoot: groupedJobs }) => {
        const outsideResponse = await post(groupedBase, '/api/fit', { rows: observations('Outside'), settings });
        const outside = await outsideResponse.json(); assert.equal(outsideResponse.status, 200);
        const batchResponse = await post(groupedBase, '/api/fit-groups', { rows: [...observations('Male'), ...observations('Female')],
          selectedSexes: ['Male', 'Female'], settings, provenance: { source: 'CONTROLLED_HTTP_ROUTING_FIXTURE', simulated: true } });
        const batch = await batchResponse.json();
        assert.equal(batchResponse.status, 200, JSON.stringify(batch));
        assert.equal(batch.results.length, 2);
        const stored = new Map();
        for (const name of await jobDirectories(groupedJobs)) {
          const directory = path.join(groupedJobs, name);
          stored.set(directory, { result: await readFile(path.join(directory, 'response.json')), rds: await readFile(path.join(directory, 'fit.rds')) });
        }
        for (const group of batch.results) {
          assert.equal(group.status, 'fulfilled', JSON.stringify(group));
          const other = group.sex === 'Male' ? 'Female' : 'Male';
          const archive = await download(groupedBase, group.fitId, 'format=zip&layout=readable-v1&locale=en');
          assert.equal(archive.status, 200); assert.equal(filename(archive), `BLSD_archive_quasi-gcv_${group.sex}.zip`);
          const files = unzip(Buffer.from(await archive.arrayBuffer()));
          const full = JSON.parse(files['03_reproducibility/results.json']);
          assert.equal(full.fitId, group.fitId); assert.equal(full.meta.sex, group.sex);
          assert.ok(full.input.every(row => row.Sex === group.sex));
          assert.deepEqual(full, publicCountResult(group.result));
          assert.doesNotMatch(files['01_tables/input.csv'].toString(), new RegExp(`\\b${other}\\b`));
          const workbook = await download(groupedBase, group.fitId, 'format=xlsx&locale=en');
          assert.equal(workbook.status, 200); assert.equal(filename(workbook), `BLSD_tables_quasi-gcv_${group.sex}.xlsx`);
          const xml = Buffer.concat(Object.entries(unzip(Buffer.from(await workbook.arrayBuffer())))
            .filter(([name]) => name.startsWith('xl/') && name.endsWith('.xml')).map(([, value]) => value)).toString();
          assert.ok(xml.includes(group.sex)); assert.doesNotMatch(xml, new RegExp(`\\b${other}\\b`));
        }

        for (const locale of ['zh', 'en']) {
          const query = `format=zip&scope=analysis&layout=readable-v1&locale=${locale}&contents=`;
          const excel = await download(groupedBase, batch.results[1].fitId, `${query}excel`);
          assert.equal(excel.status, 200); assert.equal(excel.headers.get('content-type'), 'application/zip');
          assert.equal(filename(excel), 'BLSD_tables_all_sexes.zip');
          const books = unzip(Buffer.from(await excel.arrayBuffer()));
          assert.deepEqual(Object.keys(books), ['01_Male.xlsx', '02_Female.xlsx']);
          for (const [index, group] of batch.results.entries()) {
            const files = unzip(books[`${String(index + 1).padStart(2, '0')}_${group.sex}.xlsx`]);
            const xml = Buffer.concat(Object.entries(files).filter(([name]) => name.startsWith('xl/') && name.endsWith('.xml')).map(([, value]) => value)).toString();
            assert.ok(xml.includes(group.sex)); assert.doesNotMatch(xml, /Outside/);
            assert.ok(!xml.includes(outside.fitId), 'An analysis export must exclude a different retained analysis.');
          }
          const archive = await download(groupedBase, batch.results[0].fitId, `${query}archive`);
          assert.equal(archive.status, 200); assert.equal(filename(archive), 'BLSD_archive_all_sexes.zip');
          const files = unzip(Buffer.from(await archive.arrayBuffer()));
          const groupDirectories = [...new Set(Object.keys(files).filter(name => name.includes('/')).map(name => name.split('/')[0]))];
          assert.deepEqual(groupDirectories, ['01_Male', '02_Female']);
          for (const [index, group] of batch.results.entries()) {
            const prefix = `${String(index + 1).padStart(2, '0')}_${group.sex}/`;
            assert.deepEqual(JSON.parse(files[`${prefix}03_reproducibility/results.json`]), publicCountResult(group.result));
            assert.deepEqual(files[`${prefix}03_reproducibility/fit.rds`], rds);
            assert.ok(files[`${prefix}01_tables/input.csv`].toString().includes(group.sex));
          }
          const json = Object.entries(files).filter(([name]) => name.endsWith('.json')).map(([, value]) => value.toString()).join('\n');
          assert.ok(!json.includes(outside.fitId)); assert.doesNotMatch(json, /Outside/);
        }
        for (const [directory, bytes] of stored) {
          assert.deepEqual(await readFile(path.join(directory, 'response.json')), bytes.result);
          assert.deepEqual(await readFile(path.join(directory, 'fit.rds')), bytes.rds);
        }

        const unlabelledResponse = await post(groupedBase, '/api/fit', {
          rows: observations().map(({ Sex: _sex, ...row }) => row), settings });
        const unlabelled = await unlabelledResponse.json(); assert.equal(unlabelledResponse.status, 200);
        for (const contents of ['excel', 'archive']) {
          const response = await download(groupedBase, unlabelled.fitId,
            `format=zip&scope=analysis&layout=readable-v1&contents=${contents}&locale=en`);
          assert.equal(response.status, 200);
          const files = unzip(Buffer.from(await response.arrayBuffer()));
          if (contents === 'excel') assert.deepEqual(Object.keys(files), ['01_Unlabelled.xlsx']);
          else {
            const full = JSON.parse(files['01_Unlabelled/03_reproducibility/results.json']);
            assert.equal(full.meta.sex, null); assert.ok(full.input.every(row => !Object.hasOwn(row, 'Sex')));
            assert.deepEqual(full, publicCountResult(unlabelled));
          }
        }
      });
    });

    await t.test('expired fits cannot produce any new result download', async () => {
      await withServer({ adapterPath, fitTtlMs: 1 }, async expiredBase => {
        const fitResponse = await post(expiredBase, '/api/fit', { rows: observations(), settings });
        const expired = await fitResponse.json();
        assert.equal(fitResponse.status, 200, JSON.stringify(expired));
        await new Promise(resolve => setTimeout(resolve, 10));
        for (const query of ['format=xlsx&locale=zh', 'format=csv&layout=readable-v1&locale=en',
          'format=zip&layout=readable-v1&locale=zh', 'format=json', 'format=zip',
          'format=zip&scope=analysis&contents=excel&layout=readable-v1',
          'format=zip&scope=analysis&contents=archive&layout=readable-v1'])
          await expectError(await download(expiredBase, expired.fitId, query), 410, 'FIT_EXPIRED');
      });
    });
  });
});
