import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { taskRequest } from '../src/taskRequest.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const taskUrl = `/api/tasks/${taskId}`;
const pending = () => Response.json({ taskId }, { status: 202 });
const settings = (fetchImpl, consume = response => response.json()) => ({ fetchImpl, consume, pollIntervalMs: 1, page: new EventTarget() });

test('async fitting uses short polls and returns the original final result', async () => {
  const calls = [], expected = { results: [{ sex: 'Male', fitId: 'retained-fit' }] };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length < 3 ? pending() : Response.json(expected);
  };
  const signal = new AbortController().signal;
  const payload = await taskRequest('/api/fit-groups', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal,
  }, settings(fetchImpl));
  assert.deepEqual(payload, expected);
  assert.equal(calls[0].options.headers.get('Prefer'), 'respond-async');
  assert.equal(calls[0].options.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(calls.slice(1).map(call => call.url), [taskUrl, taskUrl, taskUrl]);
  assert.equal(calls.at(-1).options.method, 'DELETE', 'A complete result is explicitly acknowledged.');
  const requests = calls.filter(call => call.options.method !== 'DELETE');
  assert.ok(requests.every(call => call.options.signal === requests[0].options.signal));
  assert.equal(requests[0].options.signal.aborted, false);
});

test('async binary downloads preserve bytes, MIME and attachment filename', async () => {
  const bytes = Uint8Array.from([80, 75, 3, 4, 0, 255]);
  let count = 0;
  const fetchImpl = async () => ++count === 1 ? pending() : new Response(bytes, { headers: {
    'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="figures.zip"',
  } });
  const actual = await taskRequest('/api/export-bundle', { method: 'POST', body: '{}' }, settings(fetchImpl,
    async response => ({ response, bytes: new Uint8Array(await response.arrayBuffer()) })));
  assert.equal(actual.response.headers.get('Content-Type'), 'application/zip');
  assert.equal(actual.response.headers.get('Content-Disposition'), 'attachment; filename="figures.zip"');
  assert.deepEqual(actual.bytes, bytes);
});

test('result-table GET downloads also opt into asynchronous execution', async () => {
  const calls = [];
  const body = await taskRequest('/api/results/fit/download?scope=analysis', {}, settings(async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? pending() : new Response('xlsx fixture');
  }, response => response.text()));
  assert.equal(calls[0].options.headers.get('Prefer'), 'respond-async');
  assert.equal(calls[1].url, taskUrl);
  assert.equal(body, 'xlsx fixture');
});

test('cancelling a pending request deletes the server task independently of the aborted signal', async () => {
  const controller = new AbortController(), calls = [];
  const options = settings(async (url, init) => { calls.push({ url, init }); return pending(); });
  options.pollIntervalMs = 1000;
  const result = taskRequest('/api/fit-groups', { method: 'POST', signal: controller.signal }, options);
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  const deletes = calls.filter(call => call.init.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url, taskUrl);
  assert.equal(deletes[0].init.keepalive, true);
  assert.equal(deletes[0].init.signal, undefined);
});

test('leaving the page cancels the remote task and removes listeners', async () => {
  const page = new EventTarget(), calls = [];
  const result = taskRequest('/api/export-bundle', { method: 'POST' }, {
    ...settings(async (url, init) => { calls.push({ url, init }); return pending(); }), page, pollIntervalMs: 10,
  });
  await new Promise(resolve => setTimeout(resolve, 2));
  page.dispatchEvent(new Event('pagehide'));
  await assert.rejects(result, { name: 'AbortError' });
  page.dispatchEvent(new Event('pagehide'));
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1);
});

test('synchronous compatibility and asynchronous errors keep their response status', async () => {
  const original = Response.json({ error: { code: 'FIT_EXPIRED' } }, { status: 410 });
  const originalPayload = await taskRequest('/api/export-bundle', {}, settings(async () => original, async response => {
    assert.equal(response, original, 'The consumer receives the original Response without an extra body copy.');
    return { status: response.status, payload: await response.json() };
  }));
  assert.equal(originalPayload.status, 410);
  assert.deepEqual(originalPayload.payload, { error: { code: 'FIT_EXPIRED' } });
  let count = 0;
  const failed = await taskRequest('/api/fit-groups', {}, settings(async () => ++count === 1 ? pending()
    : Response.json({ error: { code: 'FIT_TIMEOUT' } }, { status: 504 }),
  async response => ({ status: response.status, payload: await response.json() })));
  assert.equal(failed.status, 504);
  assert.deepEqual(failed.payload, { error: { code: 'FIT_TIMEOUT' } });
});

test('malformed task IDs never cause a poll or cancellation to an arbitrary URL', async () => {
  const calls = [];
  await assert.rejects(taskRequest('/api/fit-groups', {}, settings(async url => {
    calls.push(url); return Response.json({ taskId: '../../other' }, { status: 202 });
  })), /INVALID_TASK_RESPONSE/);
  assert.deepEqual(calls, ['/api/fit-groups']);
});

test('leaving during an in-flight final poll cannot deliver a completed download afterwards', async () => {
  const page = new EventTarget(), controller = new AbortController(), calls = [];
  let resolveFinal, pollStarted;
  const polling = new Promise(resolve => { pollStarted = resolve; });
  const final = new Promise(resolve => { resolveFinal = resolve; });
  const result = taskRequest('/api/export-bundle', { method: 'POST', signal: controller.signal }, {
    ...settings(async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (calls.length === 1) return pending();
      pollStarted();
      return final;
    }), page,
  });
  await polling;
  page.dispatchEvent(new Event('pagehide'));
  resolveFinal(new Response('completed archive', { headers: { 'Content-Type': 'application/zip' } }));
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1);
  assert.equal(getEventListeners(page, 'pagehide').length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('leaving during an older server synchronous response prevents late result delivery', async () => {
  const page = new EventTarget(), calls = [];
  let resolveResponse;
  const result = taskRequest('/api/fit-groups', { method: 'POST' }, {
    ...settings(async (url, init) => {
      calls.push({ url, init });
      return new Promise(resolve => { resolveResponse = resolve; });
    }), page,
  });
  page.dispatchEvent(new Event('pagehide'));
  resolveResponse(Response.json({ results: [] }));
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(calls.length, 1, 'An older server does not expose a task to cancel.');
  assert.equal(getEventListeners(page, 'pagehide').length, 0);
});

test('polling network failures cancel remote work and remove both lifecycle listeners', async () => {
  const page = new EventTarget(), controller = new AbortController(), calls = [];
  const networkError = new TypeError('Network request failed');
  await assert.rejects(taskRequest('/api/fit-groups', { signal: controller.signal }, {
    ...settings(async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'DELETE') throw new TypeError('Cancellation transport also failed');
      if (calls.length === 1) return pending();
      throw networkError;
    }), page,
  }), error => error === networkError);
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1);
  assert.equal(getEventListeners(page, 'pagehide').length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('already-aborted signals send no requests and successful completion releases all listeners', async () => {
  const page = new EventTarget(), controller = new AbortController();
  controller.abort();
  await assert.rejects(taskRequest('/api/fit-groups', { signal: controller.signal }, {
    ...settings(async () => { assert.fail('An already-cancelled operation must not start.'); }), page,
  }), { name: 'AbortError' });
  assert.equal(getEventListeners(page, 'pagehide').length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const active = new AbortController();
  let count = 0;
  await taskRequest('/api/fit-groups', { signal: active.signal }, {
    ...settings(async () => ++count === 1 ? pending() : Response.json({ results: [] })), page,
  });
  assert.equal(getEventListeners(page, 'pagehide').length, 0);
  assert.equal(getEventListeners(active.signal, 'abort').length, 0);
});

for (const asynchronous of [false, true]) {
  for (const format of ['json', 'zip']) {
    for (const cancellation of ['pagehide', 'external abort']) {
      test(`${cancellation} cancels a slow ${format} body from an ${asynchronous ? 'asynchronous' : 'older synchronous'} server`, async () => {
        const page = new EventTarget(), external = new AbortController(), calls = [];
        let startConsumption, stream, requestSignal;
        const consuming = new Promise(resolve => { startConsumption = resolve; });
        const fetchImpl = async (url, init) => {
          calls.push({ url, init });
          if (init.method === 'DELETE') return new Response(null, { status: 204 });
          if (asynchronous && calls.length === 1) return pending();
          requestSignal = init.signal;
          const body = new ReadableStream({ start(controller) { stream = controller; } });
          requestSignal.addEventListener('abort', () => stream.error(new DOMException('Cancelled body.', 'AbortError')), { once: true });
          return new Response(body, { headers: { 'Content-Type': format === 'zip' ? 'application/zip' : 'application/json' } });
        };
        const result = taskRequest('/api/export-bundle', { method: 'POST', signal: external.signal }, {
          ...settings(fetchImpl, async response => {
            startConsumption();
            return format === 'zip' ? response.blob() : response.json();
          }), page,
        });
        await consuming;
        stream.enqueue(new TextEncoder().encode(format === 'zip' ? 'PK' : '{"results":'));
        assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 0, 'A response header or partial body is not an acknowledgment.');
        assert.equal(getEventListeners(page, 'pagehide').length, 1, 'Page protection remains active during body consumption.');
        if (cancellation === 'pagehide') page.dispatchEvent(new Event('pagehide')); else external.abort();
        await assert.rejects(result, { name: 'AbortError' });
        assert.equal(requestSignal.aborted, true, 'The native fetch body receives the lifecycle cancellation.');
        assert.equal(calls.filter(call => call.init.method === 'DELETE').length, asynchronous ? 1 : 0);
        assert.equal(getEventListeners(page, 'pagehide').length, 0);
        assert.equal(getEventListeners(external.signal, 'abort').length, 0);
        page.dispatchEvent(new Event('pagehide')); external.abort();
        assert.equal(calls.filter(call => call.init.method === 'DELETE').length, asynchronous ? 1 : 0, 'Cleanup prevents duplicate cancellation.');
      });
    }
  }
}

test('successful slow ZIP transfer is acknowledged once only after complete consumption', async () => {
  const page = new EventTarget(), external = new AbortController(), calls = [];
  let stream, startConsumption;
  const consuming = new Promise(resolve => { startConsumption = resolve; });
  const bytes = Uint8Array.from([80, 75, 3, 4, 0, 255]);
  const result = taskRequest('/api/export-bundle', { method: 'POST', signal: external.signal }, {
    ...settings(async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (calls.length === 1) return pending();
      return new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
        headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="all-sexes.zip"' },
      });
    }, async response => {
      startConsumption();
      return { blob: await response.blob(), filename: response.headers.get('Content-Disposition') };
    }), page,
  });
  await consuming;
  stream.enqueue(bytes.subarray(0, 2));
  await Promise.resolve();
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 0);
  stream.enqueue(bytes.subarray(2)); stream.close();
  const actual = await result;
  assert.deepEqual(new Uint8Array(await actual.blob.arrayBuffer()), bytes);
  assert.equal(actual.blob.type, 'application/zip');
  assert.equal(actual.filename, 'attachment; filename="all-sexes.zip"');
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.init.method === 'GET' || !call.init.method).length, 1);
  const releases = calls.filter(call => call.init.method === 'DELETE');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].init.signal, undefined);
  assert.equal(getEventListeners(page, 'pagehide').length, 0);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
  page.dispatchEvent(new Event('pagehide')); external.abort();
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1);
});

test('body transport failure cannot deliver a partial download and retains its original error', async () => {
  const page = new EventTarget(), external = new AbortController(), calls = [];
  let stream, startConsumption;
  const consuming = new Promise(resolve => { startConsumption = resolve; });
  const failure = new TypeError('Download interrupted.');
  const result = taskRequest('/api/export-bundle', { method: 'POST', signal: external.signal }, {
    ...settings(async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (calls.length === 1) return pending();
      return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    }, async response => { startConsumption(); return response.blob(); }), page,
  });
  await consuming;
  stream.enqueue(new TextEncoder().encode('PK'));
  stream.error(failure);
  await assert.rejects(result, error => error === failure);
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1, 'The failed transfer is abandoned, not returned as a successful value.');
  assert.equal(getEventListeners(page, 'pagehide').length, 0);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});

test('invalid final JSON preserves the parse failure and failed acknowledgments cannot discard a received result', async () => {
  const calls = [];
  await assert.rejects(taskRequest('/api/fit-groups', {}, settings(async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return calls.length === 1 ? pending() : new Response('{"results":');
  })), SyntaxError);
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1);
  let count = 0;
  const payload = await taskRequest('/api/fit-groups', {}, settings(async (url, init) => {
    if (init.method === 'DELETE') throw new TypeError('Acknowledgment network failure.');
    return ++count === 1 ? pending() : Response.json({ results: [] });
  }));
  assert.deepEqual(payload, { results: [] });
});

test('response consumption must be explicit before starting any request', async () => {
  await assert.rejects(taskRequest('/api/fit-groups', {}, {
    fetchImpl: async () => assert.fail('Missing body handling must fail before network access.'),
  }), TypeError);
});

test('default polling checks immediately, bounds early checks, then aligns with the one-second cadence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const external = new AbortController(), calls = [];
  t.after(() => external.abort());
  const turn = () => new Promise(resolve => setImmediate(resolve));
  let polls = 0;
  const result = taskRequest('/api/fit-groups', { method: 'POST', signal: external.signal }, {
    consume: response => response.json(), page: new EventTarget(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (init.method === 'POST') return pending();
      return ++polls === 7 ? Response.json({ results: [] }) : pending();
    },
  });
  await turn();
  assert.equal(polls, 1, 'The first check has no artificial timer delay.');
  for (const [delay, expected] of [[100, 2], [200, 3], [400, 4], [300, 5], [1000, 6], [1000, 7]]) {
    t.mock.timers.tick(delay - 1); await turn();
    assert.equal(polls, expected - 1);
    t.mock.timers.tick(1); await turn();
    assert.equal(polls, expected);
  }
  assert.deepEqual(await result, { results: [] });
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1);
});

test('an explicit polling interval retains its original fixed delay including the first check', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const external = new AbortController(); t.after(() => external.abort());
  const turn = () => new Promise(resolve => setImmediate(resolve));
  let polls = 0;
  const result = taskRequest('/api/fit-groups', { method: 'POST', signal: external.signal }, {
    consume: response => response.json(), pollIntervalMs: 1000, page: new EventTarget(),
    fetchImpl: async (url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (init.method === 'POST') return pending();
      return ++polls === 2 ? Response.json({ results: [] }) : pending();
    },
  });
  await turn(); assert.equal(polls, 0);
  t.mock.timers.tick(999); await turn(); assert.equal(polls, 0);
  t.mock.timers.tick(1); await turn(); assert.equal(polls, 1);
  t.mock.timers.tick(999); await turn(); assert.equal(polls, 1);
  t.mock.timers.tick(1); await turn();
  assert.deepEqual(await result, { results: [] });
  assert.equal(polls, 2);
});

test('cancelling during the early polling window stops its timer and releases only that task', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const external = new AbortController(), page = new EventTarget(), calls = [];
  const turn = () => new Promise(resolve => setImmediate(resolve));
  const result = taskRequest('/api/fit-groups', { method: 'POST', signal: external.signal }, {
    consume: response => response.json(), page,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return init.method === 'DELETE' ? new Response(null, { status: 204 }) : pending(); },
  });
  await turn(); external.abort();
  await assert.rejects(result, { name: 'AbortError' });
  t.mock.timers.tick(10000); await turn();
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(calls.filter(call => !call.init.method).length, 1);
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1);
  assert.equal(getEventListeners(page, 'pagehide').length, 0);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});
