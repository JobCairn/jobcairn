import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import identity from "../identity.json" with { type: "json" };

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react(), { name: "product-name", transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", identity.name) }],
  build: { outDir: "../dist-guide", emptyOutDir: true, assetsInlineLimit: 0 },
  preview: { host: "127.0.0.1", port: 4179, strictPort: true },
});
