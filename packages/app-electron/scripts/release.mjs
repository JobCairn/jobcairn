// Release helpers shared by scripts/package.mjs (SHA256SUMS.txt after the installers are built) and
// scripts/verify-release.mjs (checks a built app). Plain functions over files and command output, so tests can
// run them without a signing identity.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CHECKSUMS_FILE = "SHA256SUMS.txt";

/** The files users download: installers and archives, never electron-builder's .blockmap or metadata. */
export function isReleaseArtifact(file) {
  return /\.(dmg|zip|exe|AppImage)$/.test(file);
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** `shasum -a 256 -c` format: "<hex>  <name>", one per artifact, sorted by name. */
export function checksumLines(files) {
  return files
    .filter(isReleaseArtifact)
    .map((f) => ({ name: path.basename(f), hash: sha256File(f) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `${e.hash}  ${e.name}\n`)
    .join("");
}

/** electron-builder's mac update feed, read by the installed mac app's updater (src/updates.ts). */
export const UPDATE_FEED = "latest-mac.yml";
/** The Windows feed: both NSIS installers (x64 and arm64), read by the installed Windows app's updater. */
export const WIN_UPDATE_FEED = "latest.yml";

/**
 * Everything a GitHub release needs attached: the installers and zips, their .blockmap files (the updater's
 * smaller downloads), the update feeds (latest-mac.yml, latest.yml for Windows, latest-linux.yml) and
 * SHA256SUMS.txt. Names only, sorted.
 */
export function isUploadAsset(file) {
  const name = path.basename(file);
  return isReleaseArtifact(name) || name.endsWith(".blockmap") || /^latest(-[a-z0-9]+)*\.yml$/.test(name) || name === CHECKSUMS_FILE;
}
export function uploadAssets(dir) {
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile() && isUploadAsset(f)).sort();
}

/** The `files:` entries of an electron-builder update feed: url, sha512 (base64) and size. */
export function feedFiles(text) {
  const files = [];
  const block = /^files:\n((?:[ \t]+.*\n?)*)/m.exec(text)?.[1] ?? "";
  for (const item of block.split(/^\s*-\s+/m).slice(1)) {
    const field = (k) => new RegExp(`^\\s*${k}:\\s*['"]?([^'"\\n]*)['"]?\\s*$`, "m").exec(item)?.[1]?.trim();
    const url = field("url");
    if (url) files.push({ url, sha512: field("sha512") ?? "", size: Number(field("size") ?? NaN) });
  }
  return files;
}

/**
 * Problems with the update feed in `dir`: missing, nothing to update from listed, or an entry whose sha512 or size
 * differ from the file beside it.
 * - latest-mac.yml: the zips are checked. dmg entries aren't: stapling changes the dmg after the feed is written,
 *   and the mac updater only ever downloads the zip.
 * - latest.yml (Windows): every .exe is checked (electron-builder signs the installer before it hashes it), and
 *   each needs its .blockmap beside it (differential downloads). `archs` (e.g. ["x64", "arm64"]) must each appear
 *   in an installer's name: the updater picks the entry whose name contains the running app's process.arch, and
 *   falls back to the first one, which would hand one architecture the other's installer.
 */
export function feedProblems(dir, feed = UPDATE_FEED, { archs = [] } = {}) {
  const file = path.join(dir, feed);
  if (!fs.existsSync(file)) return [`${feed} is missing`];
  const ext = feed === WIN_UPDATE_FEED ? ".exe" : ".zip";
  const entries = feedFiles(fs.readFileSync(file, "utf8")).filter((f) => f.url.endsWith(ext));
  if (!entries.length) return [`${feed} lists no ${ext.slice(1)}`];
  const bad = [];
  for (const z of entries) {
    const p = path.join(dir, path.basename(z.url));
    if (!fs.existsSync(p)) { bad.push(`${z.url} is missing`); continue; }
    const sha = crypto.createHash("sha512").update(fs.readFileSync(p)).digest("base64");
    if (sha !== z.sha512 || fs.statSync(p).size !== z.size) bad.push(`${z.url} doesn't match ${feed}`);
    if (ext === ".exe" && !fs.existsSync(`${p}.blockmap`)) bad.push(`${z.url}.blockmap is missing`);
  }
  for (const a of archs) if (!entries.some((e) => e.url.includes(a))) bad.push(`${feed} has no ${a} installer`);
  return bad;
}

/**
 * SHA256SUMS.txt texts merged into one: one line per file name, sorted; a later text wins for the same name.
 * The mac and Windows builds each write their own, and the release carries one file for both.
 */
export function mergeChecksums(...texts) {
  const byName = new Map();
  for (const text of texts) {
    for (const line of String(text ?? "").split(/\r?\n/).filter(Boolean)) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (m) byName.set(m[2], m[1]);
    }
  }
  return [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => `${hash}  ${name}\n`).join("");
}

/** Writes SHA256SUMS.txt beside the artifacts (electron-builder's afterAllArtifactBuild). Returns its path, or null. */
export function writeChecksums(outDir, artifactPaths) {
  const text = checksumLines(artifactPaths);
  if (!text) return null;
  const file = path.join(outDir, CHECKSUMS_FILE);
  fs.writeFileSync(file, text);
  return file;
}

/** Lines of a SHA256SUMS.txt in `dir` that no longer match the file on disk (missing files count). */
export function checksumMismatches(dir) {
  const text = fs.readFileSync(path.join(dir, CHECKSUMS_FILE), "utf8");
  const bad = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    const file = m && path.join(dir, m[2]);
    if (!m || !fs.existsSync(file) || sha256File(file) !== m[1]) bad.push(line);
  }
  return bad;
}

/** Reads `codesign -dv --verbose=2` output (it prints to stderr): unsigned, adhoc, developer-id or other. */
export function signatureKind(codesignOutput) {
  if (/code object is not signed/i.test(codesignOutput)) return { kind: "unsigned" };
  if (/^Signature=adhoc$/m.test(codesignOutput)) return { kind: "adhoc" };
  const authority = /^Authority=(.+)$/m.exec(codesignOutput)?.[1] ?? null;
  const team = /^TeamIdentifier=(.+)$/m.exec(codesignOutput)?.[1] ?? null;
  const kind = authority?.startsWith("Developer ID Application:") ? "developer-id" : "other";
  return { kind, authority, team };
}

const MACHO_MAGIC = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"]);

/**
 * Mach-O files (executables, dylibs, .node modules) under Contents/ outside MacOS/ and Frameworks/, where
 * electron-builder signs them. Today none ship; if one ever does, list it in the mac `binaries` option so it is
 * signed with the hardened runtime, or notarisation rejects the app.
 */
export function strayMachO(appPath) {
  const contents = path.join(appPath, "Contents");
  const skip = new Set([path.join(contents, "MacOS"), path.join(contents, "Frameworks")]);
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(p)) walk(p); continue; }
      if (!e.isFile()) continue;
      const fd = fs.openSync(p, "r");
      const head = Buffer.alloc(4);
      const n = fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (n === 4 && MACHO_MAGIC.has(head.toString("hex"))) found.push(path.relative(appPath, p));
    }
  };
  walk(contents);
  return found.sort();
}

/**
 * notarytool's credential arguments for the group notarizeMode found ("keychain-profile", "api-key", "apple-id").
 * Used for the dmg; electron-builder notarises the app itself from the same variables.
 */
export function notarytoolAuthArgs(mode, env) {
  if (mode === "keychain-profile") return ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? ["--keychain", env.APPLE_KEYCHAIN] : [])];
  if (mode === "api-key") return ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
  if (mode === "apple-id") return ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
  throw new Error(`notarytool: no credentials (${mode})`);
}

/** Reads `notarytool submit --wait --output-format json`: the submission id and whether Apple accepted it. */
export function notaryResult(json) {
  const r = JSON.parse(json);
  return { id: r.id ?? null, accepted: r.status === "Accepted", status: r.status ?? "unknown" };
}
