#!/usr/bin/env node
// Starts the built app in development (npm run start / dev). On macOS the Dock and app switcher show the running
// bundle's CFBundleName, which for node_modules' stock Electron.app is "Electron". So on macOS this keeps a copy of
// Electron.app named after the product (.dev-app/<name>.app, gitignored), with the product name, a dev bundle id
// and our app icon in its Info.plist, and launches that. The copy is remade only when the Electron version, the
// identity or the icon changes. Other systems launch Electron as before.
// Extra arguments are passed to the app (after the app folder). --prepare-only makes the copy without launching it.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { devBundlePath, devPlistValues, devStamp, icnsFromPngs, needsRebuild, patchPlistXml } from "./mac-bundle.mjs";

const pkg = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(pkg, "../..");
const require = createRequire(path.join(pkg, "package.json"));
const identity = JSON.parse(fs.readFileSync(path.join(repo, "packages/brand/identity.json"), "utf8"));
/** node_modules' Electron binary (…/Electron.app/Contents/MacOS/Electron on macOS). */
const electronBin = require("electron");
const electronVersion = JSON.parse(fs.readFileSync(require.resolve("electron/package.json"), "utf8")).version;

const ICON_PNGS = { 512: path.join(repo, "packages/brand/assets/app-icon-512.png"), 1024: path.join(repo, "packages/brand/assets/app-icon-1024.png") };
const ICON_FILE = `${identity.internalId}.icns`;

function iconPngs() {
  if (!Object.values(ICON_PNGS).every((f) => fs.existsSync(f))) return null;
  return Object.fromEntries(Object.entries(ICON_PNGS).map(([size, f]) => [size, fs.readFileSync(f)]));
}

/** Makes (or reuses) the product-named copy of Electron.app; returns its executable. */
function ensureDevBundle() {
  const source = path.resolve(electronBin, "..", "..", "..");
  const target = devBundlePath(pkg, identity);
  const stampFile = `${target}.stamp`;
  const pngs = iconPngs();
  const iconHash = pngs ? crypto.createHash("sha256").update(Buffer.concat(Object.values(pngs))).digest("hex").slice(0, 16) : null;
  const wanted = devStamp({ electronVersion, identity, iconHash });
  const have = fs.existsSync(stampFile) && fs.existsSync(target) ? fs.readFileSync(stampFile, "utf8") : null;
  const exe = path.join(target, "Contents", "MacOS", path.basename(electronBin));
  if (!needsRebuild(have, wanted)) return exe;

  console.log(`dev-app: preparing ${path.relative(pkg, target)} (Electron ${electronVersion})`);
  fs.rmSync(path.dirname(target), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // ditto keeps the framework symlinks, permissions and extended attributes exactly.
  execFileSync("ditto", [source, target]);
  const res = path.join(target, "Contents", "Resources");
  let iconFile = "electron.icns";
  if (pngs) {
    fs.writeFileSync(path.join(res, ICON_FILE), icnsFromPngs(pngs));
    iconFile = ICON_FILE;
  } else {
    console.warn("dev-app: no rendered app icon yet (packages/brand/assets/app-icon-*.png); keeping Electron's icon.");
  }
  const plist = path.join(target, "Contents", "Info.plist");
  fs.writeFileSync(plist, patchPlistXml(fs.readFileSync(plist, "utf8"), devPlistValues(identity, iconFile)));
  execFileSync("plutil", ["-lint", "-s", plist]);
  // Editing Info.plist breaks Electron's ad-hoc signature; re-sign ad hoc so macOS still runs it (nothing secret).
  try { execFileSync("codesign", ["--force", "--deep", "--sign", "-", target], { stdio: "ignore" }); } catch {
    console.warn("dev-app: couldn't re-sign the dev copy ad hoc; trying to run it anyway.");
  }
  // Ask Launch Services to re-read the bundle so the Dock shows the new name and icon (best effort).
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  try { execFileSync(lsregister, ["-f", target], { stdio: "ignore" }); } catch { /* not fatal */ }
  fs.writeFileSync(stampFile, wanted);
  return exe;
}

const prepareOnly = process.argv.includes("--prepare-only");
const bin = process.platform === "darwin" ? ensureDevBundle() : electronBin;
if (prepareOnly) { console.log(`dev-app: ready ${path.relative(pkg, bin)}`); process.exit(0); }
const child = spawn(bin, [pkg, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { if (!child.killed) child.kill(sig); });
child.on("close", (code, signal) => { process.exit(code ?? (signal ? 1 : 0)); });
child.on("error", (e) => { console.error(`dev-app: couldn't start Electron (${e.message})`); process.exit(1); });
