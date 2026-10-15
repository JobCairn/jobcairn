import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Vitest's module runner hides import-order cycles that crash under real Node ESM, so each entry
// point is loaded first in a fresh `node --import tsx` process, then the dispatch table is counted.
const SRC = path.resolve(import.meta.dirname, "../src");
const url = (f: string) => pathToFileURL(path.join(SRC, f)).href;

describe("real Node ESM load order", () => {
  for (const entry of ["index.ts", "read.ts", "approvals.ts", "mail-read.ts", "mail-sync.ts", "mail-send.ts"]) {
    it(`loads with ${entry} imported first`, () => {
      const code = `await import(${JSON.stringify(url(entry))}); const d = await import(${JSON.stringify(url("dispatch.ts"))}); process.stdout.write(String(Object.keys(d.HANDLERS).length));`;
      let out = "";
      try {
        out = execFileSync(process.execPath, ["--no-warnings", "--import", "tsx", "--input-type=module", "-e", code], { cwd: SRC, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
      } catch (e) {
        const err = e as { stderr?: string; message: string };
        expect.fail(`${entry} failed to load: ${(err.stderr ?? err.message).split("\n").find((l) => /Error/.test(l)) ?? err.message}`);
      }
      expect(Number(out)).toBeGreaterThan(40);
    }, 60_000);
  }
});
