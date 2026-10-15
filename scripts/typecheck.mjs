#!/usr/bin/env node
// Type-checks every package that has a tsconfig.json. Exit 1 if any fails.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const pkgs = fs.readdirSync(path.join(root, "packages")).filter((p) => fs.existsSync(path.join(root, "packages", p, "tsconfig.json"))).sort();
let failed = 0;
for (const p of pkgs) {
  try {
    execFileSync(process.execPath, [tsc, "-p", path.join("packages", p, "tsconfig.json"), "--noEmit"], { cwd: root, stdio: "inherit" });
  } catch {
    failed++;
    console.error(`typecheck failed: packages/${p}`);
  }
}
process.exit(failed ? 1 : 0);
