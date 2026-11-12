const TASK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EARLY_POLL_DELAYS_MS = [0, 100, 200, 400, 300];

function aborted() {
  return new DOMException('The request was cancelled.', 'AbortError');
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const abort = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Short requests keep proxy deadlines independent of fitting/rendering time.
 * Older servers may return the final response immediately and remain compatible.
 * consume must await the complete response body; lifecycle protection lasts until
 * it returns, without copying or buffering an additional version of that body.
 */
export async function taskRequest(url, options = {}, {
  consume, fetchImpl = globalThis.fetch, pollIntervalMs,
  page = typeof window === 'undefined' ? null : window,
} = {}) {
  if (typeof consume !== 'function') throw new TypeError('A complete response consumer is required.');
  const headers = new Headers(options.headers);
  headers.set('Prefer', 'respond-async');
  const externalSignal = options.signal, controller = new AbortController(), signal = controller.signal;
  let taskUrl, released = false;
  function release() {
    if (!taskUrl || released) return;
    released = true;
    // DELETE acknowledges a fully consumed result or cancels abandoned work.
    // It needs its own short request even when navigation aborts the transfer.
    try { Promise.resolve(fetchImpl(taskUrl, { method: 'DELETE', keepalive: true, cache: 'no-store' })).catch(() => {}); }
    catch { /* The server also expires tasks whose client stops polling. */ }
  }
  function cancel() { controller.abort(); release(); }
  function checkCancelled() { if (signal.aborted) throw aborted(); }
  async function consumeResponse(response) {
    checkCancelled();
    const value = await consume(response);
    checkCancelled();
    release();
    return value;
  }
  externalSignal?.addEventListener('abort', cancel);
  page?.addEventListener('pagehide', cancel);
  try {
    if (externalSignal?.aborted) cancel();
    checkCancelled();
    let response = await fetchImpl(url, { ...options, headers, signal });
    if (response.status !== 202) return await consumeResponse(response);
    const accepted = await response.json();
    if (!TASK_ID.test(accepted?.taskId ?? '')) throw new Error('INVALID_TASK_RESPONSE');
    taskUrl = `/api/tasks/${accepted.taskId}`;
    checkCancelled();
    let pollAttempt = 0;
    while (true) {
      // Cached/small results can finish before the first one-second poll.
      // Four early checks then align with the original one-second cadence.
      const delay = pollIntervalMs === undefined ? EARLY_POLL_DELAYS_MS[pollAttempt++] ?? 1000 : pollIntervalMs;
      if (delay > 0 || pollIntervalMs !== undefined) await pause(delay, signal);
      checkCancelled();
      response = await fetchImpl(taskUrl, { signal, cache: 'no-store' });
      checkCancelled();
      if (response.status !== 202) return await consumeResponse(response);
      // Consume the small pending response before issuing the next request.
      await response.text();
    }
  } catch (error) {
    const wasCancelled = signal.aborted;
    cancel();
    throw wasCancelled ? aborted() : error;
  } finally {
    externalSignal?.removeEventListener('abort', cancel);
    page?.removeEventListener('pagehide', cancel);
  }
}
