import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const response = (status, body) => ({ status, headers: { 'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, data: Buffer.from(JSON.stringify(body)) });
const errorResponse = (status, code, message) => response(status, { error: { code, message } });

/** Adapts the existing response writer without keeping an HTTP socket open. */
export function bufferedTaskResponse(signal, maxBytes) {
  const result = new EventEmitter();
  Object.assign(result, { destroyed: false, writableEnded: false, writableFinished: false, headersSent: false, statusCode: 200 });
  let headers = {}, captured;
  result.writeHead = (status, values = {}) => { result.statusCode = status; headers = values; result.headersSent = true; return result; };
  result.end = value => {
    if (result.destroyed || result.writableEnded) return;
    const data = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (data.length > maxBytes) throw Object.assign(new Error('The task response exceeds the supported size.'), { status: 413, code: 'TASK_RESULT_TOO_LARGE' });
    captured = { status: result.statusCode, headers, data };
    result.writableEnded = true; result.writableFinished = true;
    result.emit('finish'); result.emit('close');
  };
  const cancel = () => { if (!result.writableFinished) { result.destroyed = true; result.emit('close'); } };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  return { res: result, get response() { return captured; }, dispose() { signal.removeEventListener('abort', cancel); } };
}

export function createAsyncTaskManager({ store, maxTasks = 16, maxBytes = 256 * 1024 * 1024,
  maxStoredBytes = maxTasks * maxBytes, leaseMs = 120000, completedTtlMs = 300000, now = Date.now } = {}) {
  if (typeof store?.save !== 'function' || typeof store?.dispose !== 'function')
    throw new Error('A bounded task result store is required.');
  if (![maxTasks, maxBytes, leaseMs, completedTtlMs].every(value => Number.isSafeInteger(value) && value > 0) ||
      !Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 0) throw new Error('Invalid task storage limits.');
  const tasks = new Map(), inflight = new Set(), removals = new Set();
  let closed = false, closing;
  function cancelled(task) {
    task.controller.abort();
    task.result = errorResponse(499, 'REQUEST_CANCELLED', 'This task was cancelled.');
    task.expiresAt = now() + completedTtlMs;
  }
  function remove(id, force = false) {
    const task = tasks.get(id);
    if (!task) return Promise.resolve();
    task.deleting = true;
    if (force) task.result?.dispose?.().catch(() => {});
    if (task.removing) return task.removing;
    const cleanup = (async () => {
      await task.done;
      await task.stored?.remove();
      await task.failedCleanup?.();
      if (tasks.get(id) === task) tasks.delete(id);
    })();
    task.removing = cleanup;
    removals.add(cleanup);
    cleanup.finally(() => { removals.delete(cleanup); task.removing = null; }).catch(() => {});
    return cleanup;
  }
  function sweep() {
    const at = now();
    for (const [id, task] of tasks) {
      if (task.deleting) { remove(id).catch(() => {}); continue; }
      if (!task.result && task.leaseAt + leaseMs <= at) cancelled(task);
      if (task.result && task.expiresAt <= at && !task.result.activeReaders) remove(id).catch(() => {});
    }
  }
  const timer = setInterval(sweep, Math.min(leaseMs, completedTtlMs, 1000));
  timer.unref();
  return {
    submit(operation) {
      sweep();
      // Reserve the maximum possible payload before accepting work. Unclaimed
      // results keep their slot and are never evicted to admit another task.
      if (closed || tasks.size >= maxTasks || (tasks.size + 1) * maxBytes > maxStoredBytes)
        throw Object.assign(new Error('The task result store is full. Download or cancel existing tasks, then retry.'), { status: 429, code: 'SERVER_BUSY' });
      const id = randomUUID(), task = { controller: new AbortController(), leaseAt: now(), result: null, deleting: false };
      tasks.set(id, task);
      const running = Promise.resolve().then(() => {
        if (!task.controller.signal.aborted) return operation(task.controller.signal);
      }).then(async result => {
        if (closed || task.controller.signal.aborted) return;
        if (!result || result.data.length > maxBytes) result = errorResponse(413, 'TASK_RESULT_TOO_LARGE', 'The task response exceeds the supported size.');
        const saved = await store.save(result);
        task.stored = saved;
        if (closed || task.controller.signal.aborted || task.deleting) { await saved.dispose(); return; }
        task.result = {
          status: saved.status, headers: saved.headers, size: saved.size,
          get activeReaders() { return saved.activeReaders; },
          async send(res) {
            try { await saved.send(res); }
            finally { task.expiresAt = now() + completedTtlMs; }
          },
          remove: () => saved.remove(), dispose: () => saved.dispose(),
        };
        task.expiresAt = now() + completedTtlMs;
      }).catch(error => {
        // Failed writes can still own files when the filesystem rejects
        // cleanup. Keep the reservation until those exact files are removed.
        if (typeof error.cleanup === 'function') task.failedCleanup = error.cleanup;
        if (!closed && !task.controller.signal.aborted && !task.deleting) {
          task.result = errorResponse(error.status ?? 500, error.code ?? 'SERVER_ERROR',
            error.status ? error.message : 'The task could not be completed.');
          task.expiresAt = now() + completedTtlMs;
        }
      }).finally(() => inflight.delete(running));
      task.done = running;
      inflight.add(running);
      return id;
    },
    get(id) {
      sweep();
      const task = tasks.get(id);
      if (!task || task.deleting) return errorResponse(404, 'TASK_NOT_FOUND', 'This task is no longer available.');
      if (task.result) { task.expiresAt = now() + completedTtlMs; return task.result; }
      task.leaseAt = now();
      return response(202, { taskId: id });
    },
    cancel(id) {
      sweep();
      const task = tasks.get(id);
      if (!task) return errorResponse(404, 'TASK_NOT_FOUND', 'This task is no longer available.');
      if (!task.result) cancelled(task);
      // ACK/cancellation returns promptly; the reservation stays occupied until
      // any write or active reader has ended and the owned file is removed.
      remove(id).catch(() => {});
      return { status: 204, headers: { 'Cache-Control': 'no-store' }, data: Buffer.alloc(0) };
    },
    close() {
      return closing ??= (async () => {
        closed = true; clearInterval(timer);
        for (const task of tasks.values()) if (!task.result) cancelled(task);
        // Closing the store also unblocks readers whose clients stopped reading.
        const cleanup = store.dispose();
        const pending = [...inflight, ...removals, cleanup];
        const settled = await Promise.allSettled(pending);
        if (settled.at(-1).status === 'rejected') throw settled.at(-1).reason;
        tasks.clear();
      })();
    },
  };
}
