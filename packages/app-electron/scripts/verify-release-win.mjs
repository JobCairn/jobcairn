// The Windows half of scripts/verify-release.mjs (it imports this on Windows; the mac checks are unchanged):
//   node scripts/verify-release.mjs [--require-signed]
// Checks dist-release the way a user's PC and the installed app's updater will: SHA256SUMS.txt matches the
// installers; latest.yml lists an installer per architecture built, each matching its file and with its .blockmap;
// every package the bundles load at run time imports in the app's own Electron (this machine's architecture only);
// and `signtool verify /pa` accepts each installer and app exe. signtool comes with the Windows SDK and often isn't
// installed: without it the signature check is skipped with a note (or fails, with --require-signed).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import asar from "@electron/asar";
import { runtimeRequires } from "./builder-config.mjs";
import { CHECKSUMS_FILE, checksumMismatches, feedProblems, uploadAssets, WIN_UPDATE_FEED } from "./release.mjs";

const pkg = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(pkg, "../..");
const out = path.join(pkg, "dist-release");
const requireSigned = process.argv.includes("--require-signed");
const identity = JSON.parse(fs.readFileSync(path.join(repo, "packages/brand/identity.json"), "utf8"));

const run = (cmd, a, opts = {}) => {
  const r = spawnSync(cmd, a, { encoding: "utf8", ...opts });
  return { ok: r.status === 0, text: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || String(r.error ?? "") };
};
let failed = false;
const fail = (msg) => { failed = true; console.log(`  FAIL ${msg}`); };
const pass = (msg) => console.log(`  ok   ${msg}`);
const skip = (msg) => console.log(`  skip ${msg}`);

if (!fs.existsSync(out)) { console.error("verify: no dist-release folder. Run npm run package:win:all first."); process.exit(1); }
// electron-builder names the unpacked apps win-unpacked (x64) and win-arm64-unpacked.
const unpacked = { x64: path.join(out, "win-unpacked"), arm64: path.join(out, "win-arm64-unpacked") };
const archs = Object.entries(unpacked).filter(([, d]) => fs.existsSync(d)).map(([a]) => a);
if (!archs.length) { console.error("verify: no win-unpacked folder in dist-release. Run npm run package:win:all first."); process.exit(1); }

console.log(CHECKSUMS_FILE);
if (!fs.existsSync(path.join(out, CHECKSUMS_FILE))) fail("missing");
else {
  const bad = checksumMismatches(out);
  if (bad.length) fail(`${bad.length} line(s) don't match: ${bad.map((l) => l.slice(66)).join(", ")}`);
  else pass("every installer matches");
}

// In-app updates read latest.yml: one installer per architecture, matching the files, with their blockmaps.
console.log(WIN_UPDATE_FEED);
const feedBad = feedProblems(out, WIN_UPDATE_FEED, { archs });
if (feedBad.length) fail(feedBad.join("; "));
else pass(`every installer matches the update feed (${archs.join(", ")})`);

// The packages the bundles in app.asar still load, imported by the app's own Electron (as Node) from resources/.
// Only this machine's architecture can run.
for (const arch of archs) {
  const dir = unpacked[arch];
  console.log(path.relative(process.cwd(), dir));
  if (arch !== process.arch) { skip(`run-time packages: a ${arch} build can't run on this ${process.arch} machine`); continue; }
  const res = path.join(dir, "resources");
  const archive = path.join(res, "app.asar");
  const bundles = asar.listPackage(archive).map((f) => f.replace(/^[\\/]/, "")).filter((f) => /^dist[\\/][^\\/]+\.(c|m)?js$/.test(f));
  const wanted = [...new Set(bundles.flatMap((f) => runtimeRequires(asar.extractFile(archive, f).toString("utf8"))))].sort();
  const exe = path.join(dir, `${identity.name}.exe`);
  const probe = `for (const n of ${JSON.stringify(wanted)}) { try { await import(n); } catch (e) { console.log(n + ": " + e.code); process.exitCode = 1; } }`;
  const loaded = run(exe, ["--input-type=module", "-e", probe], { cwd: res, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  if (!wanted.length) fail("no run-time packages found in app.asar/dist (expected the mail libraries)");
  else if (loaded.ok) pass(`run-time packages import: ${wanted.join(", ")}`);
  else fail(`run-time packages missing from resources/node_modules: ${loaded.text}`);
}

/** signtool.exe on PATH, or the newest one in the Windows 10/11 SDK; null when the SDK isn't installed. */
function findSigntool() {
  const where = run("where", ["signtool"]);
  if (where.ok) return where.text.split(/\r?\n/)[0].trim();
  const kits = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  if (!fs.existsSync(kits)) return null;
  const hostDir = process.arch === "arm64" ? "arm64" : "x64";
  const found = fs.readdirSync(kits).filter((v) => /^\d+\./.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((v) => path.join(kits, v, hostDir, "signtool.exe")).find((f) => fs.existsSync(f));
  return found ?? null;
}

const signed = [
  ...fs.readdirSync(out).filter((f) => f.endsWith(".exe")).map((f) => path.join(out, f)),
  ...archs.map((a) => path.join(unpacked[a], `${identity.name}.exe`)),
];
console.log("signatures");
const signtool = findSigntool();
if (!signtool) {
  const why = "signtool.exe not found (it comes with the Windows SDK); signatures not checked";
  if (requireSigned) fail(`${why} (--require-signed)`);
  else skip(why);
} else {
  for (const f of signed) {
    const name = path.relative(out, f);
    const v = run(signtool, ["verify", "/pa", f]);
    if (v.ok) pass(`signtool verify /pa: ${name}`);
    else if (/No signature found/i.test(v.text) && !requireSigned) skip(`${name}: unsigned build (no Azure Trusted Signing or WIN_CSC_LINK was set)`);
    else fail(`signtool verify /pa ${name}: ${v.text.split(/\r?\n/).filter(Boolean).slice(-3).join(" ")}`);
  }
}

if (!failed) console.log(`\nAttach these to the GitHub release:\n  ${uploadAssets(out).join("\n  ")}`);
process.exit(failed ? 1 : 0);
