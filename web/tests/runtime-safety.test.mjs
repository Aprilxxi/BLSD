import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBlsdServer } from '../server/index.mjs';
import { clientRateLimitAddress } from '../server/api.mjs';
import { taskRequest } from '../src/taskRequest.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const consumeResponse = async response => new Response(await response.arrayBuffer(), {
  status: response.status, statusText: response.statusText, headers: response.headers,
});
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await wait(30); }
  assert.fail(message);
}
async function withServer(options, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blsd-runtime-safety-'));
  const jobRoot = path.join(root, 'jobs');
  const dynamic = typeof options === 'function' ? await options(root) : options;
  const server = createBlsdServer({ requestsPerMinute: 100, ...dynamic, jobRoot });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await run(`http://127.0.0.1:${server.address().port}`, { root, jobRoot, server }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blsd-runtime-safety-'));
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
}
const post = (base, endpoint, body, { signal, headers = {} } = {}) => fetch(`${base}${endpoint}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal,
});
function fitRequest(sexes = ['Fast']) {
  return { rows: sexes.flatMap(Sex => Array.from({ length: 5 }, (_, yi) => Array.from({ length: 5 }, (_, ai) =>
    ({ Year: 2000 + yi, Age_Mid: 30 + ai * 5, Count: ai + yi + 1, Pop: 100000, Sex }))).flat()),
  selectedSexes: sexes, settings: { method: 'quasi-gcv', draws: 100, kAge: 4, kYear: 4 } };
}
async function readCalls(root) {
  try { return (await readFile(path.join(root, 'calls.txt'), 'utf8')).trim().split(/\r?\n/).filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function controlledAdapter(root) {
  const adapterPath = path.join(root, 'controlled-adapter.R');
  const calls = JSON.stringify(path.join(root, 'calls.txt').replaceAll('\\', '/'));
  await writeFile(adapterPath, `args <- commandArgs(trailingOnly=TRUE)
request <- jsonlite::fromJSON(args[1])
sex <- request$rows$Sex[1]
cat(paste0(sex, "|", Sys.getpid(), "\\n"), file=${calls}, append=TRUE)
if (grepl("Slow", sex)) Sys.sleep(20)
result <- list(schemaVersion="1", meta=list(fitted=TRUE), settings=request$settings,
 grid=list(years=sort(unique(request$rows$Year)), ages=sort(unique(request$rows$Age_Mid))),
 points=list(list(year=2000, age=30, surface=0)))
saveRDS(result, file.path(dirname(args[2]), "fit.rds"))
jsonlite::write_json(result, args[2], auto_unbox=TRUE, null="null")
`);
  return { adapterPath, timeoutMs: 30000 };
}
async function requireRuntime(t, base) {
  const health = await (await fetch(`${base}/api/health`)).json();
  if (!health.available) { t.skip('R and jsonlite are required for controlled child-process cancellation.'); return false; }
  return true;
}

test('malformed raw HTTP URLs return 400 and leave the HTTP server available', async () => {
  await withServer({}, async base => {
    const socket = connect(new URL(base).port, '127.0.0.1');
    socket.setEncoding('utf8'); let received = '';
    socket.on('data', chunk => { received += chunk; });
    await once(socket, 'connect');
    socket.end('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await once(socket, 'close');
    assert.match(received, /^HTTP\/1\.1 400 /);
    assert.match(received, /INVALID_URL/);
    assert.equal((await post(base, '/api/fit', {})).status, 400);
  });
});

test('proxy identities require explicit trust, a loopback peer and one valid X-Real-IP', () => {
  const req = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: { 'x-real-ip': forwarded } });
  assert.equal(clientRateLimitAddress(req('127.0.0.1', '198.51.100.1')), '127.0.0.1');
  assert.equal(clientRateLimitAddress(req('198.51.100.2', '198.51.100.1'), 'loopback'), '198.51.100.2');
  for (const local of ['127.0.0.1', '127.12.3.4', '::1', '::ffff:127.0.0.1'])
    assert.equal(clientRateLimitAddress(req(local, '198.51.100.1'), 'loopback'), '198.51.100.1');
  for (const invalid of ['198.51.100.1, 198.51.100.2', 'unknown', ['198.51.100.1'], '127.0.0.999'])
    assert.equal(clientRateLimitAddress(req('127.0.0.1', invalid), 'loopback'), '127.0.0.1');
});

test('trusted proxy users receive separate rate-limit buckets', async () => {
  await withServer({ trustProxy: 'loopback', requestsPerMinute: 1 }, async base => {
    const first = { headers: { 'x-real-ip': '198.51.100.1' } }, second = { headers: { 'x-real-ip': '198.51.100.2' } };
    assert.equal((await post(base, '/api/fit', {}, first)).status, 400);
    assert.equal((await post(base, '/api/fit', {}, second)).status, 400);
    assert.equal((await post(base, '/api/fit', {}, first)).status, 429);
  });
});

test('disconnect terminates the active R child and discards every completed sibling', { timeout: 20000 }, async t => {
  await withServer(controlledAdapter, async (base, { root, jobRoot }) => {
    if (!(await requireRuntime(t, base))) return;
    const controller = new AbortController();
    const abandoned = post(base, '/api/fit-groups', fitRequest(['Done', 'Slow', 'Never']), { signal: controller.signal });
    const rejection = assert.rejects(abandoned, { name: 'AbortError' });
    let pid;
    await until(async () => {
      const slow = (await readCalls(root)).find(call => call.startsWith('Slow|'));
      if (slow) pid = Number(slow.split('|')[1]);
      return !!slow;
    }, 'The controlled child did not start.');
    controller.abort(); await rejection;
    await until(async () => (await readdir(jobRoot)).filter(name => name.startsWith('blsd-')).length === 0,
      'Cancelled analysis directories, including the completed group, must be removed.');
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'The cancelled R process is still alive.');
    assert.ok(!(await readCalls(root)).some(call => call.startsWith('Never|')));
    const response = await post(base, '/api/fit-groups', fitRequest());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].status, 'fulfilled');
  });
});

test('a cancelled queued analysis releases capacity and never starts an R child', { timeout: 20000 }, async t => {
  await withServer(async root => ({ ...await controlledAdapter(root), queueLimit: 1 }), async (base, { root }) => {
    if (!(await requireRuntime(t, base))) return;
    const activeController = new AbortController(), queuedController = new AbortController();
    const active = post(base, '/api/fit-groups', fitRequest(['SlowActive']), { signal: activeController.signal });
    const activeRejected = assert.rejects(active, { name: 'AbortError' });
    await until(async () => (await readCalls(root)).some(call => call.startsWith('SlowActive|')), 'The blocking child did not start.');
    const queued = post(base, '/api/fit-groups', fitRequest(['Queued']), { signal: queuedController.signal });
    const queuedRejected = assert.rejects(queued, { name: 'AbortError' });
    await wait(100); queuedController.abort(); await queuedRejected; await wait(100);
    const replacement = post(base, '/api/fit-groups', fitRequest(['Replacement']));
    await wait(100); activeController.abort(); await activeRejected;
    const response = await replacement;
    assert.equal(response.status, 200, 'An abandoned queued request must not occupy the queue limit.');
    assert.equal((await response.json()).results[0].status, 'fulfilled');
    assert.ok(!(await readCalls(root)).some(call => call.startsWith('Queued|')));
  });
});

test('async API validates tasks and keeps polling outside submission rate limits', async () => {
  await withServer({ requestsPerMinute: 1 }, async base => {
    const accepted = await post(base, '/api/fit-groups', {}, { headers: { Prefer: 'respond-async' } });
    assert.equal(accepted.status, 202);
    const { taskId } = await accepted.json();
    let final;
    await until(async () => {
      const response = await fetch(`${base}/api/tasks/${taskId}`);
      if (response.status !== 202) { final = response; return true; }
      await response.text(); return false;
    }, 'The validation response must be retained until explicitly acknowledged.');
    assert.equal(final.status, 400);
    assert.equal((await final.json()).error.code, 'INVALID_DATA');
    assert.equal((await fetch(`${base}/api/tasks/${taskId}`)).status, 400);
    assert.equal((await post(base, '/api/fit-groups', {}, { headers: { Prefer: 'respond-async' } })).status, 429);
    assert.equal((await fetch(`${base}/api/tasks/not-a-uuid`)).status, 400);
    assert.equal((await fetch(`${base}/api/tasks/${taskId}`, { method: 'DELETE', headers: { Origin: 'https://other.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/tasks/${taskId}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/api/tasks/${taskId}`)).status, 404);
  });
});

test('full async storage returns 429 without discarding unclaimed API results', async () => {
  await withServer({ taskBytes: 1024, asyncTasks: { maxTasks: 2, maxStoredBytes: 2048 } }, async (base, { jobRoot }) => {
    const ids = [];
    for (let index = 0; index < 2; index += 1) {
      const accepted = await post(base, '/api/fit-groups', {}, { headers: { Prefer: 'respond-async' } });
      assert.equal(accepted.status, 202); ids.push((await accepted.json()).taskId);
    }
    for (const taskId of ids) await until(async () => {
      const response = await fetch(`${base}/api/tasks/${taskId}`);
      const body = await response.json();
      if (response.status === 202) return false;
      assert.equal(response.status, 400); assert.equal(body.error.code, 'INVALID_DATA'); return true;
    }, 'A completed validation result was lost.');
    const refused = await post(base, '/api/fit-groups', {}, { headers: { Prefer: 'respond-async' } });
    assert.equal(refused.status, 429); assert.equal((await refused.json()).error.code, 'SERVER_BUSY');
    for (const taskId of ids) {
      const result = await fetch(`${base}/api/tasks/${taskId}`);
      assert.equal(result.status, 400); assert.equal((await result.json()).error.code, 'INVALID_DATA');
    }
    assert.equal((await fetch(`${base}/api/tasks/${ids[0]}`, { method: 'DELETE' })).status, 204);
    await until(async () => (await readdir(jobRoot)).filter(name => name.startsWith('blsd-')).length === 1,
      'The acknowledged result did not release its owned storage.');
    const replacement = await post(base, '/api/fit-groups', {}, { headers: { Prefer: 'respond-async' } });
    assert.equal(replacement.status, 202); await replacement.json();
    assert.equal((await fetch(`${base}/api/tasks/${ids[1]}`)).status, 400, 'Admitting new work must preserve the other result.');
  });
});

test('short proxy deadlines do not interrupt async fits or alter retained binary downloads', { timeout: 30000 }, async t => {
  await withServer(async root => {
    const options = await controlledAdapter(root);
    const source = await readFile(options.adapterPath, 'utf8');
    await writeFile(options.adapterPath, source.replace('sex <- request$rows$Sex[1]', 'sex <- request$rows$Sex[1]\nSys.sleep(0.5)'));
    const exporterPath = path.join(root, 'controlled-exporter.R');
    await writeFile(exporterPath, `args <- commandArgs(trailingOnly=TRUE)
manifest <- jsonlite::fromJSON(args[2], simplifyVector=FALSE)
for (group in manifest$groups) for (figure in group$figures)
  writeBin(charToRaw(figure$metric), file.path(args[3], figure$file))
jsonlite::write_json(list(ok=TRUE), args[4], auto_unbox=TRUE)
`);
    return { ...options, exporterPath };
  }, async (base, { root }) => {
    if (!(await requireRuntime(t, base))) return;
    let timeouts = 0;
    const proxy = createHttpServer((req, res) => {
      const upstream = httpRequest(new URL(req.url, base), { method: req.method, headers: req.headers }, received => {
        res.writeHead(received.statusCode, received.headers); received.pipe(res);
      });
      upstream.setTimeout(200, () => { timeouts += 1; upstream.destroy(); if (!res.headersSent) res.writeHead(504); res.end(); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.once('close', () => { if (!res.writableFinished) upstream.destroy(); });
      req.pipe(upstream);
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const address = `http://127.0.0.1:${proxy.address().port}`;
    const viaProxy = { consume: consumeResponse, fetchImpl: (url, options) => fetch(new URL(url, address), options), pollIntervalMs: 25, page: null };
    try {
      const response = await taskRequest('/api/fit-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fitRequest(['Proxy'])) }, viaProxy);
      assert.equal(response.status, 200);
      const result = await response.json(); assert.equal(result.results[0].status, 'fulfilled');
      assert.equal((await readCalls(root)).length, 1, 'Polling never repeats the fit.');
      const fitId = result.results[0].fitId;
      const download = `/api/results/${fitId}/download?scope=analysis&format=zip&layout=readable-v1&contents=excel`;
      const original = await fetch(new URL(download, base)); assert.equal(original.status, 200);
      const asyncFile = await taskRequest(download, {}, viaProxy); assert.equal(asyncFile.status, 200);
      for (const name of ['content-type', 'content-disposition', 'content-length'])
        assert.equal(asyncFile.headers.get(name), original.headers.get(name));
      assert.deepEqual(Buffer.from(await asyncFile.arrayBuffer()), Buffer.from(await original.arrayBuffer()));
      const figureBody = JSON.stringify({ fitId, format: 'png', locale: 'en' });
      const originalFigures = await post(base, '/api/export-bundle', JSON.parse(figureBody));
      assert.equal(originalFigures.status, 200);
      const figures = await taskRequest('/api/export-bundle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: figureBody }, viaProxy);
      assert.equal(figures.status, 200);
      assert.equal(figures.headers.get('Content-Type'), 'application/zip');
      assert.deepEqual(Buffer.from(await figures.arrayBuffer()), Buffer.from(await originalFigures.arrayBuffer()));
      assert.equal(timeouts, 0, 'A >500ms operation succeeds through a 200ms per-request proxy deadline.');
    } finally { await new Promise(resolve => proxy.close(resolve)); }
  });
});

test('DELETE cancels an async running analysis and leaves no retained sibling', { timeout: 20000 }, async t => {
  await withServer(controlledAdapter, async (base, { root, jobRoot }) => {
    if (!(await requireRuntime(t, base))) return;
    const accepted = await post(base, '/api/fit-groups', fitRequest(['Done', 'Slow', 'Never']), { headers: { Prefer: 'respond-async' } });
    assert.equal(accepted.status, 202); const { taskId } = await accepted.json();
    await until(async () => (await readCalls(root)).some(call => call.startsWith('Slow|')), 'The detached R operation did not start.');
    assert.equal((await fetch(`${base}/api/tasks/${taskId}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/api/tasks/${taskId}`)).status, 404);
    await until(async () => (await readdir(jobRoot)).filter(name => name.startsWith('blsd-')).length === 0, 'A cancelled async fit must discard every sibling.');
    assert.ok(!(await readCalls(root)).some(call => call.startsWith('Never|')));
  });
});

test('oversized asynchronous responses retain their explicit 413 error', { timeout: 20000 }, async t => {
  await withServer(async root => ({ ...await controlledAdapter(root), taskBytes: 256 }), async base => {
    if (!(await requireRuntime(t, base))) return;
    const result = await taskRequest('/api/fit-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fitRequest()) }, { consume: consumeResponse, fetchImpl: (url, options) => fetch(new URL(url, base), options), pollIntervalMs: 20, page: null });
    assert.equal(result.status, 413);
    assert.equal((await result.json()).error.code, 'TASK_RESULT_TOO_LARGE');
  });
});

test('shutdown still removes retained fits when a task payload fails safe cleanup', { timeout: 20000 }, async t => {
  await withServer(controlledAdapter, async (base, { jobRoot, server }) => {
    if (!(await requireRuntime(t, base))) return;
    const accepted = await post(base, '/api/fit-groups', fitRequest(), { headers: { Prefer: 'respond-async' } });
    assert.equal(accepted.status, 202); const { taskId } = await accepted.json();
    await until(async () => {
      const response = await fetch(`${base}/api/tasks/${taskId}`);
      const body = await response.json();
      if (response.status === 202) return false;
      assert.equal(response.status, 200); assert.equal(body.results[0].status, 'fulfilled'); return true;
    }, 'The retained fit and its asynchronous payload were not completed.');
    const directories = (await readdir(jobRoot)).filter(name => name.startsWith('blsd-'));
    assert.equal(directories.length, 2);
    let payloadDirectory, fitDirectory;
    for (const name of directories) {
      const directory = path.join(jobRoot, name), files = await readdir(directory);
      if (files.includes('payload.bin')) payloadDirectory = directory;
      if (files.includes('fit.rds')) fitDirectory = directory;
    }
    assert.ok(payloadDirectory && fitDirectory);
    // Changed ownership must block only this task's removal, while shutdown
    // still attempts the independent retained-model lifecycle cleanup.
    const marker = path.join(payloadDirectory, '.blsd-owner.json');
    const owner = JSON.parse(await readFile(marker, 'utf8')); owner.token = 'f'.repeat(64);
    await writeFile(marker, JSON.stringify(owner));
    const cleanupError = await new Promise(resolve => server.close(resolve));
    assert.ok(cleanupError instanceof AggregateError);
    assert.ok((await readdir(jobRoot)).includes(path.basename(payloadDirectory)), 'Unverified ownership remains protected.');
    assert.ok(!(await readdir(jobRoot)).includes(path.basename(fitDirectory)), 'A task cleanup error must not skip retained-fit cleanup.');
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), owner);
  });
});
