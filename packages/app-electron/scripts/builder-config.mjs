// electron-builder configuration for the installers (scripts/package.mjs). Plain data from inputs, so tests can
// check it against the runtime's resource lookups (sampleDirFor, guidesDir, electronClaudeHost).
//
import path from "node:path";
import { appleEventsWhy } from "./mac-bundle.mjs";

// Signing and notarisation are off unless their environment variables are set (see docs/packaging.md):
//   CAREEROS_MAC_IDENTITY or CSC_NAME  a "Developer ID Application: …" certificate name in the keychain, or
//                          CSC_LINK + CSC_KEY_PASSWORD (a .p12, read by electron-builder). Unset: ad-hoc signed only.
//   Notarisation (signed builds only; read by electron-builder through notarytool), one of:
//     APPLE_API_KEY (.p8 path) + APPLE_API_KEY_ID + APPLE_API_ISSUER   App Store Connect API key
//     APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID          Apple ID
//     APPLE_KEYCHAIN_PROFILE (+ APPLE_KEYCHAIN)                       `xcrun notarytool store-credentials` profile
//   WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD: sign the Windows installer (read by electron-builder).

/**
 * What ships next to the app in Contents/Resources (resources/ on Windows and Linux). `to` names are what the
 * main process looks up under process.resourcesPath; `from` is relative to packages/app-electron.
 */
export const RESOURCES = {
  plugin: { from: "../../plugin", to: "careeros-plugin" },
  // Guide videos are made with scripts/marketing and kept with the other docs assets (binaries are allowed there).
  guides: { from: "../../docs/assets/marketing/guides", to: "guides" },
  example: { from: "../../samples/alex-example", to: "careeros-example" },
  // The setup runner and its components, so the app can install tools after the person agrees (setup-host.ts).
  setupRunner: { from: "../../scripts/setup", to: "careeros-setup" },
  setupComponents: { from: "../../setup/components", to: "careeros-setup/components" },
  // Third-party licence texts (fonts, GSAP, the Supertonic model's OpenRAIL-M with its use restrictions).
  licenses: { from: "../../licenses", to: "licenses" },
};

/** Never shipped from a resource folder: OS litter, caches, and a sample's index, backups or secrets. */
const RESOURCE_EXCLUDES = ["!**/.DS_Store", "!**/__pycache__/**", "!**/.index/**", "!**/.backup/**", "!**/settings/.env"];

/**
 * Packages the bundles still load at run time. esbuild can't inline a require() made through createRequire
 * (core loads ajv that way), the mail libraries are build externals the ESM bundles import, and the PDF export
 * reads font files by package path. They ship as
 * Resources/node_modules: Node's lookup from app.asar/dist/main.js and from app.asar.unpacked/dist/mcp.mjs both
 * walk up to it. The require list is read from the built bundles (runtimeRequires); font packages are listed here.
 */
export const FONT_PACKAGES = ["@fontsource/geist", "@fontsource/geist-mono", "@fontsource/instrument-serif", "@fontsource/source-serif-4"];
export const RUNTIME_MODULES_DIR = "node_modules";

/**
 * Bare package names a bundle still loads at run time (not node: built-ins or electron): require() calls, and in
 * the ESM bundles the static `import ... from "x"` / `export ... from "x"` / `import "x"` lines and `import("x")`
 * that esbuild leaves for its externals (the mail libraries).
 */
export function runtimeRequires(code) {
  const names = new Set();
  const patterns = [
    /\brequire\d*\(\s*["']([^"'./][^"']*)["']\s*\)/g,
    /^\s*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"'./][^"']*)["']/gm,
    /^\s*import\s*["']([^"'./][^"']*)["']/gm,
    /\bimport\(\s*["']([^"'./][^"']*)["']\s*\)/g,
  ];
  for (const m of patterns.flatMap((re) => [...code.matchAll(re)])) {
    const spec = m[1];
    if (!PACKAGE_NAME.test(spec) || spec.startsWith("node:") || spec === "electron" || BUILTINS.has(spec.split("/")[0])) continue;
    names.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
  }
  return [...names].sort();
}
// A real package specifier, not a string that only looks like one (a template literal such as "${name}").
const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.@/-]*)?$/i;
const BUILTINS = new Set(["assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https", "module", "net", "os", "path", "process", "stream", "string_decoder", "timers", "tty", "url", "util", "worker_threads", "zlib"]);

/**
 * Files that must be real files on disk, outside app.asar: dist/mcp.mjs is run by Electron-as-Node for Claude Code
 * (claude-host maps app.asar -> app.asar.unpacked), and it reads ../schemas, so the schemas come out too.
 */
export const ASAR_UNPACK = ["dist/mcp.mjs", "dist/mcp.mjs.map", "schemas/**"];

/**
 * `pkgDir` (packages/app-electron) anchors the resource folders; `runtimeModules` is the staged node_modules folder; `appDir` and `output` are relative to the
 * project folder electron-builder runs in (scripts/package.mjs uses the staged app itself, so no workspace
 * node_modules are ever collected).
 */
/**
 * Where in-app updates come from (electron-updater, src/updates.ts). electron-builder writes it into the app as
 * Resources/app-update.yml and writes latest-mac.yml (the zips' versions and sha512) beside the installers. It never
 * uploads: scripts/package.mjs builds with `publish: "never"`, and the release assets are attached by hand
 * (docs/packaging.md).
 */
export const PUBLISH = { provider: "github", owner: "JobCairn", repo: "jobcairn" };

/** Hardened-runtime entitlements for the signed mac build (app and helpers), relative to packages/app-electron. */
export const MAC_ENTITLEMENTS = "signing/entitlements.mac.plist";

/**
 * Which notarytool credentials the environment holds, checked in electron-builder's own order
 * (MacTargetHelper.getNotarizeOptions): "apple-id", "api-key", "keychain-profile", or null for none.
 * A half-set group throws, so a release build never quietly skips notarisation.
 */
export function notarizeMode(env = {}) {
  const missing = (keys) => keys.filter((k) => !env[k]);
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) {
    const m = missing(["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]);
    if (m.length) throw new Error(`notarise with an Apple ID: also set ${m.join(", ")}`);
    return "apple-id";
  }
  if (env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER) {
    const m = missing(["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]);
    if (m.length) throw new Error(`notarise with an API key: also set ${m.join(", ")}`);
    return "api-key";
  }
  return env.APPLE_KEYCHAIN_PROFILE ? "keychain-profile" : null;
}

export function builderConfig({ identity, electronVersion, env = {}, pkgDir = ".", appDir = ".", output = "dist-release", icons, runtimeModules }) {
  // electron-builder wants the certificate name without its "Developer ID Application:" prefix (it adds the type
  // itself and refuses the full name), so the name as Keychain shows it is trimmed here. CSC_NAME goes the same way.
  const named = env.CAREEROS_MAC_IDENTITY || env.CSC_NAME;
  const macIdentity = named ? named.replace(/^Developer ID Application:\s*/, "") : env.CSC_LINK ? undefined : "-";
  // Ad hoc ("-") stays as before: no hardened runtime (it would need disable-library-validation to launch), no
  // entitlements, no notarisation. A real identity turns all three on.
  const signed = macIdentity !== "-";
  const notarize = signed && notarizeMode(env) !== null;
  const entitlements = path.resolve(pkgDir, MAC_ENTITLEMENTS);
  return {
    appId: identity.appId,
    productName: identity.name,
    electronVersion,
    copyright: `© ${identity.name}`,
    directories: { app: appDir, output, buildResources: "build-resources" },
    files: ["dist/**/*", "schemas/**/*", "package.json", "!dist/**/*.map"],
    asar: true,
    asarUnpack: ASAR_UNPACK,
    // Everything is bundled by esbuild into dist/: there are no node_modules or native modules to rebuild.
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    extraResources: [
      ...Object.values(RESOURCES).map((r) => ({ from: path.resolve(pkgDir, r.from), to: r.to, filter: ["**/*", ...RESOURCE_EXCLUDES] })),
      ...(runtimeModules ? [{ from: runtimeModules, to: RUNTIME_MODULES_DIR, filter: ["**/*", "!**/*.map", "!**/*.ts", "!**/*.md"] }] : []),
    ],
    mac: {
      category: "public.app-category.productivity",
      icon: icons?.icns,
      target: [{ target: "dmg", arch: ["arm64", "x64"] }, { target: "zip", arch: ["arm64", "x64"] }],
      identity: macIdentity,
      hardenedRuntime: signed,
      gatekeeperAssess: false,
      ...(signed ? { entitlements, entitlementsInherit: entitlements } : {}),
      notarize,
      darkModeSupport: true,
      // Search in my Chrome opens Chrome's remote-control page over Apple Events; macOS shows this when it asks.
      extendInfo: { NSAppleEventsUsageDescription: appleEventsWhy(identity.name) },
      minimumSystemVersion: "13.0",
    },
    // A signed build signs the dmg too; package.mjs then notarises and staples it (afterAllArtifactBuild), so
    // Gatekeeper accepts the download itself, not only the app inside.
    dmg: { title: identity.name, artifactName: "${productName}-${version}-${arch}.${ext}", sign: signed },
    win: { icon: icons?.png, target: [{ target: "nsis", arch: ["x64", "arm64"] }] },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, artifactName: "${productName}-Setup-${version}-${arch}.${ext}" },
    // Linux binaries are lower-case by convention; the fixed internal id keeps the name stable across renames.
    linux: { executableName: identity.internalId, icon: icons?.png, category: "Office", target: [{ target: "AppImage", arch: ["x64", "arm64"] }], synopsis: identity.tagline },
    appImage: { artifactName: "${productName}-${version}-${arch}.${ext}" },
    publish: PUBLISH,
  };
}
