import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "../../..");
const PKG = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
const OK = new Set(["MIT", "MIT-0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "(MIT OR EUPL-1.1+)"]);

/** node_modules lookup the way Node does it: the nearest node_modules folder above `from` that has the package. */
function findPackage(name: string, from: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const f = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(f)) return f;
    if (dir === path.dirname(dir)) return null;
  }
}

interface PackageJson {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Walks `names` (required, from `startFrom`) and every `dependencies` entry transitively, plus
 * `optionalDependencies` and `peerDependencies` when they're actually installed (missing optional
 * or peer packages are not an error; a missing regular dependency is).
 */
function walkLicences(names: readonly string[], startFrom: string): { seen: Map<string, string>; bad: string[] } {
  const seen = new Map<string, string>();
  const bad: string[] = [];
  const visit = (name: string, from: string, required: boolean) => {
    const f = findPackage(name, from);
    if (!f) {
      if (required) bad.push(`${name}: not installed`);
      return;
    }
    if (seen.has(f)) return;
    const p = JSON.parse(fs.readFileSync(f, "utf8")) as PackageJson;
    seen.set(f, `${p.name}@${p.version}`);
    if (!OK.has(String(p.license))) bad.push(`${p.name}@${p.version}: ${String(p.license)}`);
    for (const d of Object.keys(p.dependencies ?? {})) visit(d, path.dirname(f), true);
    for (const d of Object.keys(p.optionalDependencies ?? {})) visit(d, path.dirname(f), false);
    for (const d of Object.keys(p.peerDependencies ?? {})) visit(d, path.dirname(f), false);
  };
  for (const name of names) visit(name, startFrom, true);
  return { seen, bad };
}

describe("mail dependencies", () => {
  it("are pinned exactly", () => {
    for (const [name, v] of Object.entries(PKG.dependencies)) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("use only licences we can ship, all the way down", () => {
    const names = Object.keys(PKG.dependencies).filter((n) => !n.startsWith("@careeros/"));
    const { seen, bad } = walkLicences(names, path.join(REPO, "packages", "mail"));
    expect(bad).toEqual([]);
    expect(seen.size).toBeGreaterThan(4);
  });
});

describe("licence walk: optionalDependencies and peerDependencies", () => {
  it("catches a disallowed licence behind an optional or peer dependency", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "careeros-licence-fixture-"));
    try {
      const nm = path.join(tmp, "node_modules");
      for (const id of ["pkg-a", "pkg-b", "pkg-c"]) fs.mkdirSync(path.join(nm, id), { recursive: true });
      fs.writeFileSync(
        path.join(nm, "pkg-a", "package.json"),
        JSON.stringify({
          name: "pkg-a",
          version: "1.0.0",
          license: "MIT",
          optionalDependencies: { "pkg-b": "1.0.0" },
          peerDependencies: { "pkg-c": "1.0.0" },
        }),
      );
      fs.writeFileSync(path.join(nm, "pkg-b", "package.json"), JSON.stringify({ name: "pkg-b", version: "1.0.0", license: "GPL-3.0" }));
      fs.writeFileSync(path.join(nm, "pkg-c", "package.json"), JSON.stringify({ name: "pkg-c", version: "1.0.0", license: "MIT" }));

      const { seen, bad } = walkLicences(["pkg-a"], path.join(nm, "pkg-a"));
      expect(bad).toEqual(["pkg-b@1.0.0: GPL-3.0"]);
      expect([...seen.values()]).toEqual(expect.arrayContaining(["pkg-a@1.0.0", "pkg-b@1.0.0", "pkg-c@1.0.0"]));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not fail when an optional or peer dependency is simply absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "careeros-licence-fixture-absent-"));
    try {
      const nm = path.join(tmp, "node_modules");
      fs.mkdirSync(path.join(nm, "pkg-d"), { recursive: true });
      fs.writeFileSync(
        path.join(nm, "pkg-d", "package.json"),
        JSON.stringify({
          name: "pkg-d",
          version: "1.0.0",
          license: "MIT",
          optionalDependencies: { "pkg-missing": "1.0.0" },
          peerDependencies: { "pkg-also-missing": "1.0.0" },
        }),
      );
      const { bad } = walkLicences(["pkg-d"], path.join(nm, "pkg-d"));
      expect(bad).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
