#!/usr/bin/env node
// Folds other SHA256SUMS.txt files into this build's one, so the release carries one file for every system:
//   node scripts/merge-checksums.mjs <this build's SHA256SUMS.txt> <the release's SHA256SUMS.txt> ...
// Missing inputs are skipped (the first build of a release has nothing to merge). This build's lines win for a
// file name both list. Run it after verify-release (the merged file names installers that aren't on this machine).
import fs from "node:fs";
import { mergeChecksums } from "./release.mjs";

const [target, ...others] = process.argv.slice(2);
if (!target) { console.error("usage: merge-checksums.mjs <SHA256SUMS.txt> <other SHA256SUMS.txt>..."); process.exit(1); }
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const merged = mergeChecksums(...others.map(read), read(target));
fs.writeFileSync(target, merged);
console.log(`merge-checksums: ${merged.split("\n").filter(Boolean).length} file(s) in ${target}`);
