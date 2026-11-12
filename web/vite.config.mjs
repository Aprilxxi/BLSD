import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createBlsdMiddleware } from "./server/api.mjs";

const blsdApiPlugin = {
  name: "blsd-r-api",
  configureServer(server) {
    const api = createBlsdMiddleware();
    server.middlewares.use(api);
    // Unknown API requests must never download the SPA HTML as a result file.
    server.middlewares.use((req, res, next) => {
      if (!new URL(req.url, 'http://localhost').pathname.startsWith('/api/')) return next();
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'API_NOT_FOUND', message: 'This API route is unavailable.' } }));
    });
    server.httpServer?.once("close", () => { api.close().catch(() => {}); });
  },
};

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    watch: { ignored: ["**/qa/**", "**/dist/**", "**/server/.jobs/**"] },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [blsdApiPlugin, react()],
});
