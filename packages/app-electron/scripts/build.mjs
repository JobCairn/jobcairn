#!/usr/bin/env node
// Builds the desktop app into packages/app-electron/dist: renderer (Vite), main (ESM) and preload (CJS), plus core's schemas.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const pkg = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(pkg, "../..");
const dist = path.join(pkg, "dist");
const withRenderer = !process.argv.includes("--no-renderer");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

if (withRenderer) {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "-w", "@careeros/app-ui"], { cwd: repo, stdio: "inherit" });
  fs.cpSync(path.join(repo, "packages/app-ui/dist"), path.join(dist, "renderer"), { recursive: true });
}

// Workspace packages bundle from this checkout's sources, never through node_modules (a worktree may
// share another checkout's node_modules, whose @careeros/* links point there).
const LOCAL = {
  "@careeros/core": "packages/core/src/index.ts", "@careeros/contract": "packages/contract/src/index.ts",
  "@careeros/services": "packages/services/src/index.ts", "@careeros/mail": "packages/mail/src/index.ts", "@careeros/video": "packages/video/src/index.ts", "@careeros/brand/tokens": "packages/brand/dist/tokens.ts",
  "@careeros/brand/identity": "packages/brand/identity.ts", "@careeros/brand/identity.json": "packages/brand/identity.json",
};
const localPackages = {
  name: "local-packages",
  setup(b) { b.onResolve({ filter: /^@careeros\// }, (a) => (LOCAL[a.path] ? { path: path.join(repo, LOCAL[a.path]) } : undefined)); },
};
// The mail libraries stay runtime require()s from node_modules: they load optional encodings and parsers
// dynamically, which bundling breaks.
const MAIL_LIBS = ["imapflow", "nodemailer", "mailparser", "sanitize-html"];
const common = { plugins: [localPackages], bundle: true, platform: "node", target: "node24", external: ["electron", ...MAIL_LIBS], sourcemap: "linked", logLevel: "info" };
await build({
  ...common, entryPoints: [path.join(pkg, "src/main.ts")], outfile: path.join(dist, "main.js"), format: "esm",
  // Bundled CommonJS dependencies may call require() for Node built-ins; give the ESM bundle a real require.
  banner: { js: "import { createRequire as __careerosRequire } from 'node:module'; const require = __careerosRequire(import.meta.url);" },
});
await build({ ...common, entryPoints: [path.join(pkg, "src/preload.cts")], outfile: path.join(dist, "preload.cjs"), format: "cjs" });
// GSAP for the video compositions, next to main.js (video-host.ts gsapPath). Resolved through @careeros/video, which depends on it.
const requireVideo = createRequire(path.join(repo, "packages/video/package.json"));
fs.mkdirSync(path.join(dist, "vendor"), { recursive: true });
fs.copyFileSync(requireVideo.resolve("gsap/dist/gsap.min.js"), path.join(dist, "vendor", "gsap.min.js"));
// `careeros mcp`: the stdio MCP server Claude Code starts for each run (Electron run as Node). Same module folder
// as main.js, so core finds ../schemas the same way. Packaging carry: asarUnpack dist/mcp.mjs.
await build({
  ...common, entryPoints: [path.join(repo, "packages/services/src/claude/mcp/main.ts")], outfile: path.join(dist, "mcp.mjs"), format: "esm",
  banner: { js: "import { createRequire as __careerosRequire } from 'node:module'; const require = __careerosRequire(import.meta.url);" },
});

// The export worker runs as its own module next to main.js (services' isolate.ts loads ./parse-worker.mjs from there).
// Bundled, not copied: a packaged app has no node_modules for its Markdown parser import.
await build({ ...common, entryPoints: [path.join(repo, "packages/services/src/print/parse-worker.mjs")], outfile: path.join(dist, "parse-worker.mjs"), format: "esm" });
// "Fill from my resume" reads PDF and Word text in its own worker (services' resume-fill.ts loads it from next to main.js).
await build({
  ...common, entryPoints: [path.join(repo, "packages/services/src/resume-fill-worker.mjs")], outfile: path.join(dist, "resume-fill-worker.mjs"), format: "esm",
  banner: { js: "import { createRequire as __careerosRequire } from 'node:module'; const require = __careerosRequire(import.meta.url);" },
});

// The window and Dock icon. The PNGs are rendered from the brand's app-icon drawing (not committed: the
// privacy guard keeps binaries out of the repo), so render them on the first build. Rendering needs a
// Chromium (Playwright's or Chrome); without one the app still builds and runs with Electron's icon.
const icons = ["app-icon-512.png", "app-icon-1024.png"].map((f) => path.join(repo, "packages/brand/assets", f));
if (icons.some((f) => !fs.existsSync(f))) {
  try {
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "icons:png", "-w", "@careeros/brand"], { cwd: repo, stdio: "inherit" });
  } catch {
    console.warn("build: couldn't render the app icon (no Chromium for Playwright?). Continuing with Electron's default icon.");
  }
}
for (const f of icons) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dist, path.basename(f)));

// core loads its JSON schemas from ../schemas relative to the running module.
fs.rmSync(path.join(pkg, "schemas"), { recursive: true, force: true });
fs.cpSync(path.join(repo, "packages/core/schemas"), path.join(pkg, "schemas"), { recursive: true });
