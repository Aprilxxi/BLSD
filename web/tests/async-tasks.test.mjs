import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncTaskManager, bufferedTaskResponse } from '../server/async-tasks.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = (size = 10) => ({ status: 200, headers: { 'Content-Type': 'application/zip' }, data: Buffer.alloc(size, 80) });
function fixture(options = {}) {
  const stored = new Set();
  const store = {
    async save(response) {
      const bytes = Buffer.from(response.data);
      const item = { status: response.status, headers: response.headers, size: bytes.length, activeReaders: 0,
        async send(res) { res.writeHead(response.status, response.headers); res.end(bytes); },
        async remove() { stored.delete(item); }, async dispose() { stored.delete(item); } };
      stored.add(item); return item;
    },
    async dispose() { stored.clear(); },
  };
  return { manager: createAsyncTaskManager({ store, ...options }), store, stored };
}
async function payload(result) {
  if (result.data) return result.data;
  let bytes;
  await result.send({ writeHead() {}, end(data) { bytes = data; } });
  return bytes;
}

test('the seventeenth task is rejected without dropping any unclaimed result', async t => {
  const { manager } = fixture(); t.after(() => manager.close());
  const ids = [];
  for (let i = 0; i < 16; i++) { ids.push(manager.submit(() => reply(2))); await tick(); }
  assert.throws(() => manager.submit(() => reply(2)), error => error.status === 429);
  for (const id of ids) assert.deepEqual(await payload(manager.get(id)), reply(2).data);
  assert.equal(manager.cancel(ids[0]).status, 204); await tick();
  const next = manager.submit(() => reply(2)); await tick();
  assert.equal(manager.get(next).status, 200);
  assert.equal(manager.get(ids[0]).status, 404);
});

test('byte capacity is reserved before submission and never evicts a finished ZIP', async t => {
  const { manager } = fixture({ maxBytes: 1024, maxStoredBytes: 2048 }); t.after(() => manager.close());
  const a = manager.submit(() => reply(600)), b = manager.submit(() => reply(600)); await tick();
  assert.throws(() => manager.submit(() => reply(2)), error => error.status === 429);
  assert.deepEqual(await payload(manager.get(a)), reply(600).data);
  assert.deepEqual(await payload(manager.get(b)), reply(600).data);
  manager.cancel(a); await tick();
  const c = manager.submit(() => reply(1024)); await tick();
  assert.deepEqual(await payload(manager.get(c)), reply(1024).data);
  assert.deepEqual(await payload(manager.get(b)), reply(600).data);
});

test('leases refresh, abandon work, and expire completed responses explicitly', async t => {
  let clock = 0, aborted = false;
  const { manager } = fixture({ leaseMs: 100, completedTtlMs: 200, now: () => clock }); t.after(() => manager.close());
  const id = manager.submit(signal => new Promise(resolve => signal.addEventListener('abort', () => {
    aborted = true; resolve(reply());
  }, { once: true })));
  await tick(); clock = 99; assert.equal(manager.get(id).status, 202);
  clock = 198; assert.equal(manager.get(id).status, 202);
  clock = 299; assert.equal(manager.get(id).status, 499); assert.equal(aborted, true);
  await tick(); assert.equal(manager.get(id).status, 499);
  clock = 500; assert.equal(manager.get(id).status, 404);
});

test('TTL preserves active readers and allows retry after a completed transfer', async t => {
  let clock = 0;
  const { manager, stored } = fixture({ completedTtlMs: 100, now: () => clock }); t.after(() => manager.close());
  const id = manager.submit(() => reply()); await tick();
  const saved = [...stored][0]; saved.activeReaders = 1;
  clock = 101; assert.equal(manager.get(id).status, 200);
  saved.activeReaders = 0; await payload(manager.get(id));
  clock = 200; assert.equal(manager.get(id).status, 200);
  clock = 301; assert.equal(manager.get(id).status, 404);
});

test('oversize and storage errors do not discard another task result', async t => {
  const { manager, store } = fixture({ maxBytes: 1024 }); t.after(() => manager.close());
  const good = manager.submit(() => reply(600)); await tick();
  const big = manager.submit(() => reply(1025)); await tick();
  assert.equal(manager.get(big).status, 413);
  store.save = async () => { throw Object.assign(new Error('Storage unavailable.'), { status: 507, code: 'TASK_STORAGE_FAILED' }); };
  const failed = manager.submit(() => reply()); await tick();
  assert.equal(manager.get(failed).status, 507);
  assert.deepEqual(await payload(manager.get(good)), reply(600).data);
});

test('cancel during saving retains its reservation until the saved bytes are removed', async t => {
  const { store } = fixture(); let finishSave, disposed = false;
  store.save = () => new Promise(resolve => { finishSave = () => resolve({ status: 200, headers: {}, size: 10,
    async dispose() { disposed = true; }, async remove() {} }); });
  const manager = createAsyncTaskManager({ store, maxTasks: 1 }); t.after(() => manager.close());
  const id = manager.submit(() => reply()); await tick();
  assert.equal(manager.cancel(id).status, 204);
  assert.throws(() => manager.submit(() => reply()), error => error.status === 429);
  finishSave(); await tick(); await tick();
  assert.equal(disposed, true); assert.equal(manager.get(id).status, 404);
  store.save = async result => ({ status: result.status, headers: result.headers, size: result.data.length, async remove() {}, async dispose() {} });
  assert.ok(manager.submit(() => reply()));
});

test('ACK is prompt but its slot remains reserved while a reader is active', async t => {
  const { store } = fixture(); let release;
  const idle = new Promise(resolve => { release = resolve; });
  store.save = async result => ({ status: 200, headers: result.headers, size: 10, activeReaders: 1,
    async remove() { await idle; }, async dispose() { release(); } });
  const manager = createAsyncTaskManager({ store, maxTasks: 1 }); t.after(() => manager.close());
  const id = manager.submit(() => reply()); await tick();
  assert.equal(manager.cancel(id).status, 204);
  assert.throws(() => manager.submit(() => reply()), error => error.status === 429);
  release(); await tick(); await tick();
  assert.ok(manager.submit(() => reply()));
});

test('response buffering preserves headers, bytes and the single-result limit', () => {
  const controller = new AbortController(), capture = bufferedTaskResponse(controller.signal, 32);
  const headers = { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="all.zip"', 'Content-Length': 10 };
  capture.res.writeHead(200, headers); capture.res.end(reply().data);
  assert.deepEqual(capture.response, { status: 200, headers, data: reply().data }); capture.dispose();
  const big = bufferedTaskResponse(controller.signal, 32);
  assert.throws(() => big.res.end(Buffer.alloc(33)), error => error.status === 413); big.dispose();
});

test('failed write cleanup keeps its reservation until the orphan is actually removed', async t => {
  const { store } = fixture(); let blocked = true;
  const cleanup = async () => { if (blocked) throw Object.assign(new Error('Busy file.'), { code: 'EACCES' }); };
  store.save = async () => { throw Object.assign(new Error('Storage unavailable.'), {
    status: 507, code: 'TASK_STORAGE_FAILED', cleanup,
  }); };
  const manager = createAsyncTaskManager({ store, maxTasks: 1, maxBytes: 16, maxStoredBytes: 16 });
  t.after(() => manager.close());
  const id = manager.submit(() => reply(16)); await tick();
  assert.equal(manager.get(id).status, 507);
  manager.cancel(id); await tick();
  assert.throws(() => manager.submit(() => reply(16)), error => error.status === 429);
  blocked = false; manager.get(id); await tick(); await tick();
  assert.ok(manager.submit(() => reply(16)));
});

test('cancelled saved result cleanup failure also retains the task reservation', async t => {
  const { store } = fixture(); let finishSave, blocked = true;
  const cleanup = async () => { if (blocked) throw new Error('Busy saved file.'); };
  store.save = () => new Promise(resolve => { finishSave = () => resolve({ status: 200, headers: {}, size: 16,
    remove: cleanup, dispose: cleanup }); });
  const manager = createAsyncTaskManager({ store, maxTasks: 1, maxBytes: 16, maxStoredBytes: 16 });
  t.after(() => manager.close());
  const id = manager.submit(() => reply(16)); await tick(); manager.cancel(id);
  finishSave(); await tick(); await tick();
  assert.throws(() => manager.submit(() => reply(16)), error => error.status === 429);
  blocked = false; manager.get(id); await tick(); await tick();
  const next = manager.submit(() => reply(16)); await tick(); finishSave(); await tick();
  assert.equal(manager.get(next).status, 200);
});

test('shutdown cancels pending operations and waits for cleanup', async () => {
  const { manager } = fixture(); let cleaned = false;
  manager.submit(signal => new Promise(resolve => signal.addEventListener('abort', () => setImmediate(() => {
    cleaned = true; resolve(reply());
  }), { once: true })));
  await tick(); await manager.close(); assert.equal(cleaned, true);
  assert.throws(() => manager.submit(() => reply()), error => error.status === 429);
});
