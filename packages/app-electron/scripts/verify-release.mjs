#!/usr/bin/env node
// Checks the mac apps in dist-release (or the .app paths given) the way a user's Mac will:
//   node scripts/verify-release.mjs [--require-signed] [App.app ...]
// Every build: SHA256SUMS.txt matches the installers, latest-mac.yml matches the zips (in-app updates), every package the bundles load at run time imports in the
// app's own Electron, no unsigned Mach-O hides in Resources, and `codesign --verify --deep --strict` passes. Developer ID builds also need `spctl -a -vv` (Gatekeeper) and
// `xcrun stapler validate` (notarisation ticket stapled), for each app and each dmg in dist-release. Ad-hoc builds
// skip those with a note, unless --require-signed is given (use it for a public release). Needs the Xcode Command
// Line Tools.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import asar from "@electron/asar";
import { runtimeRequires } from "./builder-config.mjs";
import { CHECKSUMS_FILE, checksumMismatches, feedProblems, signatureKind, strayMachO, UPDATE_FEED, uploadAssets } from "./release.mjs";

const pkg = path.resolve(import.meta.dirname, "..");
const out = path.join(pkg, "dist-release");
const args = process.argv.slice(2);
const requireSigned = args.includes("--require-signed");

if (process.platform !== "darwin") { console.error("verify: needs macOS (codesign, spctl, stapler)."); process.exit(1); }

const run = (cmd, a, opts = {}) => {
  const r = spawnSync(cmd, a, { encoding: "utf8", ...opts });
  return { ok: r.status === 0, text: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || String(r.error ?? "") };
};

let apps = args.filter((a) => !a.startsWith("--")).map((a) => path.resolve(a));
if (!apps.length && fs.existsSync(out)) {
  // electron-builder names the folders mac-arm64 and mac (x64).
  apps = fs.readdirSync(out).filter((d) => /^mac(-|$)/.test(d)).flatMap((d) =>
    fs.readdirSync(path.join(out, d)).filter((f) => f.endsWith(".app")).map((f) => path.join(out, d, f)));
}
if (!apps.length) { console.error(`verify: no .app found in ${path.relative(process.cwd(), out)}. Run npm run package:mac first.`); process.exit(1); }

let failed = false;
const fail = (msg) => { failed = true; console.log(`  FAIL ${msg}`); };
const pass = (msg) => console.log(`  ok   ${msg}`);
const skip = (msg) => console.log(`  skip ${msg}`);

const sumsDir = path.dirname(path.dirname(apps[0]));
if (fs.existsSync(path.join(sumsDir, CHECKSUMS_FILE))) {
  const bad = checksumMismatches(sumsDir);
  console.log(CHECKSUMS_FILE);
  if (bad.length) fail(`${bad.length} line(s) don't match: ${bad.map((l) => l.slice(66)).join(", ")}`);
  else pass("every installer matches");
} else if (!args.some((a) => !a.startsWith("--"))) {
  console.log(CHECKSUMS_FILE); fail(`missing in ${path.relative(process.cwd(), sumsDir)}`);
}
// In-app updates read latest-mac.yml from the release: it must list each zip with the zip's own sha512 and size.
if (!args.some((a) => !a.startsWith("--"))) {
  console.log(UPDATE_FEED);
  const bad = feedProblems(sumsDir);
  if (bad.length) fail(bad.join("; "));
  else pass("every zip matches the update feed");
}

for (const app of apps) {
  console.log(path.relative(process.cwd(), app));
  // The packages the bundles in app.asar still load, imported by the app's own Electron (as Node) from Resources,
  // where Node's lookup from app.asar/dist lands. A missing one crashes the app at launch.
  const res = path.join(app, "Contents", "Resources");
  const archive = path.join(res, "app.asar");
  const bundles = asar.listPackage(archive).map((f) => f.replace(/^[\\/]/, "")).filter((f) => /^dist[\\/][^\\/]+\.(c|m)?js$/.test(f));
  const wanted = [...new Set(bundles.flatMap((f) => runtimeRequires(asar.extractFile(archive, f).toString("utf8"))))].sort();
  const exe = path.join(app, "Contents", "MacOS", path.basename(app, ".app"));
  const probe = `for (const n of ${JSON.stringify(wanted)}) { try { await import(n); } catch (e) { console.log(n + ": " + e.code); process.exitCode = 1; } }`;
  const loaded = run(exe, ["--input-type=module", "-e", probe], { cwd: res, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  if (!wanted.length) fail("no run-time packages found in app.asar/dist (expected the mail libraries)");
  else if (loaded.ok) pass(`run-time packages import: ${wanted.join(", ")}`);
  else fail(`run-time packages missing from Resources/node_modules: ${loaded.text}`);

  const stray = strayMachO(app);
  if (stray.length) fail(`unsigned binaries outside MacOS/ and Frameworks/ (add them to mac.binaries): ${stray.join(", ")}`);
  else pass("no binaries outside MacOS/ and Frameworks/");

  const sig = signatureKind(run("codesign", ["-dv", "--verbose=2", app]).text);
  if (sig.kind === "unsigned") { fail("not signed at all"); continue; }
  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  if (verify.ok) pass(`codesign --verify --deep --strict (${sig.kind === "adhoc" ? "ad hoc" : sig.authority})`);
  else fail(`codesign --verify: ${verify.text}`);

  if (sig.kind !== "developer-id") {
    const why = sig.kind === "adhoc" ? "ad-hoc build: no Developer ID identity was set" : `signed by ${sig.authority}, not a Developer ID`;
    if (requireSigned) fail(`${why} (--require-signed)`);
    else skip(`spctl and stapler: ${why}`);
    continue;
  }
  const gk = run("spctl", ["-a", "-vv", "-t", "exec", app]);
  if (gk.ok && /source=Notarized Developer ID/.test(gk.text)) pass("spctl: accepted, notarised Developer ID");
  else fail(`spctl: ${gk.text}`);
  const staple = run("xcrun", ["stapler", "validate", app]);
  if (staple.ok) pass("stapler: ticket stapled");
  else fail(`stapler validate: ${staple.text}`);
}

// The dmgs users download: signed with the same identity, notarised and stapled by scripts/package.mjs.
const dmgs = args.some((a) => !a.startsWith("--")) || !fs.existsSync(out) ? [] : fs.readdirSync(out).filter((f) => f.endsWith(".dmg")).map((f) => path.join(out, f));
for (const dmg of dmgs) {
  console.log(path.relative(process.cwd(), dmg));
  const sig = signatureKind(run("codesign", ["-dv", "--verbose=2", dmg]).text);
  if (sig.kind !== "developer-id") {
    const why = sig.kind === "unsigned" ? "unsigned dmg (ad-hoc build)" : `dmg signed by ${sig.authority ?? "ad hoc"}, not a Developer ID`;
    if (requireSigned) fail(`${why} (--require-signed)`);
    else skip(`spctl and stapler: ${why}`);
    continue;
  }
  const gk = run("spctl", ["-a", "-vv", "-t", "open", "--context", "context:primary-signature", dmg]);
  if (gk.ok && /source=Notarized Developer ID/.test(gk.text)) pass("spctl: accepted, notarised Developer ID");
  else fail(`spctl: ${gk.text}`);
  const staple = run("xcrun", ["stapler", "validate", dmg]);
  if (staple.ok) pass("stapler: ticket stapled");
  else fail(`stapler validate: ${staple.text}`);
}

if (!failed && fs.existsSync(out) && !args.some((a) => !a.startsWith("--"))) {
  console.log(`\nAttach these to the GitHub release:\n  ${uploadAssets(out).join("\n  ")}`);
}
process.exit(failed ? 1 : 0);
