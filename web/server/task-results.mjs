import path from 'node:path';
import { constants, createReadStream } from 'node:fs';
import { lstat, realpath, rename, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const DEFAULT_LIMIT = 256 * 1024 * 1024;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const storageError = cause => Object.assign(new Error('The task result could not be stored or accessed.'), {
  status: 507, code: 'TASK_STORAGE_FAILED', cause,
});
const cancelledReader = () => Object.assign(new Error('The task result reader was closed.'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });

async function plainDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory))
    throw new Error('The result directory must be a real directory.');
}

/** Retains exact response bytes privately on disk until explicit release. */
export function createTaskResultStore({ lifecycle, maxBytes = DEFAULT_LIMIT } = {}) {
  if (typeof lifecycle?.newJob !== 'function' || typeof lifecycle?.removeJob !== 'function')
    throw new Error('A verified job lifecycle is required.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('The result size limit must be a nonnegative integer.');
  const stored = new Set(), saves = new Set();
  let closed = false, disposing;

  async function removeDirectory(directory) {
    // Retry transient Windows handle/antivirus contention only at this exact,
    // lifecycle-owned directory. A failed call remains retryable by the owner.
    for (let attempt = 0; ; attempt++) {
      try { await lifecycle.removeJob(directory); return; }
      catch (error) {
        if (attempt >= 2 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }

  function descriptor(directory, status, headers, size) {
    const payload = path.join(directory, 'payload.bin'), readers = new Set(), idle = new Set();
    let deleting = false, removed = false, removing;
    const release = reader => {
      readers.delete(reader);
      if (!readers.size) { for (const resolve of idle) resolve(); idle.clear(); }
    };
    const result = {
      status, headers, size,
      get activeReaders() { return readers.size; },
      async send(res) {
        if (deleting || removed || closed) throw storageError();
        // Pin synchronously, before any filesystem await or HTTP write.
        const reader = { stream: null, res, cancelled: false };
        readers.add(reader);
        let sourceClosed;
        try {
          try {
            await plainDirectory(directory);
            const info = await lstat(payload);
            if (!info.isFile() || info.isSymbolicLink() || info.size !== size) throw new Error('The result payload changed.');
          } catch (error) { throw storageError(error); }
          if (reader.cancelled || res.destroyed || res.writableEnded) throw cancelledReader();
          const source = createReadStream(payload, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0), highWaterMark: 64 * 1024 });
          reader.stream = source;
          sourceClosed = new Promise(resolve => source.once('close', resolve));
          source.once('error', () => {}); // A writeHead failure can precede pipeline's listeners.
          res.writeHead(status, headers);
          await pipeline(source, res);
        } finally {
          reader.stream?.destroy();
          if (sourceClosed) await sourceClosed;
          release(reader);
        }
      },
      remove() {
        deleting = true;
        if (removed) return Promise.resolve();
        return removing ??= (async () => {
          if (readers.size) await new Promise(resolve => idle.add(resolve));
          try { await removeDirectory(directory); }
          catch (error) { throw storageError(error); }
          removed = true; stored.delete(result);
        })().catch(error => { removing = undefined; throw error; });
      },
      dispose() {
        deleting = true;
        for (const reader of readers) {
          reader.cancelled = true;
          reader.stream?.destroy();
          reader.res.destroy();
        }
        return result.remove();
      },
    };
    return result;
  }

  return {
    save(response) {
      if (closed) return Promise.reject(storageError());
      if (!Buffer.isBuffer(response?.data)) return Promise.reject(storageError());
      if (response.data.length > maxBytes) return Promise.reject(Object.assign(new Error('The task response exceeds the supported size.'), {
        status: 413, code: 'TASK_RESULT_TOO_LARGE',
      }));
      const operation = (async () => {
        let directory, result;
        try {
          directory = path.resolve(await lifecycle.newJob());
          if (typeof lifecycle.hasJob === 'function' && !lifecycle.hasJob(directory)) throw new Error('Unowned result directory.');
          await plainDirectory(directory);
          await writeFile(path.join(directory, 'payload.tmp'), response.data, { flag: 'wx', mode: 0o600 });
          await rename(path.join(directory, 'payload.tmp'), path.join(directory, 'payload.bin'));
          result = descriptor(directory, response.status, { ...response.headers }, response.data.length);
          stored.add(result);
          if (closed) { await result.dispose(); throw storageError(); }
          return result;
        } catch (error) {
          const failure = error?.code === 'TASK_STORAGE_FAILED' ? error : storageError(error);
          if (directory && (typeof lifecycle.hasJob !== 'function' || lifecycle.hasJob(directory))) {
            // A failed write/rename can still consume the full reservation.
            // Track cleanup even though no downloadable payload was published.
            result ??= descriptor(directory, 0, {}, 0);
            stored.add(result);
            try { await result.remove(); }
            catch {
              // Keep only descriptor methods, not this save's Buffer scope.
              failure.cleanup = result.remove;
              failure.dispose = result.dispose;
            }
          }
          throw failure;
        }
      })();
      saves.add(operation);
      operation.finally(() => saves.delete(operation)).catch(() => {});
      return operation;
    },
    dispose() {
      closed = true;
      return disposing ??= (async () => {
        await Promise.allSettled([...saves]);
        const results = await Promise.allSettled([...stored].map(result => result.dispose()));
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Some task results could not be safely removed.');
      })().catch(error => { disposing = undefined; throw error; });
    },
  };
}
