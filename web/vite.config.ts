import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const preview = process.env.LEERR_PREVIEW_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  build: { outDir: "../dist/web", emptyOutDir: true },
  // `npm run dev:web` hot-reloads the UI against `npm run preview`.
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: preview,
        changeOrigin: true,
        // The server refuses writes from another origin; the dev server's own requests are rewritten to the preview's.
        configure: (proxy) =>
          proxy.on("proxyReq", (request) => {
            if (request.getHeader("origin") === "http://localhost:5173") request.setHeader("origin", preview);
          }),
      },
    },
  },
});
