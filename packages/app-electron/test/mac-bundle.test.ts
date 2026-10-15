import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { devBundlePath, devPlistValues, devStamp, icnsFromPngs, needsRebuild, patchPlistXml, xmlEscape } from "../scripts/mac-bundle.mjs";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Electron</string>
\t<key>CFBundleExecutable</key>
\t<string>Electron</string>
\t<key>CFBundleIdentifier</key>
\t<string>com.github.Electron</string>
\t<key>CFBundleName</key>
\t<string>Electron</string>
\t<key>ElectronAsarIntegrity</key>
\t<dict>
\t\t<key>CFBundleName</key>
\t\t<string>nested</string>
\t</dict>
\t<key>NSHighResolutionCapable</key>
\t<true/>
</dict>
</plist>
`;

const PNG = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)]);

describe("dev bundle Info.plist patch", () => {
  it("names the bundle after the product, with a dev bundle id and our icon, and leaves the executable alone", () => {
    const fictional = { internalId: "careeros", name: "Example Career App", shortName: "Example", appId: "com.example.app" };
    const out = patchPlistXml(PLIST, devPlistValues(fictional, "careeros.icns"));
    expect(out).toContain("<key>CFBundleName</key>\n\t<string>Example</string>");
    expect(out).toContain("<key>CFBundleDisplayName</key>\n\t<string>Example Career App</string>");
    expect(out).toContain("<key>CFBundleIdentifier</key>\n\t<string>com.example.app.dev</string>");
    expect(out).toContain("<key>CFBundleExecutable</key>\n\t<string>Electron</string>");
    // The dev app asks Chrome over Apple Events too, so it carries the same prompt line as the release build.
    expect(out).toMatch(/<key>NSAppleEventsUsageDescription<\/key>\n\t<string>[^<]*Google Chrome[^<]*<\/string>/);
    // A missing key is added inside the top-level dict, not after it.
    expect(out).toMatch(/<key>CFBundleIconFile<\/key>\n\t<string>careeros.icns<\/string>\n<\/dict>\n<\/plist>/);
    // Only the top-level key changes: the same key name nested further down is untouched.
    expect(out).toContain("<string>nested</string>");
  });

  it("uses the product name from the identity source", () => {
    const v = devPlistValues(identity, "x.icns");
    expect(v.CFBundleDisplayName).toBe(identity.name);
    expect(v.CFBundleName).toBe(identity.shortName);
    expect(v.CFBundleIdentifier).toBe(`${identity.appId}.dev`);
    expect(Object.keys(v)).not.toContain("CFBundleExecutable");
  });

  it("escapes XML in values and refuses non-string targets", () => {
    expect(xmlEscape(`A & B <"x">`)).toBe("A &amp; B &lt;&quot;x&quot;&gt;");
    expect(patchPlistXml(PLIST, { CFBundleName: "Acme & Co" })).toContain("<string>Acme &amp; Co</string>");
    expect(() => patchPlistXml(PLIST, { NSHighResolutionCapable: "no" })).toThrow(/not a string/);
    expect(() => patchPlistXml("<plist/>", { CFBundleName: "x" })).toThrow(/no top-level dict/);
  });

  it("patches the real Electron.app Info.plist when it is installed", () => {
    let file: string;
    try {
      const bin = createRequire(import.meta.url)("electron") as string;
      file = path.resolve(bin, "..", "..", "Info.plist");
    } catch { return; }
    if (process.platform !== "darwin" || !fs.existsSync(file)) return;
    const out = patchPlistXml(fs.readFileSync(file, "utf8"), devPlistValues(identity, "careeros.icns"));
    expect(out).toContain(`<key>CFBundleDisplayName</key>\n\t<string>${identity.name}</string>`);
    expect(out.match(/<key>CFBundleName<\/key>/g)).toHaveLength(1);
  });
});

describe("icns", () => {
  it("wraps PNG renditions with the right type codes and lengths", () => {
    const a = PNG(10), b = PNG(20);
    const icns = icnsFromPngs({ 512: a, 1024: b });
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(icns.subarray(8, 12).toString("ascii")).toBe("ic09");
    expect(icns.readUInt32BE(12)).toBe(a.length + 8);
    const second = 8 + a.length + 8;
    expect(icns.subarray(second, second + 4).toString("ascii")).toBe("ic10");
    expect(icns.readUInt32BE(second + 4)).toBe(b.length + 8);
  });

  it("refuses non-PNG data, unknown sizes and empty input", () => {
    expect(() => icnsFromPngs({ 512: Buffer.from("not a png") })).toThrow(/not a PNG/);
    expect(() => icnsFromPngs({ 300: PNG(1) })).toThrow(/unsupported size/);
    expect(() => icnsFromPngs({})).toThrow(/no images/);
  });
});

describe("dev bundle location and freshness", () => {
  it("lives in a gitignored folder in the package, named after the product", () => {
    expect(devBundlePath("/fictional/pkg", identity)).toBe(path.join("/fictional/pkg", ".dev-app", `${identity.name}.app`));
    expect(devBundlePath("/p", { ...identity, name: "A/B" })).toBe(path.join("/p", ".dev-app", "A-B.app"));
    const ignore = fs.readFileSync(path.resolve(import.meta.dirname, "../../../.gitignore"), "utf8");
    expect(ignore).toContain("packages/app-electron/.dev-app/");
  });

  it("is made again only when Electron, the identity or the icon changes", () => {
    const base = devStamp({ electronVersion: "44.7.0", identity, iconHash: "abc" });
    expect(needsRebuild(null, base)).toBe(true);
    expect(needsRebuild(base, devStamp({ electronVersion: "44.7.0", identity, iconHash: "abc" }))).toBe(false);
    expect(needsRebuild(base, devStamp({ electronVersion: "44.8.0", identity, iconHash: "abc" }))).toBe(true);
    expect(needsRebuild(base, devStamp({ electronVersion: "44.7.0", identity: { ...identity, name: "Renamed" }, iconHash: "abc" }))).toBe(true);
    expect(needsRebuild(base, devStamp({ electronVersion: "44.7.0", identity, iconHash: "def" }))).toBe(true);
    // Copies made before the Apple Events line was added are made again.
    expect(JSON.parse(base).v).toBe(2);
  });
});
