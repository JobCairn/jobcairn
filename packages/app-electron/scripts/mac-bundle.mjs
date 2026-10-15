// Pure helpers for the macOS dev bundle (scripts/dev-app.mjs): Info.plist patching, the .icns container and
// the "is the copy current?" stamp. No Electron, no child processes: unit-tested in test/mac-bundle.test.ts.
import path from "node:path";

/** XML text escaping for a <string> value. */
export function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Sets top-level <string> keys in an XML Info.plist. An existing key's value is replaced in place; a missing key is
 * added at the end of the top-level dict. Only the first (top-level) occurrence of a key is touched, and only
 * when its value is a <string>; anything else is refused rather than guessed.
 */
export function patchPlistXml(xml, values) {
  let out = xml;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string") throw new Error(`plist: ${key} must be a string`);
    const keyTag = `<key>${xmlEscape(key)}</key>`;
    const at = out.indexOf(keyTag);
    if (at >= 0) {
      const after = out.slice(at + keyTag.length);
      const m = /^(\s*)<string>[^<]*<\/string>/.exec(after);
      if (!m) throw new Error(`plist: ${key} is not a string value`);
      out = out.slice(0, at + keyTag.length) + `${m[1]}<string>${xmlEscape(value)}</string>` + after.slice(m[0].length);
    } else {
      const end = out.lastIndexOf("</dict>");
      if (end < 0) throw new Error("plist: no top-level dict");
      out = `${out.slice(0, end)}\t${keyTag}\n\t<string>${xmlEscape(value)}</string>\n${out.slice(end)}`;
    }
  }
  return out;
}

/**
 * The line macOS shows when the app first asks Google Chrome (over Apple Events) to open its remote-control page.
 * Without NSAppleEventsUsageDescription macOS refuses the request without asking.
 */
export const appleEventsWhy = (name) => `${name} asks Google Chrome to open its remote-control page, so you can set up Search in my Chrome.`;

/** The Info.plist values that make the dev copy show the product's name and icon. Never touches CFBundleExecutable. */
export function devPlistValues(identity, iconFile) {
  return {
    CFBundleName: identity.shortName || identity.name,
    CFBundleDisplayName: identity.name,
    CFBundleIdentifier: `${identity.appId}.dev`,
    NSAppleEventsUsageDescription: appleEventsWhy(identity.name),
    CFBundleIconFile: iconFile,
  };
}

/** PNG renditions an .icns may hold, by pixel size (ic10 is 512@2x). */
const ICNS_TYPES = { 16: "icp4", 32: "icp5", 64: "icp6", 128: "ic07", 256: "ic08", 512: "ic09", 1024: "ic10" };

/** Builds an .icns from PNG files' bytes keyed by pixel size (modern macOS reads PNG renditions directly). */
export function icnsFromPngs(pngs) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const entries = Object.entries(pngs).map(([size, data]) => {
    const type = ICNS_TYPES[Number(size)];
    if (!type) throw new Error(`icns: unsupported size ${size}`);
    if (!Buffer.isBuffer(data) || !data.subarray(0, 4).equals(sig)) throw new Error(`icns: ${size} is not a PNG`);
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  if (!entries.length) throw new Error("icns: no images");
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** Where the dev copy lives: a gitignored folder in the package, named after the product. */
export function devBundlePath(pkgDir, identity) {
  const safe = identity.name.replace(/[/\\:]/g, "-").trim() || identity.internalId;
  return path.join(pkgDir, ".dev-app", `${safe}.app`);
}

/** What the copy was made from. A different stamp means: copy again. `v` goes up when devPlistValues changes. */
export function devStamp({ electronVersion, identity, iconHash }) {
  return JSON.stringify({ v: 2, electronVersion, name: identity.name, shortName: identity.shortName, appId: identity.appId, iconHash: iconHash ?? null });
}

export function needsRebuild(existingStamp, wanted) {
  return existingStamp !== wanted;
}
