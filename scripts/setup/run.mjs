#!/usr/bin/env node
// JobCairn setup runner. install: check, install what is missing, re-check. doctor: check only.
import path from "node:path";
import { parseArgs } from "node:util";
import { HOMEBREW_ENV, isRoot, loadComponents, runSetup, shellExec, withNpmFallback } from "./lib.mjs";

if (isRoot()) {
  console.error("Refusing to run JobCairn setup as root. Re-run as your normal macOS user.");
  process.exit(1);
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { only: { type: "string" }, json: { type: "boolean" }, "dry-run": { type: "boolean" }, components: { type: "string" } } });
const mode = positionals[0] === "doctor" ? "doctor" : "install";
// --components: the packaged app ships the runner and the components side by side in Resources/careeros-setup.
const dir = values.components ? path.resolve(values.components) : path.resolve(import.meta.dirname, "../../setup/components");
const components = loadComponents(dir);
// Every command inherits these (execSync passes process.env on); a person's own setting wins.
for (const [k, v] of Object.entries(HOMEBREW_ENV)) process.env[k] ??= v;
const run = (cmd) => (mode === "install" && !cmd.includes(" --version") ? shellExec(cmd, false) : shellExec(cmd, true));
const exec = mode === "install" ? withNpmFallback(run) : run;
const { results, ok } = runSetup({ components, mode, only: values.only, dryRun: values["dry-run"], exec });

if (values.json) {
  console.log(JSON.stringify({ ok, results }, null, 2));
} else {
  const icon = { ok: "✓", installed: "✓", planned: "…", missing: "✗", failed: "✗", unsupported: "–" };
  for (const r of results) {
    console.log(`${icon[r.state]} ${r.name.padEnd(22)} ${r.state}${r.required ? "" : " (optional)"}`);
    if (["missing", "failed"].includes(r.state)) console.log(`    Why it matters: ${r.why}\n    Help: ${r.docs}`);
  }
  console.log(ok ? "\nAll required parts are ready." : "\nSome required parts are not ready. Fix the ✗ items, then run setup again.");
}
process.exit(ok ? 0 : 1);
