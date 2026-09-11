import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
/** In viewer mode (VIEWER=1), the dev server's root redirects to the viewer page. */
const viewerRoot = () => ({
  name: "viewer-root",
  configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      if (process.env.VIEWER && (req.url === "/" || req.url === "/index.html")) { res.statusCode = 302; res.setHeader("Location", "/viewer.html"); res.end(); return; }
      next();
    });
  },
});

export default defineConfig({
  // The game ships as a single HTML file. `VIEWER=1 vite build` instead builds the model viewer (viewer.html)
  // as a normal multi-file bundle into dist-viewer/. In dev both are served: /  (game) and /viewer.html.
  plugins: [react(), tailwindcss(), viewerRoot(), ...(process.env.VIEWER ? [] : [viteSingleFile()])],
  server: { host: true, allowedHosts: true },
  build: process.env.VIEWER
    ? { outDir: "dist-viewer", rollupOptions: { input: path.resolve(__dirname, "viewer.html") } }
    : {},
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
