import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  CHECKSUMS_FILE, checksumLines, checksumMismatches, feedFiles, feedProblems, isReleaseArtifact, notaryResult, notarytoolAuthArgs, signatureKind, strayMachO, UPDATE_FEED,
  uploadAssets, writeChecksums,
} from "../scripts/release.mjs";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-test-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (rel: string, data: string | Buffer) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
};

describe("SHA256SUMS.txt", () => {
  it("lists installers and archives only, sorted, in shasum -c format", () => {
    const files = [put("Example-0.1.0-x64.dmg", "x64"), put("Example-0.1.0-arm64.dmg", "arm"), put("Example-0.1.0-arm64.dmg.blockmap", "b"), put("Example-0.1.0-arm64-mac.zip", "z"), put("latest-mac.yml", "y")];
    expect(files.filter(isReleaseArtifact).map((f) => path.basename(f))).toEqual(["Example-0.1.0-x64.dmg", "Example-0.1.0-arm64.dmg", "Example-0.1.0-arm64-mac.zip"]);
    const file = writeChecksums(dir, files)!;
    expect(path.basename(file)).toBe(CHECKSUMS_FILE);
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines.map((l) => l.slice(66))).toEqual(["Example-0.1.0-arm64-mac.zip", "Example-0.1.0-arm64.dmg", "Example-0.1.0-x64.dmg"]);
    // sha256("arm")
    expect(lines[1]).toBe("ddf7ff5ebd9d66ce161466c1c0262430fa04de32b0e420ee3f489e2e2112e386  Example-0.1.0-arm64.dmg");
    expect(execFileSync("shasum", ["-a", "256", "-c", CHECKSUMS_FILE], { cwd: dir, encoding: "utf8" })).toContain("Example-0.1.0-x64.dmg: OK");
    expect(checksumMismatches(dir)).toEqual([]);
  });

  it("reports a changed or missing installer", () => {
    const dmg = put("Example-0.1.0-arm64.dmg", "arm");
    writeChecksums(dir, [dmg, put("Example-0.1.0-x64.dmg", "x64")]);
    fs.writeFileSync(dmg, "tampered");
    fs.rmSync(path.join(dir, "Example-0.1.0-x64.dmg"));
    expect(checksumMismatches(dir).map((l) => l.slice(66))).toEqual(["Example-0.1.0-arm64.dmg", "Example-0.1.0-x64.dmg"]);
  });

  it("writes nothing when there is no installer", () => {
    expect(writeChecksums(dir, [put("a.blockmap", "b")])).toBeNull();
    expect(checksumLines([])).toBe("");
  });
});

describe("release assets for in-app updates", () => {
  const sha512 = (s: string) => crypto.createHash("sha512").update(s).digest("base64");
  // The shape electron-builder writes (zip first, then the dmg; quoted date).
  const feed = (zip: { name: string; data: string }[], dmgSha = "stale") => [
    "version: 0.1.2", "files:",
    ...zip.flatMap((z) => [`  - url: ${z.name}`, `    sha512: ${sha512(z.data)}`, `    size: ${Buffer.byteLength(z.data)}`]),
    "  - url: Example-0.1.2-arm64.dmg", `    sha512: ${dmgSha}`, "    size: 3",
    `path: ${zip[0]?.name ?? ""}`, `sha512: ${zip[0] ? sha512(zip[0].data) : ""}`, "releaseDate: '2026-10-15T00:00:00.000Z'", "",
  ].join("\n");

  it("lists what to attach: installers, zips, blockmaps, the update feed and the checksums, nothing else", () => {
    for (const f of ["Example-0.1.2-arm64.dmg", "Example-0.1.2-arm64.dmg.blockmap", "Example-0.1.2-arm64-mac.zip", "Example-0.1.2-arm64-mac.zip.blockmap",
      "Example-0.1.2-mac.zip", "Example-0.1.2-mac.zip.blockmap", UPDATE_FEED, CHECKSUMS_FILE, "builder-debug.yml", "builder-effective-config.yaml"]) put(f, "x");
    put("mac-arm64/Example.app/Contents/Info.plist", "x");
    expect(uploadAssets(dir)).toEqual([
      "Example-0.1.2-arm64-mac.zip", "Example-0.1.2-arm64-mac.zip.blockmap", "Example-0.1.2-arm64.dmg", "Example-0.1.2-arm64.dmg.blockmap",
      "Example-0.1.2-mac.zip", "Example-0.1.2-mac.zip.blockmap", "SHA256SUMS.txt", "latest-mac.yml",
    ]);
  });

  it("reads the feed's file entries", () => {
    const zips = [{ name: "Example-0.1.2-arm64-mac.zip", data: "arm" }, { name: "Example-0.1.2-mac.zip", data: "x64" }];
    expect(feedFiles(feed(zips))).toEqual([
      { url: "Example-0.1.2-arm64-mac.zip", sha512: sha512("arm"), size: 3 },
      { url: "Example-0.1.2-mac.zip", sha512: sha512("x64"), size: 3 },
      { url: "Example-0.1.2-arm64.dmg", sha512: "stale", size: 3 },
    ]);
  });

  it("checks every zip against the feed, and ignores the dmg entries (stapling changes the dmg afterwards)", () => {
    const zips = [{ name: "Example-0.1.2-arm64-mac.zip", data: "arm" }, { name: "Example-0.1.2-mac.zip", data: "x64" }];
    for (const z of zips) put(z.name, z.data);
    put("Example-0.1.2-arm64.dmg", "dmg");
    put(UPDATE_FEED, feed(zips));
    expect(feedProblems(dir)).toEqual([]);
    put("Example-0.1.2-mac.zip", "changed");
    fs.rmSync(path.join(dir, "Example-0.1.2-arm64-mac.zip"));
    expect(feedProblems(dir)).toEqual(["Example-0.1.2-arm64-mac.zip is missing", "Example-0.1.2-mac.zip doesn't match latest-mac.yml"]);
  });

  it("reports a missing feed, or one with no zip", () => {
    expect(feedProblems(dir)).toEqual(["latest-mac.yml is missing"]);
    put(UPDATE_FEED, feed([]));
    expect(feedProblems(dir)).toEqual(["latest-mac.yml lists no zip"]);
  });
});

describe("codesign -dv output", () => {
  it("tells ad hoc, Developer ID, other and unsigned apart", () => {
    expect(signatureKind("Executable=/x/Example.app/Contents/MacOS/Example\nSignature=adhoc\nTeamIdentifier=not set\n").kind).toBe("adhoc");
    expect(signatureKind("Authority=Developer ID Application: Example Labs (EXAMPLE123)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=EXAMPLE123\n"))
      .toEqual({ kind: "developer-id", authority: "Developer ID Application: Example Labs (EXAMPLE123)", team: "EXAMPLE123" });
    expect(signatureKind("Authority=Apple Development: Example Labs (EXAMPLE123)\n").kind).toBe("other");
    expect(signatureKind("/x/Example.app: code object is not signed at all").kind).toBe("unsigned");
  });
});

describe("binaries outside MacOS/ and Frameworks/", () => {
  it("finds Mach-O files in Resources but not the ones electron-builder signs, nor scripts", () => {
    const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
    put("Example.app/Contents/MacOS/Example", macho);
    put("Example.app/Contents/Frameworks/Example Helper.app/Contents/MacOS/Example Helper", macho);
    put("Example.app/Contents/Resources/careeros-plugin/skills/voice/scripts/narrate.py", "#!/usr/bin/env python3\n");
    put("Example.app/Contents/Resources/app.asar.unpacked/dist/mcp.mjs", "export {};\n");
    put("Example.app/Contents/Resources/node_modules/native/build/Release/addon.node", macho);
    put("Example.app/Contents/Resources/empty", "");
    expect(strayMachO(path.join(dir, "Example.app"))).toEqual(["Contents/Resources/node_modules/native/build/Release/addon.node"]);
  });
});

describe("notarytool for the dmg", () => {
  it("passes the same credentials electron-builder uses for the app", () => {
    expect(notarytoolAuthArgs("keychain-profile", { APPLE_KEYCHAIN_PROFILE: "jobcairn-notary" })).toEqual(["--keychain-profile", "jobcairn-notary"]);
    expect(notarytoolAuthArgs("api-key", { APPLE_API_KEY: "/fictional/AuthKey.p8", APPLE_API_KEY_ID: "EXAMPLEKEY", APPLE_API_ISSUER: "fictional-issuer" }))
      .toEqual(["--key", "/fictional/AuthKey.p8", "--key-id", "EXAMPLEKEY", "--issuer", "fictional-issuer"]);
  });

  it("reads the submission result", () => {
    expect(notaryResult(`{"id":"0000-fictional","status":"Accepted","message":"Processing complete"}`)).toEqual({ id: "0000-fictional", accepted: true, status: "Accepted" });
    expect(notaryResult(`{"id":"0000-fictional","status":"Invalid"}`).accepted).toBe(false);
  });
});
