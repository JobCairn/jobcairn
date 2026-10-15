// The product name lives in packages/brand/identity.json only. This fails when source under packages/*/src
// hard-codes it (the current name or a former one), so a rename stays a one-line edit. Internal ids
// (careeros CLI and plugin, .careeros/, careeros-file:, @careeros/*, CAREEROS_* env vars) are lower or
// upper case and never match. Comment lines are allowed. See docs/rebrand.md.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import identityJson from "../packages/brand/identity.json" with { type: "json" };
import { identity, PRODUCT_NAME } from "../packages/brand/identity";

const ROOT = path.resolve(import.meta.dirname, "..");
/** The names no source line may spell out: the current display name and every former one. On a rename,
 * add the old name here so stragglers still fail (docs/rebrand.md). */
const FORMER_NAMES = ["CareerOS"];
const NAMES = [...new Set([identity.name, identity.shortName, ...FORMER_NAMES])];
const SCAN = [
  ...fs.readdirSync(path.join(ROOT, "packages")).map((p) => `packages/${p}/src`),
  "packages/app-ui/index.html", "packages/brand/guide", "packages/core/schemas",
];
// Lines that may mention a name: code comments, the fictional sample path, a test-only fake.
const ALLOW: RegExp[] = [
  /^\s*(\/\/|\*|\/\*|<!--)/,
  /\/fictional\/alex-example\/CareerOS/,
  /services\/src\/fakes\.ts: .*test printer/,
  // Internal id kept on purpose: the Windows scheduled task's name (renaming orphans existing tasks).
  /^packages\/mail\/src\/scheduler\/text\.ts: export const TASK_NAME = "CareerOS Mail Sync";/,
];

function files(p: string): string[] {
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [abs];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(p, e.name)) : /\.(tsx?|cts|mts|html|json)$/.test(e.name) ? [path.join(abs, e.name)] : []));
}

/** "file:line: text" when the line names the product outside a comment or an allow-listed line, else null. */
export function hardCodedName(file: string, line: string): string | null {
  if (!NAMES.some((n) => line.includes(n))) return null;
  if (ALLOW.some((re) => re.test(line) || re.test(`${file}: ${line}`))) return null;
  return line.trim();
}

export function hardCodedNames(): string[] {
  return SCAN.flatMap(files).flatMap((f) => {
    const rel = path.relative(ROOT, f);
    return fs.readFileSync(f, "utf8").split("\n").flatMap((line, i) => {
      const hit = hardCodedName(rel, line);
      return hit === null ? [] : [`${rel}:${i + 1}: ${hit}`];
    });
  });
}

describe("product identity", () => {
  it("has a name, short name, tagline and app id", () => {
    expect(identity).toEqual(identityJson);
    expect(PRODUCT_NAME).toBe(identity.name);
    for (const v of Object.values(identity)) expect(String(v).trim()).not.toBe("");
    expect(identity.appId).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
    expect(identity.domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });
  it("keeps the fixed internal id that keys userData and the Keychain entry", () => {
    // Never change this value: it would orphan every saved secret and setting.
    expect(identity.internalId).toBe("careeros");
  });
  it("never shows internal project codes such as \"3b\" in UI copy", () => {
    const codes = files("packages/app-ui/src").flatMap((f) => fs.readFileSync(f, "utf8").split("\n").flatMap((line, i) =>
      !ALLOW[0]!.test(line) && /["'`>][^"'`<]*\b(?:in|coming|plan|sub-project) \d[a-z]\b/i.test(line) ? [`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`] : []));
    expect(codes).toEqual([]);
  });
  it("flags the current or a former name in strings, not in comments or internal ids", () => {
    expect(hardCodedName("packages/x/src/a.ts", `  title: "${identity.name} settings",`)).not.toBeNull();
    expect(hardCodedName("packages/x/src/a.ts", `  throw new Error("${identity.shortName} could not save");`)).not.toBeNull();
    expect(hardCodedName("packages/x/src/a.ts", `  // ${identity.name} keeps one process`)).toBeNull();
    expect(hardCodedName("packages/x/src/a.ts", '  const dir = path.join(home, ".careeros");')).toBeNull();
    expect(hardCodedName("packages/x/src/a.ts", '  import x from "@careeros/brand/identity.json";')).toBeNull();
  });
  it("isn't hard-coded in source under packages/*/src", () => {
    const scanned = SCAN.flatMap((p) => (fs.existsSync(path.join(ROOT, p)) ? [p] : []));
    expect(scanned.length).toBeGreaterThan(8);
    expect(hardCodedNames()).toEqual([]);
  });
});
