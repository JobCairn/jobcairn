#!/usr/bin/env node
// Personal-data scan. Modes: --staged | --range <a..b> | --all | --history. Flag: --require-denylist.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyAllowlist, checkPath, checkText, loadAllowlist, loadDenylist } from "./rules.mjs";

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith("--") && a !== "--require-denylist") ?? "--all";
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const denyFile = process.env.CAREEROS_DENYLIST ?? path.join(os.homedir(), ".config", "careeros", "denylist.txt");
const deny = loadDenylist(denyFile);
if (args.includes("--require-denylist") && !deny) {
  console.error(`privacy-scan: no denylist at ${denyFile}.\nCreate it with your real name variants, emails, phone, street address, employer and ID numbers (one per line) before pushing.`);
  process.exit(1);
}
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const allowlist = loadAllowlist(path.join(scriptDir, "allowlist.txt"));

const BINARY = /\.(pdf|docx?|png|jpe?g|heic|gif|webp|xlsx?|pptx?|zip|sqlite)$/i;
// Paths come from git with -z so quoting/encoding of special characters never round-trips wrong.
const splitZ = (s) => s.split("\0").filter(Boolean);
const oneLine = (err) => {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.split("\n")[0].trim();
};

const findings = [];
let scanErrors = 0;

const scanFile = (label, p, read) => {
  try {
    for (const f of checkPath(p)) findings.push({ ...f, label });
    if (!BINARY.test(p)) {
      const text = read();
      for (const f of checkText(p, text, deny ?? [])) findings.push({ ...f, label });
    }
  } catch (err) {
    scanErrors++;
    findings.push({ file: p, label, line: 0, rule: "scan-error", message: oneLine(err) });
  }
};

const scanCommit = (c) => {
  const short = c.slice(0, 8);
  findings.push(...checkText(`commit ${short} message`, git("log", "-1", "--format=%B", c), deny ?? []));
  findings.push(...checkText(`commit ${short} author`, git("log", "-1", "--format=%an <%ae>%n%cn <%ce>", c), deny ?? []));
  for (const p of splitZ(git("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "--diff-filter=ACMR", "-z", c))) {
    scanFile(`${short}:${p}`, p, () => git("show", `${c}:${p}`));
  }
};

if (mode === "--staged") {
  for (const p of splitZ(git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"))) {
    scanFile(p, p, () => git("show", `:${p}`));
  }
} else if (mode === "--range") {
  const range = args[args.indexOf("--range") + 1];
  for (const c of git("rev-list", range).split("\n").filter(Boolean)) scanCommit(c);
} else if (mode === "--history") {
  for (const c of git("rev-list", "--all").split("\n").filter(Boolean)) scanCommit(c);
} else {
  for (const p of splitZ(git("ls-files", "-z"))) {
    scanFile(p, p, () => fs.readFileSync(p, "utf8"));
  }
}

const reported = applyAllowlist(findings, allowlist);

if (reported.length) {
  console.error("privacy-scan: personal data found. Fix these before committing or pushing:");
  for (const f of reported) {
    const shown = f.label ?? f.file;
    const loc = f.line ? `:${f.line}` : "";
    const detail = f.rule === "scan-error" ? (f.message ? `: ${f.message}` : "") : f.sample ? `  (${f.sample})` : "";
    console.error(`  ${shown}${loc}  ${f.rule}${detail}`);
  }
  process.exit(1);
}
if (scanErrors) {
  // Should be unreachable (scan-error findings are never allowlisted away by rule name),
  // but fail closed defensively if that ever changes.
  console.error(`privacy-scan: ${scanErrors} file(s) could not be scanned; failing closed.`);
  process.exit(1);
}
console.log(`privacy-scan: clean (${mode}${deny ? ", denylist on" : ", no denylist"})`);
