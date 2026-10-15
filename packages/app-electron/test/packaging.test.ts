import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { ASAR_UNPACK, builderConfig, FONT_PACKAGES, MAC_ENTITLEMENTS, notarizeMode, PUBLISH, RESOURCES, RUNTIME_MODULES_DIR, runtimeRequires } from "../scripts/builder-config.mjs";
import { bundledPluginDir, electronClaudeHost, pluginRootEnv } from "../src/claude-host.js";
import { guidesDir } from "../src/guide-media.js";
import { sampleDirFor } from "../src/onboarding-host.js";
import { setupComponentsDir, setupRunnerDir } from "../src/setup-host.js";
import { licensesDir } from "../src/licenses.js";

const PKG = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(PKG, "../..");
// What the main process sees: dist/ in the package during development, app.asar/dist inside the installed app.
const DEV = { packaged: false, resourcesPath: "/fictional/Electron.app/Contents/Resources", here: path.join(PKG, "dist") };
const RES = "/Applications/Fictional.app/Contents/Resources";
const PACKED = { packaged: true, resourcesPath: RES, here: path.join(RES, "app.asar", "dist") };

const lookups = {
  plugin: bundledPluginDir,
  guides: guidesDir,
  example: sampleDirFor,
  setupRunner: setupRunnerDir,
  setupComponents: setupComponentsDir,
  licenses: licensesDir,
} satisfies Record<keyof typeof RESOURCES, (o: typeof DEV) => string>;

describe("resource paths, development vs packaged", () => {
  for (const [key, find] of Object.entries(lookups) as [keyof typeof RESOURCES, (o: typeof DEV) => string][]) {
    it(`${key}: the packaged lookup matches what electron-builder ships, and the dev lookup is the folder it ships from`, () => {
      expect(find(PACKED)).toBe(path.join(RES, RESOURCES[key].to));
      expect(find(DEV)).toBe(path.resolve(PKG, RESOURCES[key].from));
      expect(fs.existsSync(find(DEV))).toBe(true);
    });
  }

  it("ships the Supertonic model licence, Attachment A included, with the other licences", () => {
    const text = fs.readFileSync(path.join(licensesDir(DEV), "OpenRAIL-M-Supertonic3.txt"), "utf8");
    expect(text).toContain("https://huggingface.co/Supertone/supertonic-3");
    expect(text).toContain("Open RAIL-M License");
    expect(text).toContain("Attachment A");
    expect(licensesDir(PACKED)).toBe(path.join(RES, "licenses"));
  });

  it("ships the example the onboarding expects (resources/careeros-example)", () => {
    expect(RESOURCES.example.to).toBe("careeros-example");
    expect(sampleDirFor(PACKED)).toBe(path.join(RES, "careeros-example"));
    expect(fs.existsSync(path.join(REPO, "samples/alex-example"))).toBe(true);
  });

  it("ships every guide video file the tours offer (docs/assets/marketing/guides -> resources/guides)", () => {
    // The file names each journey plays (app-ui tour/journeys.ts), read as text so this package needn't load the UI.
    const journeys = fs.readFileSync(path.join(REPO, "packages/app-ui/src/tour/journeys.ts"), "utf8");
    const names = [...journeys.matchAll(/(?:poster|video|captions): "([a-z0-9-]+\.(?:mp4|vtt|webp))"/g)].map((m) => m[1]!);
    expect(names).toHaveLength(12);
    const from = path.resolve(PKG, RESOURCES.guides.from);
    expect(from).toBe(path.join(REPO, "docs/assets/marketing/guides"));
    expect(RESOURCES.guides.to).toBe("guides");
    for (const n of names) expect(fs.statSync(path.join(from, n)).size, n).toBeGreaterThan(0);
    const cfg = builderConfig({ identity, electronVersion: "0.0.0", env: {}, pkgDir: PKG, appDir: ".", output: "/fictional/out" });
    expect(cfg.extraResources).toContainEqual(expect.objectContaining({ from, to: "guides" }));
  });

  it("runs the MCP server from the unpacked copy of dist/mcp.mjs when packaged", () => {
    const host = electronClaudeHost({ ...PACKED, execPath: "/fictional/bin" });
    expect(host.pluginDir).toBe(path.join(RES, "careeros-plugin"));
    expect(host.mcp.args).toEqual([path.join(RES, "app.asar.unpacked", "dist", "mcp.mjs")]);
    expect(ASAR_UNPACK).toContain("dist/mcp.mjs");
    // mcp.mjs reads ../schemas, so they must be unpacked next to it.
    expect(ASAR_UNPACK).toContain("schemas/**");
    const dev = electronClaudeHost({ ...DEV, execPath: "/fictional/bin" });
    expect(dev.pluginDir).toBe(path.join(REPO, "plugin"));
    expect(dev.mcp.args).toEqual([path.join(PKG, "dist", "mcp.mjs")]);
  });

  it("points the narrator lookup at the bundled plugin only when packaged and not already set", () => {
    expect(pluginRootEnv({}, PACKED)).toBe(path.join(RES, "careeros-plugin"));
    expect(pluginRootEnv({ CAREEROS_PLUGIN_ROOT: "/fictional/own" }, PACKED)).toBeNull();
    expect(pluginRootEnv({}, DEV)).toBeNull();
  });
});

describe("electron-builder config", () => {
  const cfg = builderConfig({ identity, electronVersion: "44.7.0", env: {} });

  it("takes the name and bundle id from the identity source", () => {
    expect(cfg.productName).toBe(identity.name);
    expect(cfg.appId).toBe(identity.appId);
    expect(cfg.linux.executableName).toBe(identity.internalId);
    expect(cfg.dmg.title).toBe(identity.name);
  });

  it("ships every runtime resource, never a sample's index or secrets", () => {
    expect(cfg.extraResources.map((r: { to: string }) => r.to).sort()).toEqual(["careeros-example", "careeros-plugin", "careeros-setup", "careeros-setup/components", "guides", "licenses"]);
    for (const r of cfg.extraResources) expect(r.filter).toEqual(expect.arrayContaining(["!**/.index/**", "!**/settings/.env"]));
    expect(cfg.asar).toBe(true);
    expect(cfg.files).toContain("!dist/**/*.map");
  });

  it("targets mac dmg + zip for both architectures, Windows NSIS and Linux AppImage", () => {
    expect(cfg.mac.target).toEqual([{ target: "dmg", arch: ["arm64", "x64"] }, { target: "zip", arch: ["arm64", "x64"] }]);
    expect(cfg.win.target[0].target).toBe("nsis");
    expect(cfg.linux.target[0].target).toBe("AppImage");
  });

  it("points in-app updates at the public GitHub releases, and the package script never uploads", () => {
    expect(cfg.publish).toEqual({ provider: "github", owner: "JobCairn", repo: "jobcairn" });
    expect(PUBLISH).toBe(cfg.publish);
    // electron-builder publishes on its own under CI or a git tag unless told not to.
    const script = fs.readFileSync(path.join(PKG, "scripts/package.mjs"), "utf8");
    const calls = [...script.matchAll(/await build\(\{([^)]*)\}\)/g)].map((m) => m[1]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('publish: "never"');
  });

  it("is unsigned (ad hoc) and not notarised unless the environment provides credentials", () => {
    expect(cfg.mac.identity).toBe("-");
    expect(cfg.mac.notarize).toBe(false);
    expect(cfg.mac.hardenedRuntime).toBe(false);
    expect(cfg.mac.entitlements).toBeUndefined();
    const signed = builderConfig({ identity, electronVersion: "44.7.0", env: {
      CAREEROS_MAC_IDENTITY: "Developer ID Application: Example Labs", APPLE_TEAM_ID: "EXAMPLE123", APPLE_ID: "alex" + "@" + "example.com", APPLE_APP_SPECIFIC_PASSWORD: "fictional",
    } });
    // electron-builder refuses the "Developer ID Application:" prefix, so the Keychain name is trimmed.
    expect(signed.mac.identity).toBe("Example Labs");
    expect(signed.mac.hardenedRuntime).toBe(true);
    expect(signed.mac.notarize).toBe(true);
    expect(signed.mac.entitlements).toBe(path.resolve(MAC_ENTITLEMENTS));
    expect(signed.mac.entitlementsInherit).toBe(signed.mac.entitlements);
    // Opening Chrome's remote-control page asks Chrome over Apple Events: macOS shows this line in its prompt, and
    // the hardened runtime blocks Apple Events without the entitlement.
    expect(cfg.mac.extendInfo.NSAppleEventsUsageDescription).toMatch(/Google Chrome/);
    expect(signed.mac.extendInfo).toEqual(cfg.mac.extendInfo);
    expect(signed.dmg.sign).toBe(true);
    expect(cfg.dmg.sign).toBe(false);
    // A certificate file or name lets electron-builder pick the identity itself; still a real signature.
    expect(builderConfig({ identity, electronVersion: "44.7.0", env: { CSC_NAME: "Developer ID Application: Example Labs (EXAMPLE123)" } }).mac.identity).toBe("Example Labs (EXAMPLE123)");
    for (const env of [{ CSC_LINK: "/fictional/cert.p12" }, { CSC_NAME: "Example Labs" }]) {
      const c = builderConfig({ identity, electronVersion: "44.7.0", env });
      expect(c.mac.identity).toBe(env.CSC_LINK ? undefined : "Example Labs");
      expect(c.mac.hardenedRuntime).toBe(true);
      expect(c.mac.notarize).toBe(false);
    }
  });

  it("never notarises an ad-hoc build, even with Apple credentials in the environment", () => {
    const env = { APPLE_API_KEY: "/fictional/AuthKey.p8", APPLE_API_KEY_ID: "EXAMPLEKEY", APPLE_API_ISSUER: "fictional-issuer" };
    const c = builderConfig({ identity, electronVersion: "44.7.0", env });
    expect(c.mac.identity).toBe("-");
    expect(c.mac.notarize).toBe(false);
    // A half-set group doesn't break the unsigned build either.
    expect(builderConfig({ identity, electronVersion: "44.7.0", env: { APPLE_ID: "fictional" } }).mac.notarize).toBe(false);
  });

  it("reads notarytool credentials in electron-builder's order, and refuses a half-set group when signing", () => {
    expect(notarizeMode({})).toBeNull();
    expect(notarizeMode({ APPLE_API_KEY: "/fictional/AuthKey.p8", APPLE_API_KEY_ID: "EXAMPLEKEY", APPLE_API_ISSUER: "fictional-issuer" })).toBe("api-key");
    expect(notarizeMode({ APPLE_ID: "alex" + "@" + "example.com", APPLE_APP_SPECIFIC_PASSWORD: "fictional", APPLE_TEAM_ID: "EXAMPLE123" })).toBe("apple-id");
    expect(notarizeMode({ APPLE_KEYCHAIN_PROFILE: "jobcairn-notary" })).toBe("keychain-profile");
    expect(() => notarizeMode({ APPLE_ID: "alex" + "@" + "example.com", APPLE_APP_SPECIFIC_PASSWORD: "fictional" })).toThrow(/APPLE_TEAM_ID/);
    expect(() => notarizeMode({ APPLE_API_KEY: "/fictional/AuthKey.p8" })).toThrow(/APPLE_API_KEY_ID, APPLE_API_ISSUER/);
    const id = { CAREEROS_MAC_IDENTITY: "Developer ID Application: Example Labs" };
    expect(builderConfig({ identity, electronVersion: "44.7.0", env: { ...id, APPLE_KEYCHAIN_PROFILE: "jobcairn-notary" } }).mac.notarize).toBe(true);
    expect(() => builderConfig({ identity, electronVersion: "44.7.0", env: { ...id, APPLE_API_KEY_ID: "EXAMPLEKEY" } })).toThrow(/APPLE_API_KEY/);
  });

  it("asks the hardened runtime for JIT and Apple Events only: no library-validation bypass, no devices", () => {
    const plist = fs.readFileSync(path.join(PKG, MAC_ENTITLEMENTS), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    // Apple Events: Search in my Chrome asks Google Chrome to open its remote-control page.
    expect(keys).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.automation.apple-events"]);
    expect(plist).toMatch(/<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\/>/);
  });
});

describe("run-time modules shipped beside app.asar", () => {
  it("finds the bare packages a bundle still require()s, ignoring built-ins, electron and relative paths", () => {
    const code = `const A = require2("ajv/dist/2020"); const f = require2("ajv-formats"); require3("node:sqlite");
      require("electron"); require("fs"); require("./local.js"); require("@scope/pkg/deep/file.js");`;
    expect(runtimeRequires(code)).toEqual(["@scope/pkg", "ajv", "ajv-formats"]);
    expect(runtimeRequires("export const x = 1;")).toEqual([]);
  });

  it("finds the packages an ESM bundle imports, which a packaged app can't load otherwise", () => {
    const code = `import sanitizeHtml from "sanitize-html";\nimport { ImapFlow } from "imapflow";\nimport nodemailer from "nodemailer";
import {
  simpleParser
} from "mailparser";
import "side-effect-pkg";
export { x } from "@scope/re-export/sub";
import { join } from "node:path";
import fs from "fs";
import { app } from "electron";
import { local } from "./local.js";
const lazy = await import("lazy-pkg");
const t = \`import x from "\${name}"\`;
const s = "not an import from \\"words\\"";`;
    expect(runtimeRequires(code)).toEqual(["@scope/re-export", "imapflow", "lazy-pkg", "mailparser", "nodemailer", "sanitize-html", "side-effect-pkg"]);
  });

  it("finds every build external in the built main bundle", () => {
    const build = fs.readFileSync(path.join(PKG, "scripts/build.mjs"), "utf8");
    const externals = JSON.parse(build.match(/const MAIL_LIBS = (\[[^\]]*\])/)![1].replaceAll("'", '"')) as string[];
    expect(externals.length).toBeGreaterThan(0);
    const main = path.join(PKG, "dist/main.js");
    if (!fs.existsSync(main)) return;
    const found = runtimeRequires(fs.readFileSync(main, "utf8"));
    for (const lib of externals) expect(found).toContain(lib);
  });

  it("ships every font package the PDF export reads by path", () => {
    const fonts = fs.readFileSync(path.join(REPO, "packages/services/src/print/fonts.ts"), "utf8");
    const used = new Set([...fonts.matchAll(/@fontsource\/[a-z0-9-]+/g)].map((m) => m[0]));
    expect(used.size).toBeGreaterThan(0);
    for (const p of used) expect(FONT_PACKAGES).toContain(p);
  });

  it("puts them in Resources/node_modules, where Node's lookup from app.asar and app.asar.unpacked both reach", () => {
    const cfg = builderConfig({ identity, electronVersion: "44.7.0", runtimeModules: "/fictional/stage/node_modules" });
    expect(cfg.extraResources).toContainEqual(expect.objectContaining({ from: "/fictional/stage/node_modules", to: RUNTIME_MODULES_DIR }));
    expect(RUNTIME_MODULES_DIR).toBe("node_modules");
    for (const from of [path.join(RES, "app.asar", "dist"), path.join(RES, "app.asar.unpacked", "dist")]) {
      const lookups: string[] = [];
      for (let d = from; path.dirname(d) !== d; d = path.dirname(d)) lookups.push(path.join(d, "node_modules"));
      expect(lookups).toContain(path.join(RES, RUNTIME_MODULES_DIR));
    }
  });
});
