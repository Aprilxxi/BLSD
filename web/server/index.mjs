import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createBlsdMiddleware } from './api.mjs';
import { watchLauncherStop } from './job-lifecycle.mjs';

export function createBlsdServer(options = {}) {
  const middleware = createBlsdMiddleware(options);
  const clientRoot = path.resolve(options.clientRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'client'));
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
  const server = http.createServer((req, res) => { void middleware(req, res, async () => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
      const requested = path.resolve(clientRoot, `.${pathname}`);
      if (requested !== clientRoot && !requested.startsWith(`${clientRoot}${path.sep}`)) { res.writeHead(403); res.end(); return; }
      let target = requested;
      try { if (!(await stat(target)).isFile()) target = path.join(clientRoot, 'index.html'); }
      catch { target = path.join(clientRoot, 'index.html'); }
      const body = await readFile(target);
      res.writeHead(200, { 'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404); res.end('Not found'); }
  }).catch(() => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'SERVER_ERROR', message: 'The request could not be completed.' } }));
  }); });
  server.on('close', () => { middleware.close().catch(() => {}); });
  const closeHttp = server.close.bind(server);
  server.close = callback => {
    const cleanup = middleware.close();
    closeHttp(error => {
      cleanup.then(() => callback?.(error), cleanupError => callback?.(error ?? cleanupError));
    });
    return server;
  };
  let shutdown;
  server.shutdown = () => shutdown ??= Promise.all([
    middleware.close(),
    new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); }),
  ]).then(() => {});
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local server port.');
  const server = createBlsdServer();
  const stopWatching = watchLauncherStop(() => { server.shutdown().catch(() => {}); });
  server.once('close', stopWatching);
  server.listen(port, '127.0.0.1', () => process.stdout.write(`BLSD local R service: http://127.0.0.1:${port}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.shutdown().catch(() => {}); });
}
