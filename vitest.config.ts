import path from "node:path";
import { defineConfig } from "vitest/config";
import { brandAlias } from "./packages/brand/alias.mjs";

const r = (p: string) => path.resolve(import.meta.dirname, p);
// Workspace packages resolve to this checkout's sources, never through node_modules: a worktree may
// share node_modules with another checkout, whose @careeros/* links point at that checkout.
const alias = [
  { find: "@careeros/core", replacement: r("packages/core/src/index.ts") },
  { find: "@careeros/contract", replacement: r("packages/contract/src/index.ts") },
  { find: "@careeros/services", replacement: r("packages/services/src/index.ts") },
  { find: "@careeros/mail", replacement: r("packages/mail/src/index.ts") },
  { find: "@careeros/video", replacement: r("packages/video/src/index.ts") },
  ...brandAlias(r("packages/brand")),
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      { extends: true, test: { name: "node", environment: "node", include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts"] } },
      {
        extends: true,
        esbuild: { jsx: "automatic" },
        test: { name: "dom", environment: "jsdom", include: ["packages/*/test/**/*.test.tsx"], setupFiles: [r("tests/dom-setup.ts")] },
      },
    ],
  },
});
