import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { brandAlias } from "../brand/alias.mjs";
import identity from "../brand/identity.json" with { type: "json" };
import { mockMailFrames } from "./scripts/mock-mail-frames";

// base "./" lets the Electron app:// protocol serve the build from any folder.
// assetsInlineLimit 0 keeps fonts and icons as files, so the strict CSP (no data: URLs) holds.
// Workspace packages resolve to this checkout's sources (a worktree may share another checkout's node_modules).
export default defineConfig({
  base: "./",
  plugins: [react(), mockMailFrames(), { name: "product-name", transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", identity.name) }],
  resolve: {
    alias: [
      { find: /^@careeros\/contract$/, replacement: path.resolve(import.meta.dirname, "../contract/src/index.ts") },
      ...brandAlias(path.resolve(import.meta.dirname, "../brand")),
    ],
  },
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
