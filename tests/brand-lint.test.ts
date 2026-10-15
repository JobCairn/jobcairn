// Brand lint: catches raw colours and raw fonts in renderer code and in brand component
// sources, so all visual values flow through packages/brand tokens.
//
// This file exports `findViolations` (used below by the meta-test, and reusable by other
// lint-style tests); it is not test-only private code.
//
// The "renderer code uses brand tokens only" check below scans packages/app-ui/src, which
// landed in Task 15. It asserts the directory exists and that at least one file is actually
// scanned, so this guard can never silently go back to vacuous (zero files -> zero
// violations -> trivially green) if the package is ever moved or emptied.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
type Rule = [RegExp, string];
const HEX: Rule = [/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/, "hex colour"];
const COLOUR_FN: Rule = [/\b(?:rgba?|hsla?)\(/, "raw colour function"];
const RENDERER_RULES: Rule[] = [
  HEX, COLOUR_FN,
  [/font-family\s*:/, "font-family literal"], [/fontFamily/, "fontFamily literal"],
  [/font-size\s*:\s*[\d.]+px/, "px font size"], [/fontSize\s*:\s*["']?\d/, "numeric fontSize"],
];
// Brand component sources may set font-family, but only through token variables.
//
// The trailing \S (not in the brief's original regex) matters: with a bare
// `(?!var\()` the preceding `\s*` can backtrack to zero width, so the lookahead gets
// checked *before* the space in e.g. "font-family: var(...)" and sees "var(" doesn't
// start right there — a false positive on the exact token form this rule must allow.
// Requiring a non-whitespace character pins the check to where the value actually
// starts. Verified: `font-family: var(--font-family-sans);` -> no violation;
// `font-family: Geist;` / `font-family:Geist` -> violation; `font-family:var(--x)` -> none.
const BRAND_RULES: Rule[] = [HEX, COLOUR_FN, [/font-family\s*:\s*(?!var\()\S/, "font-family without a token"]];

export function findViolations(text: string, rules: Rule[]): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const [re, what] of rules) if (re.test(line)) out.push(`line ${i + 1}: ${what}: ${line.trim()}`);
  });
  return out;
}

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(tsx?|css|html)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("brand lint", () => {
  it("catches the patterns it is meant to catch", () => {
    expect(findViolations("color: #fff;", RENDERER_RULES)).toHaveLength(1);
    expect(findViolations("background: rgba(0,0,0,.3)", RENDERER_RULES)).toHaveLength(1);
    expect(findViolations("font-family: Geist", RENDERER_RULES)).toHaveLength(1);
    expect(findViolations("style={{ fontSize: 14 }}", RENDERER_RULES)).toHaveLength(1);
    expect(findViolations('href="#/jobs" color: var(--color-text)', RENDERER_RULES)).toEqual([]);
    expect(findViolations("font-family: var(--font-family-sans);", BRAND_RULES)).toEqual([]);
  });
  it("renderer code uses brand tokens only", () => {
    const srcDir = path.join(ROOT, "packages/app-ui/src");
    // Guards against the check going vacuous again: packages/app-ui/src must exist and
    // actually contribute files to scan, not just an empty or missing directory.
    expect(fs.existsSync(srcDir)).toBe(true);
    const scanned = [...files(srcDir), path.join(ROOT, "packages/app-ui/index.html")].filter((f) => fs.existsSync(f));
    expect(scanned.length).toBeGreaterThan(0);
    const bad = scanned.flatMap((f) => findViolations(fs.readFileSync(f, "utf8"), RENDERER_RULES).map((v) => `${path.relative(ROOT, f)} ${v}`))
      // Mermaid's config needs its font keys by name; Diagram.tsx fills them from the app's font tokens (ui/learn-visual).
      .filter((v) => !(v.startsWith("packages/app-ui/src/components/Diagram.tsx ") && /font(?:Family|Size) literal/.test(v) && v.includes("// brand-lint: mermaid-config")));
    expect(bad).toEqual([]);
  });
  it("numbers, dates and counts never render in monospace", () => {
    // The regular UI face with tabular figures everywhere; the mono token only remains for
    // Resume Studio's user-chosen heading font, which lives in services, not in these styles.
    const scanned = [...files(path.join(ROOT, "packages/brand/src")), ...files(path.join(ROOT, "packages/app-ui/src"))];
    const bad = scanned.flatMap((f) => findViolations(fs.readFileSync(f, "utf8"), [[/font-family-mono|font(?:-family)?\s*:[^;]*monospace/, "monospace font"]])
      .map((v) => `${path.relative(ROOT, f)} ${v}`));
    expect(bad).toEqual([]);
    const typography = fs.readFileSync(path.join(ROOT, "packages/brand/src/styles/typography.css"), "utf8");
    expect(typography).toMatch(/\.t-numeric \{ font-family: var\(--font-family-sans\); font-variant-numeric: lining-nums tabular-nums; \}/);
  });
  it("brand components consume tokens, not raw colours", () => {
    const bad = [...files(path.join(ROOT, "packages/brand/src")), ...files(path.join(ROOT, "packages/brand/guide"))]
      .flatMap((f) => findViolations(fs.readFileSync(f, "utf8"), BRAND_RULES).map((v) => `${path.relative(ROOT, f)} ${v}`));
    expect(bad).toEqual([]);
  });
});
