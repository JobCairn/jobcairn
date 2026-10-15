import fs from "node:fs";

export const ALLOWED_BINARY_DIRS = ["samples/", "public/", "docs/assets/"];
const BINARY_EXT = /\.(pdf|docx?|png|jpe?g|heic|gif|webp|xlsx?|pptx?|zip)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /@(example\.(com|org|net)|users\.noreply\.github\.com|anthropic\.com)$/i;
const PHONE = /(?<![\d])(?:\+?61\s?|0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}(?![\d])/g;
const FICTIONAL_PHONE = /^(?:\+?61\s?|0)491[\s-]?57\d/;
const ID_NUMBER = /\b(passport|visa grant|tfn|tax file number|medicare)\b[^\n]{0,40}?\d{6,}/i;

export function mask(s) {
  return s.length <= 4 ? "****" : s.slice(0, 2) + "*".repeat(Math.min(s.length - 4, 8)) + s.slice(-2);
}

export function isEnvFile(p) {
  const b = p.split("/").pop() ?? "";
  return b === ".env" || (b.startsWith(".env.") && b !== ".env.example");
}

export function checkPath(p) {
  const out = [];
  if (isEnvFile(p)) out.push({ file: p, line: 0, rule: "env-file" });
  if (BINARY_EXT.test(p) && !ALLOWED_BINARY_DIRS.some((d) => p.startsWith(d))) out.push({ file: p, line: 0, rule: "binary-outside-samples" });
  return out;
}

export function checkText(p, text, denylist = []) {
  const out = [];
  const deny = denylist.map((d) => d.trim().toLowerCase()).filter((d) => d.length >= 3);
  text.split("\n").forEach((line, i) => {
    const n = i + 1;
    const low = line.toLowerCase();
    for (const d of deny) if (low.includes(d)) out.push({ file: p, line: n, rule: "denylist", sample: mask(d) });
    for (const m of line.matchAll(EMAIL)) if (!ALLOWED_EMAIL.test(m[0])) out.push({ file: p, line: n, rule: "email", sample: mask(m[0]) });
    for (const m of line.matchAll(PHONE)) if (!FICTIONAL_PHONE.test(m[0])) out.push({ file: p, line: n, rule: "phone", sample: mask(m[0]) });
    if (ID_NUMBER.test(line)) out.push({ file: p, line: n, rule: "id-number" });
  });
  return out;
}

export function loadDenylist(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch {
    return null;
  }
}

// allowlist.txt format: one entry per line, "<repo path> <rule>  # reason". Blank lines and
// lines starting with "#" (after trimming) are ignored. The "denylist" rule can never be
// allowlisted; such entries are dropped with a warning. Paths must match exactly (no globs).
export function parseAllowlist(text) {
  const out = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const idx = line.lastIndexOf(" ");
    if (idx < 0) continue;
    const file = line.slice(0, idx).trim();
    const rule = line.slice(idx + 1).trim();
    if (!file || !rule) continue;
    if (rule === "denylist") {
      console.error(`privacy-scan: allowlist.txt cannot allow the "denylist" rule (ignoring entry for ${file})`);
      continue;
    }
    out.push({ file, rule });
  }
  return out;
}

export function loadAllowlist(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseAllowlist(raw);
}

export function applyAllowlist(findings, allowlist) {
  if (!allowlist || !allowlist.length) return findings;
  return findings.filter((f) => !allowlist.some((a) => a.file === f.file && a.rule === f.rule));
}
