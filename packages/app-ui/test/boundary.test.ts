import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../src");
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));

const FORBIDDEN = (spec: string) =>
  spec.startsWith("node:") || spec === "electron" || spec.startsWith("electron/") || spec === "@careeros/core" || spec === "@careeros/services" || /^(fs|path|os|child_process)$/.test(spec);

/**
 * Finds import/export/require specifiers the renderer must never touch. Covers four shapes:
 *  - `import ... from "spec"` (default/named/namespace), but NOT `import type ... from "spec"`
 *    since a type-only import is erased at build time and never runs in the renderer.
 *  - `export ... from "spec"` (`export * from`, `export { x } from`, `export * as ns from`),
 *    but NOT `export type ... from "spec"` for the same reason — a re-export forwards the
 *    forbidden module's exports just as surely as an import would, so it needs the same check.
 *  - `import("spec")` / `require("spec")` (dynamic import, CJS require).
 *  - bare side-effect imports: `import "spec";` (no binding, no `from`).
 */
function findForbiddenImports(text: string): string[] {
  const hits = new Set<string>();
  // [^;]* (not [\s\S]*): import/export clauses never contain a `;`, so bounding the lazy
  // match to "no semicolon" stops it from skipping past the end of one statement (e.g. an
  // unrelated `import type X = Y;`) and swallowing the `from "spec"` of the next, real
  // statement — which would hide that next statement's forbidden spec from this match
  // (and from `!m[1]`, since the swallowed statement's own "type"-ness is what gets tested).
  for (const m of text.matchAll(/import\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/g)) {
    if (!m[1]) {
      const spec = m[2]!;
      if (FORBIDDEN(spec)) hits.add(spec);
    }
  }
  for (const m of text.matchAll(/export\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/g)) {
    if (!m[1]) {
      const spec = m[2]!;
      if (FORBIDDEN(spec)) hits.add(spec);
    }
  }
  for (const m of text.matchAll(/(?:import\s*\(\s*|require\(\s*)["']([^"']+)["']/g)) {
    const spec = m[1]!;
    if (FORBIDDEN(spec)) hits.add(spec);
  }
  for (const m of text.matchAll(/import\s*["']([^"']+)["']/g)) {
    const spec = m[1]!;
    if (FORBIDDEN(spec)) hits.add(spec);
  }
  return [...hits];
}

describe("findForbiddenImports (matcher unit tests)", () => {
  it("flags bare side-effect imports of forbidden modules", () => {
    expect(findForbiddenImports('import "electron";')).toEqual(["electron"]);
    expect(findForbiddenImports("import 'node:fs';")).toEqual(["node:fs"]);
  });

  it("flags default, named and namespace imports from forbidden modules", () => {
    expect(findForbiddenImports('import fs from "node:fs";')).toEqual(["node:fs"]);
    expect(findForbiddenImports('import { readFileSync } from "node:fs";')).toEqual(["node:fs"]);
    expect(findForbiddenImports('import * as electron from "electron";')).toEqual(["electron"]);
    expect(findForbiddenImports('import { foo } from "@careeros/core";')).toEqual(["@careeros/core"]);
    expect(findForbiddenImports('import x from "@careeros/services";')).toEqual(["@careeros/services"]);
  });

  it("flags dynamic import() and require() of forbidden modules", () => {
    expect(findForbiddenImports('const m = await import("electron");')).toEqual(["electron"]);
    expect(findForbiddenImports('const fs = require("node:fs");')).toEqual(["node:fs"]);
  });

  it("allows type-only imports from forbidden modules, since they're erased at build time", () => {
    expect(findForbiddenImports('import type { Foo } from "@careeros/core";')).toEqual([]);
    expect(findForbiddenImports('import type Foo from "@careeros/core";')).toEqual([]);
  });

  it("still flags a mixed import that names a real (non-type-only) binding", () => {
    expect(findForbiddenImports('import { type Foo, Bar } from "@careeros/core";')).toEqual(["@careeros/core"]);
  });

  it("flags re-exports of forbidden modules", () => {
    expect(findForbiddenImports('export * from "@careeros/core";')).toEqual(["@careeros/core"]);
    expect(findForbiddenImports('export { x } from "electron";')).toEqual(["electron"]);
    expect(findForbiddenImports('export * as ns from "node:fs";')).toEqual(["node:fs"]);
  });

  it("allows a type-only re-export of a forbidden module, since it's erased at build time", () => {
    expect(findForbiddenImports('export type { X } from "@careeros/core";')).toEqual([]);
  });

  it("still flags a real re-export that follows an unrelated type-only statement", () => {
    // A lazy "from"-hunting match must not run past the first statement's `;` and swallow
    // the next statement's `from "spec"` — that would misattribute the next statement's
    // forbidden spec to the first statement's type-only-ness and miss it entirely.
    expect(findForbiddenImports('export type Foo = Bar;\nexport { app } from "electron";')).toEqual(["electron"]);
  });

  it("still flags a real import that follows an unrelated `import type X = Y` statement", () => {
    expect(findForbiddenImports('import type X = Y;\nimport { bad } from "node:fs";')).toEqual(["node:fs"]);
  });

  it("allows imports of permitted modules, including bare side-effect imports", () => {
    expect(findForbiddenImports('import { Button } from "@careeros/brand";')).toEqual([]);
    expect(findForbiddenImports('import "./app.css";')).toEqual([]);
    expect(findForbiddenImports('import type { CareerosBridge } from "@careeros/contract";')).toEqual([]);
  });
});

describe("renderer boundary", () => {
  it("never imports Node, Electron or the core library", () => {
    const bad: string[] = [];
    for (const f of walk(SRC)) {
      const text = fs.readFileSync(f, "utf8");
      for (const spec of findForbiddenImports(text)) bad.push(`${path.relative(SRC, f)}: ${spec}`);
    }
    expect(bad).toEqual([]);
  });
});
