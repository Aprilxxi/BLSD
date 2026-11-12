import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { mkdtemp, mkdir, readdir, readFile, lstat, rm, writeFile, unlink, symlink } from 'node:fs/promises';
import { createJobLifecycle } from '../server/job-lifecycle.mjs';
import { createTaskResultStore } from '../server/task-results.mjs';

class Response extends Writable {
  constructor({ hold = false, onWrite = () => {} } = {}) {
    super(); this.parts = []; this.hold = hold; this.onWrite = onWrite;
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; return this; }
  _write(chunk, encoding, callback) {
    this.parts.push(Buffer.from(chunk)); this.onWrite();
    if (this.hold) this.pendingWrite = callback; else callback();
  }
  continue() { this.hold = false; const callback = this.pendingWrite; this.pendingWrite = null; callback?.(); }
  get data() { return Buffer.concat(this.parts); }
}
const exists = async file => { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const jsonResponse = data => ({ status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, data });

async function fixture(t, { maxBytes = 1024 * 1024, wrapLifecycle = value => value } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'blsd-task-results-'));
  const lifecycle = createJobLifecycle({ jobRoot: root,
    processInspector: async () => ({ state: 'alive', startKey: 'fixture-owner' }),
    safetyCheck: async () => ({ safeToRecover: false, legacyIdle: false }) });
  const store = createTaskResultStore({ lifecycle: wrapLifecycle(lifecycle), maxBytes });
  t.after(async () => {
    await store.dispose().catch(() => {});
    await lifecycle.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, lifecycle, store, async directories() { return (await readdir(root)).filter(name => name.startsWith('blsd-')).map(name => path.join(root, name)); } };
}

test('spool preserves exact binary bytes, status and headers without retaining the Buffer', async t => {
  const f = await fixture(t), data = Buffer.alloc(140000);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const headers = { 'Content-Type': 'application/zip', 'Content-Disposition': "attachment; filename*=UTF-8''%E7%BB%93%E6%9E%9C.zip", 'Content-Length': data.length, 'Cache-Control': 'no-store' };
  const stored = await f.store.save({ status: 201, headers, data });
  assert.equal(stored.status, 201); assert.equal(stored.size, data.length); assert.equal(stored.activeReaders, 0);
  assert.equal(Object.hasOwn(stored, 'data'), false);
  const [directory] = await f.directories();
  assert.deepEqual((await readdir(directory)).sort(), ['.blsd-owner.json', 'payload.bin']);
  assert.deepEqual(await readFile(path.join(directory, 'payload.bin')), data);
  if (process.platform !== 'win32') assert.equal((await lstat(path.join(directory, 'payload.bin'))).mode & 0o777, 0o600);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = new Response(); await stored.send(res);
    assert.equal(res.status, 201); assert.deepEqual(res.headers, headers); assert.deepEqual(res.data, data);
  }
  headers['Content-Type'] = 'changed-after-save';
  assert.equal(stored.headers['Content-Type'], 'application/zip');
  await stored.remove(); assert.equal(await exists(directory), false);
});

test('remove pins an existing reader and refuses new readers until safe deletion', async t => {
  const f = await fixture(t), data = Buffer.alloc(250000, 7), stored = await f.store.save(jsonResponse(data));
  let firstWrite; const started = new Promise(resolve => { firstWrite = resolve; });
  const res = new Response({ hold: true, onWrite: firstWrite });
  const sending = stored.send(res); sending.catch(() => {});
  assert.equal(stored.activeReaders, 1);
  await started;
  const [directory] = await f.directories();
  let removed = false; const removing = stored.remove().then(() => { removed = true; });
  await Promise.resolve(); assert.equal(removed, false); assert.equal(await exists(directory), true);
  await assert.rejects(stored.send(new Response()), error => error.code === 'TASK_STORAGE_FAILED');
  res.continue(); await sending; await removing;
  assert.equal(stored.activeReaders, 0); assert.equal(await exists(directory), false); assert.deepEqual(res.data, data);
});

test('a disconnected download leaves the exact result available for retry', async t => {
  const f = await fixture(t), data = Buffer.alloc(250000, 12), stored = await f.store.save(jsonResponse(data));
  let firstWrite; const started = new Promise(resolve => { firstWrite = resolve; });
  const interrupted = new Response({ hold: true, onWrite: firstWrite });
  const sending = stored.send(interrupted); sending.catch(() => {}); await started;
  interrupted.destroy(); await assert.rejects(sending);
  assert.equal(stored.activeReaders, 0);
  const retry = new Response(); await stored.send(retry); assert.deepEqual(retry.data, data);
  assert.equal((await f.directories()).length, 1);
});

test('disposing one result closes only its readers and preserves a sibling result', async t => {
  const f = await fixture(t), a = await f.store.save(jsonResponse(Buffer.alloc(250000, 1))), b = await f.store.save(jsonResponse(Buffer.from('sibling')));
  let firstWrite; const started = new Promise(resolve => { firstWrite = resolve; });
  const res = new Response({ hold: true, onWrite: firstWrite });
  const sending = a.send(res); sending.catch(() => {}); await started;
  await a.dispose(); await assert.rejects(sending); assert.equal(a.activeReaders, 0);
  const retry = new Response(); await b.send(retry); assert.equal(retry.data.toString(), 'sibling');
  assert.equal((await f.directories()).length, 1);
});

test('oversized results fail before allocating storage and never remove another task', async t => {
  const f = await fixture(t, { maxBytes: 8 }), stored = await f.store.save(jsonResponse(Buffer.from('keep')));
  await assert.rejects(f.store.save(jsonResponse(Buffer.alloc(9))), error => error.status === 413 && error.code === 'TASK_RESULT_TOO_LARGE');
  assert.equal((await f.directories()).length, 1);
  const res = new Response(); await stored.send(res); assert.equal(res.data.toString(), 'keep');
});

test('save failure reports 507 and safely removes only its just-created directory', async t => {
  let allocations = 0;
  const f = await fixture(t, { wrapLifecycle: lifecycle => ({ ...lifecycle,
    async newJob() {
      const directory = await lifecycle.newJob(); allocations++;
      if (allocations === 2) await writeFile(path.join(directory, 'payload.tmp'), 'occupied');
      return directory;
    },
  }) });
  const a = await f.store.save(jsonResponse(Buffer.from('keep')));
  await assert.rejects(f.store.save(jsonResponse(Buffer.from('fail'))), error => error.status === 507 && error.code === 'TASK_STORAGE_FAILED');
  assert.equal((await f.directories()).length, 1);
  const res = new Response(); await a.send(res); assert.equal(res.data.toString(), 'keep');
});

test('a failed removal remains retryable without deleting sibling directories', async t => {
  let failRemoval = false;
  const f = await fixture(t, { wrapLifecycle: lifecycle => ({ ...lifecycle,
    async removeJob(directory) { if (failRemoval) throw Object.assign(new Error('blocked'), { code: 'EACCES' }); return lifecycle.removeJob(directory); },
  }) });
  const a = await f.store.save(jsonResponse(Buffer.from('first'))), b = await f.store.save(jsonResponse(Buffer.from('second')));
  failRemoval = true;
  await assert.rejects(a.remove(), error => error.code === 'TASK_STORAGE_FAILED');
  assert.equal((await f.directories()).length, 2);
  failRemoval = false; await a.remove(); assert.equal((await f.directories()).length, 1);
  const res = new Response(); await b.send(res); assert.equal(res.data.toString(), 'second');
});

test('a written payload with failed rename and failed cleanup retains a retryable cleanup reservation', async t => {
  let allocations = 0, blockedDirectory, denyCleanup = true;
  const f = await fixture(t, { wrapLifecycle: lifecycle => ({ ...lifecycle,
    async newJob() {
      const directory = await lifecycle.newJob();
      if (++allocations === 2) { blockedDirectory = directory; await mkdir(path.join(directory, 'payload.bin')); }
      return directory;
    },
    async removeJob(directory) {
      if (directory === blockedDirectory && denyCleanup) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return lifecycle.removeJob(directory);
    },
  }) });
  const sibling = await f.store.save(jsonResponse(Buffer.from('keep-sibling'))), data = Buffer.alloc(100000, 42);
  const failure = await f.store.save(jsonResponse(data)).then(() => assert.fail('The rename must fail.'), error => error);
  assert.equal(failure.status, 507); assert.equal(failure.code, 'TASK_STORAGE_FAILED');
  assert.equal(typeof failure.cleanup, 'function'); assert.equal(typeof failure.dispose, 'function');
  assert.equal(f.lifecycle.hasJob(blockedDirectory), true);
  assert.deepEqual(await readFile(path.join(blockedDirectory, 'payload.tmp')), data);
  await assert.rejects(failure.cleanup(), error => error.code === 'TASK_STORAGE_FAILED');
  assert.equal((await f.directories()).length, 2);
  const first = new Response(); await sibling.send(first); assert.equal(first.data.toString(), 'keep-sibling');
  denyCleanup = false; await failure.cleanup();
  assert.equal(await exists(blockedDirectory), false); assert.equal((await f.directories()).length, 1);
  const second = new Response(); await sibling.send(second); assert.equal(second.data.toString(), 'keep-sibling');
});

test('store disposal tracks and retries an unpublished payload when its original save failed', async t => {
  let blockedDirectory, denyCleanup = true;
  const f = await fixture(t, { wrapLifecycle: lifecycle => ({ ...lifecycle,
    async newJob() {
      const directory = await lifecycle.newJob(); blockedDirectory = directory;
      await mkdir(path.join(directory, 'payload.bin')); return directory;
    },
    async removeJob(directory) {
      if (denyCleanup) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return lifecycle.removeJob(directory);
    },
  }) });
  const failure = await f.store.save(jsonResponse(Buffer.alloc(100000, 4))).then(() => assert.fail('The rename must fail.'), error => error);
  assert.equal(typeof failure.cleanup, 'function');
  await assert.rejects(f.store.dispose(), /could not be safely removed/);
  assert.equal(await exists(blockedDirectory), true);
  denyCleanup = false; await f.store.dispose();
  assert.equal(await exists(blockedDirectory), false); assert.equal((await f.directories()).length, 0);
  await failure.cleanup(); // Idempotent after store-wide cleanup.
});

test('transient handle contention retries only the same owned result directory', async t => {
  const removals = []; let failures = 2;
  const f = await fixture(t, { wrapLifecycle: lifecycle => ({ ...lifecycle,
    async removeJob(directory) { removals.push(directory); if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return lifecycle.removeJob(directory); },
  }) });
  const stored = await f.store.save(jsonResponse(Buffer.from('retained'))); await stored.remove();
  assert.equal(removals.length, 3); assert.equal(new Set(removals).size, 1); assert.equal((await f.directories()).length, 0);
});

test('store disposal closes active readers, cleans owned files and rejects later saves', async t => {
  const f = await fixture(t), stored = await f.store.save(jsonResponse(Buffer.alloc(250000, 1)));
  let firstWrite; const started = new Promise(resolve => { firstWrite = resolve; });
  const res = new Response({ hold: true, onWrite: firstWrite });
  const sending = stored.send(res); sending.catch(() => {}); await started;
  await f.store.dispose(); await assert.rejects(sending);
  assert.equal((await f.directories()).length, 0);
  await assert.rejects(f.store.save(jsonResponse(Buffer.from('late'))), error => error.code === 'TASK_STORAGE_FAILED');
});

test('shutdown during save waits for creation and then safely removes the incomplete task', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), created = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { wrapLifecycle: lifecycle => ({ ...lifecycle,
    async newJob() { const directory = await lifecycle.newJob(); entered(); await gate; return directory; },
  }) });
  const saving = f.store.save(jsonResponse(Buffer.from('in flight'))); saving.catch(() => {}); await created;
  const disposal = f.store.dispose(); release();
  await assert.rejects(saving, error => error.code === 'TASK_STORAGE_FAILED'); await disposal;
  assert.equal((await f.directories()).length, 0);
});

test('linked payloads are never read or recursively removed as another result', async t => {
  const f = await fixture(t), a = await f.store.save(jsonResponse(Buffer.from('first'))), b = await f.store.save(jsonResponse(Buffer.from('other')));
  const [first, second] = await f.directories();
  // Locate by contents instead of relying on random directory ordering.
  const aDirectory = (await readFile(path.join(first, 'payload.bin'), 'utf8')) === 'first' ? first : second;
  const bDirectory = aDirectory === first ? second : first;
  await unlink(path.join(aDirectory, 'payload.bin'));
  await symlink(process.platform === 'win32' ? bDirectory : path.join(bDirectory, 'payload.bin'),
    path.join(aDirectory, 'payload.bin'), process.platform === 'win32' ? 'junction' : 'file');
  await assert.rejects(a.send(new Response()), error => error.code === 'TASK_STORAGE_FAILED');
  await assert.rejects(a.remove(), error => error.code === 'TASK_STORAGE_FAILED');
  const res = new Response(); await b.send(res); assert.equal(res.data.toString(), 'other');
});
