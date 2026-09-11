import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  // The game ships as a single HTML file. `VIEWER=1 vite build` instead builds the model viewer (viewer.html)
  // as a normal multi-file bundle into dist-viewer/. In dev both are served: /  (game) and /viewer.html.
  plugins: [react(), tailwindcss(), ...(process.env.VIEWER ? [] : [viteSingleFile()])],
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
