import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateComponent(c) {
  const p = [];
  if (!c || typeof c !== "object") return ["not an object"];
  if (typeof c.id !== "string" || !ID.test(c.id)) p.push("id must be lowercase-hyphenated");
  for (const k of ["name", "why", "docs"]) if (typeof c[k] !== "string" || !c[k]) p.push(`${k} is required`);
  if (typeof c.order !== "number") p.push("order must be a number");
  if (typeof c.required !== "boolean") p.push("required must be true or false");
  if (!c.platforms || typeof c.platforms !== "object" || !Object.keys(c.platforms).length) p.push("platforms needs at least one OS");
  for (const [os, spec] of Object.entries(c.platforms ?? {})) {
    if (typeof spec?.check !== "string" || !spec.check) p.push(`platforms.${os}.check is required`);
    if (!Array.isArray(spec?.install) || spec.install.some((x) => typeof x !== "string")) p.push(`platforms.${os}.install must be a list of commands`);
  }
  return p;
}

export function loadComponents(dir) {
  const seen = new Map();
  const out = [];
  // Filename/id mismatches are collected but not thrown until after the whole
  // directory has been scanned, so a duplicate id (checked per-file, below) is
  // always reported first if both problems are present in the same directory.
  const mismatches = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); }
    catch (e) { throw new Error(`${file}: invalid JSON (${e.message})`); }
    const problems = validateComponent(c);
    if (problems.length) throw new Error(`${file}: ${problems.join("; ")}`);
    if (seen.has(c.id)) throw new Error(`duplicate id "${c.id}" in ${file} (also in ${seen.get(c.id)})`);
    seen.set(c.id, file);
    const stem = file.slice(0, -path.extname(file).length);
    if (stem !== c.id) mismatches.push(`${file}: file name must match id "${c.id}" (expected ${c.id}.json)`);
    out.push(c);
  }
  if (mismatches.length) throw new Error(mismatches.join("; "));
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function shellExec(cmd, quiet = true) {
  try { execSync(cmd, { stdio: quiet ? "ignore" : "inherit", shell: "/bin/bash" }); return 0; }
  catch (e) { return typeof e.status === "number" ? e.status : 1; }
}

// Homebrew runs without its self-update (HOMEBREW_ENV), so a stale formula list can fail an install: refresh once, retry.
const BREW_INSTALL = /^brew (install|upgrade)\b/;
function runOnce(cmd, exec) {
  const code = exec(cmd);
  return code !== 0 && BREW_INSTALL.test(cmd) && exec("brew update") === 0 ? exec(cmd) : code;
}

export function runSetup({ components, mode, platform = process.platform, only, dryRun = false, exec = shellExec }) {
  const results = [];
  for (const c of components) {
    if (only && c.id !== only) continue;
    const spec = c.platforms[platform];
    const r = (state) => results.push({ id: c.id, name: c.name, required: c.required, state, why: c.why, docs: c.docs });
    if (!spec) { r("unsupported"); continue; }
    if (exec(spec.check) === 0) { r("ok"); continue; }
    if (mode === "doctor") { r("missing"); continue; }
    if (dryRun) { r("planned"); continue; }
    let failed = false;
    for (const cmd of spec.install) if (runOnce(cmd, exec) !== 0) { failed = true; break; }
    r(!failed && exec(spec.check) === 0 ? "installed" : "failed");
  }
  const ok = results.every((x) => !x.required || x.state === "ok" || x.state === "installed" || x.state === "planned");
  return { results, ok };
}

// Security: refuse to run setup as root. Exported as a pure predicate so it is
// unit-testable without actually running as root; run.mjs calls it at startup.
export function isRoot(uid = process.getuid?.()) {
  return uid === 0;
}

// Homebrew, quicker and quieter: no `brew update` before each install (the slow, silent part that made a Node.js
// install look stuck), no hints, no cleanup pass, no analytics. The app's setup host sets the same.
export const HOMEBREW_ENV = { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_ANALYTICS: "1" };

const NPM_GLOBAL = /^npm (install|i) (-g|--global)\b/;
const SUDO_NOTE = "sudo asks for your Mac password (the one you log in with). Nothing shows while you type it; that's normal.";

/** What to do when npm can't write its global folder: the no-password fix first, then the sudo ones. */
export function npmPermissionHelp(cmd, prefix) {
  return [
    `npm isn't allowed to write to ${prefix} (permission denied). Fix it one of two ways in Terminal, then run setup again.`,
    "",
    "  Without your password (recommended): give npm a folder in your home folder.",
    "    mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global",
    `    echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zprofile && source ~/.zprofile`,
    "",
    "  Or with your Mac password: make npm's folders yours,",
    '    sudo chown -R "$(whoami)" "$(npm config get prefix)"/{lib/node_modules,bin,share}',
    `  or install this one tool as administrator: sudo ${cmd}`,
    `  ${SUDO_NOTE}`,
  ].join("\n");
}

/** npm's global folder, or null when npm can't say. */
export function npmGlobalPrefix() {
  try { return execSync("npm prefix -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: "/bin/bash" }).trim() || null; }
  catch { return null; }
}

/** Can this user write where `npm install -g` puts packages? Checks the nearest folder that exists. */
export function npmPrefixWritable(prefix) {
  for (const d of [path.join(prefix, "lib", "node_modules"), path.join(prefix, "lib"), prefix]) {
    if (!fs.existsSync(d)) continue;
    try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; }
  }
  return false;
}

/**
 * Wraps `exec` so a failed `npm install -g` into a folder this user can't write explains both fixes (on stderr, so
 * --json output stays readable), then installs into ~/.npm-global instead, which needs no password (the app looks
 * for the browser helper there too).
 */
export function withNpmFallback(exec, o = {}) {
  const log = o.log ?? ((t) => console.error(t));
  const prefix = o.prefix ?? npmGlobalPrefix;
  const writable = o.writable ?? npmPrefixWritable;
  return (cmd) => {
    const code = exec(cmd);
    if (code === 0 || !NPM_GLOBAL.test(cmd)) return code;
    const p = prefix();
    if (!p || writable(p)) return code;
    log(npmPermissionHelp(cmd, p));
    log("\nTrying your home folder instead (~/.npm-global, no password needed)...");
    return exec(cmd.replace(NPM_GLOBAL, (m) => `${m} --prefix "$HOME/.npm-global" --cache "$HOME/.npm-global/_cache"`));
  };
}
