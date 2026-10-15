#!/usr/bin/env node
// Builds the installers with electron-builder into packages/app-electron/dist-release (gitignored).
//   node scripts/package.mjs --mac              this Mac's architecture, from node_modules' Electron (no download)
//   node scripts/package.mjs --mac --all-arch   arm64 and x64 (downloads the other Electron build)
//   --win / --linux                             configured, but build them on their own systems or in CI
// Unsigned unless the signing environment variables are set (scripts/builder-config.mjs, docs/packaging.md).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { builderConfig, FONT_PACKAGES, notarizeMode, runtimeRequires } from "./builder-config.mjs";
import { icnsFromPngs } from "./mac-bundle.mjs";
import { notaryResult, notarytoolAuthArgs, uploadAssets, writeChecksums } from "./release.mjs";

const pkg = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(pkg, "../..");
const require = createRequire(path.join(pkg, "package.json"));
const args = process.argv.slice(2);
const identity = JSON.parse(fs.readFileSync(path.join(repo, "packages/brand/identity.json"), "utf8"));
const appPkg = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
const electronVersion = JSON.parse(fs.readFileSync(require.resolve("electron/package.json"), "utf8")).version;

const platform = args.includes("--win") ? "win" : args.includes("--linux") ? "linux" : "mac";
const allArch = args.includes("--all-arch");

// 1. The app itself: renderer, main, preload, MCP server, export worker, schemas, icons.
if (!args.includes("--skip-build")) execFileSync(process.execPath, [path.join(pkg, "scripts/build.mjs")], { cwd: pkg, stdio: "inherit" });

// 2. Stage only what ships. Everything is bundled, so the staged package.json has no dependencies and
//    electron-builder has no node_modules to collect.
const stage = path.join(pkg, ".package");
const appDir = path.join(stage, "app");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });
fs.cpSync(path.join(pkg, "dist"), path.join(appDir, "dist"), { recursive: true });
fs.cpSync(path.join(pkg, "schemas"), path.join(appDir, "schemas"), { recursive: true });
fs.writeFileSync(path.join(appDir, "package.json"), `${JSON.stringify({
  name: identity.internalId, productName: identity.name, version: appPkg.version, description: identity.tagline,
  author: identity.name, private: true, type: "module", main: "dist/main.js",
}, null, 2)}\n`);

// 3. Packages the bundles still load at run time, with their dependencies, from the repo's node_modules.
const modules = path.join(stage, "runtime", "node_modules");
const bundles = fs.readdirSync(path.join(appDir, "dist")).filter((f) => /\.(c|m)?js$/.test(f));
const wanted = new Set([...bundles.flatMap((f) => runtimeRequires(fs.readFileSync(path.join(appDir, "dist", f), "utf8"))), ...FONT_PACKAGES]);
const copied = new Set();
function copyPackage(name, from) {
  if (copied.has(name)) return;
  let dir = null;
  for (let d = from; ; d = path.dirname(d)) {
    const c = path.join(d, "node_modules", name);
    if (fs.existsSync(path.join(c, "package.json"))) { dir = fs.realpathSync(c); break; }
    if (path.dirname(d) === d) break;
  }
  if (!dir) throw new Error(`package: run-time module ${name} isn't installed`);
  copied.add(name);
  fs.cpSync(dir, path.join(modules, name), { recursive: true, dereference: true });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) copyPackage(dep, dir);
}
for (const name of wanted) copyPackage(name, repo);
console.log(`package: run-time modules: ${[...copied].sort().join(", ")}`);

// 4. Icons from the brand's rendered PNGs (the build renders them; see scripts/build.mjs).
const png = (s) => path.join(repo, "packages/brand/assets", `app-icon-${s}.png`);
let icons;
if (fs.existsSync(png(512)) && fs.existsSync(png(1024))) {
  const res = path.join(stage, "build-resources");
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, "icon.icns"), icnsFromPngs({ 512: fs.readFileSync(png(512)), 1024: fs.readFileSync(png(1024)) }));
  fs.copyFileSync(png(1024), path.join(res, "icon.png"));
  icons = { icns: path.join(res, "icon.icns"), png: path.join(res, "icon.png") };
} else {
  console.warn("package: no rendered app icon (packages/brand/assets/app-icon-*.png); the installer will use Electron's icon.");
}

// 5. electron-builder.
// electron-builder runs in the staged app folder: it has no dependencies, so no workspace node_modules are collected.
const output = path.join(pkg, "dist-release");
fs.rmSync(output, { recursive: true, force: true });
const config = builderConfig({ identity, electronVersion, env: process.env, pkgDir: pkg, appDir: ".", output, icons, runtimeModules: modules });
let builder;
try { builder = await import("electron-builder"); } catch {
  console.error("package: electron-builder isn't installed. Run `npm ci` at the repo root.");
  process.exit(1);
}
const { Arch, Platform, build } = builder;
// After the app is laid out, before signing: drop Electron's default app (electron-builder only does that for a
// downloaded Electron, not for electronDist), and make sure the guides folder exists even while it is empty
// (electron-builder skips empty folders; the app looks for resources/guides).
config.afterPack = async (ctx) => {
  const res = ctx.electronPlatformName === "darwin"
    ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(ctx.appOutDir, "resources");
  fs.rmSync(path.join(res, "default_app.asar"), { force: true });
  fs.mkdirSync(path.join(res, "guides"), { recursive: true });
};
// After every installer is built: a signed build's dmgs are notarised and stapled (electron-builder only does the
// app inside), then SHA256SUMS.txt is written beside them, which the website asks users to check. Stapling changes
// the dmg, so the sums come last.
config.afterAllArtifactBuild = async (result) => {
  if (config.mac.notarize) {
    const auth = notarytoolAuthArgs(notarizeMode(process.env), process.env);
    for (const dmg of result.artifactPaths.filter((f) => f.endsWith(".dmg"))) {
      console.log(`package: notarising ${path.basename(dmg)}`);
      const r = notaryResult(execFileSync("xcrun", ["notarytool", "submit", dmg, ...auth, "--wait", "--output-format", "json"], { encoding: "utf8" }));
      if (!r.accepted) throw new Error(`package: ${path.basename(dmg)} was not notarised (${r.status}). See: xcrun notarytool log ${r.id} <credentials>`);
      execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
    }
  }
  const file = writeChecksums(result.outDir, result.artifactPaths);
  return file ? [file] : [];
};
const hostArch = process.arch === "arm64" ? Arch.arm64 : Arch.x64;
let targets;
if (platform === "mac") {
  if (process.platform !== "darwin") { console.error("package: the mac build needs macOS."); process.exit(1); }
  if (!allArch) {
    // This Mac's architecture only, from the Electron already in node_modules: no download needed.
    config.electronDist = path.dirname(path.resolve(require("electron"), "..", "..", ".."));
    targets = Platform.MAC.createTarget(["dmg", "zip"], hostArch);
  }
} else if (platform === "win") {
  targets = Platform.WINDOWS.createTarget(["nsis"], ...(allArch ? [Arch.x64, Arch.arm64] : [hostArch]));
} else {
  targets = Platform.LINUX.createTarget(["AppImage"], ...(allArch ? [Arch.x64, Arch.arm64] : [hostArch]));
}
// Never upload: with a publish config, electron-builder would otherwise publish on its own when it sees CI or a git
// tag. The update feed (latest-mac.yml) is still written; the release assets are attached by hand.
const out = await build({ projectDir: appDir, config, publish: "never", ...(targets ? { targets } : { mac: [] }) });
console.log(`package: built\n  ${out.map((f) => path.relative(repo, f)).join("\n  ")}`);
console.log(`package: attach to the GitHub release\n  ${uploadAssets(output).join("\n  ")}`);
