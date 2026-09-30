import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  build: { outDir: "../dist/web", emptyOutDir: true },
  // `npm run dev:web` hot-reloads the UI against `npm run preview` on port 3000.
  server: { port: 5173, proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true } } },
});
