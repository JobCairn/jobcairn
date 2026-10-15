import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importLegacy } from "../src/legacy.js";
import { insideRoot, layout, slugify } from "../src/paths.js";
import { makeLegacy } from "./fixtures/make-legacy.js";
import { FIXED, tmpDir } from "./helpers.js";

// Fictional contact details, built by concatenation so the privacy scanner
// stays meaningful rather than allowlisting a literal string.
const FICTIONAL_EMAIL = "alex" + "@" + "example.com";
const FICTIONAL_PHONE = "0491" + " 570 006";

function walk(root: string): [string, number][] {
  const out: [string, number][] = [];
  const rec = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      out.push([path.relative(root, p), st.mtimeMs]);
      if (st.isDirectory()) rec(p);
    }
  };
  rec(root);
  return out;
}

function findNames(root: string, needle: RegExp, skip: RegExp = /^$/): string[] {
  const hits: string[] = [];
  if (!fs.existsSync(root)) return hits;
  const rec = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const rel = path.relative(root, p);
      if (skip.test(rel)) continue;
      if (needle.test(name)) hits.push(rel);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) rec(p);
    }
  };
  rec(root);
  return hits;
}

function setup() {
  const src = tmpDir("legacy-sec-");
  makeLegacy(src);
  const dest = path.join(tmpDir(), "ws");
  return { src, dest };
}

describe("importLegacy security", () => {
  it("1. never modifies the source tree during a real import", () => {
    const { src, dest } = setup();
    const before = walk(src);
    importLegacy(src, dest, { now: FIXED });
    const after = walk(src);
    expect(after).toEqual(before);
  });

  it("2. never follows symlinks: symlinked files/dirs are skipped, never copied", () => {
    const { src, dest } = setup();
    // A unique canary file outside src; if any symlink were ever followed its
    // content/name would leak into dest.
    const canaryDir = tmpDir("legacy-sec-canary-");
    fs.writeFileSync(path.join(canaryDir, "canary.md"), "SYMLINK-CANARY-CONTENT\n");

    // Symlinked file inside a company folder.
    fs.symlinkSync(path.join(canaryDir, "canary.md"), path.join(src, "Company", "Acme Corp", "evil-link.md"));
    // Symlinked directory inside Personal Projects (handled by copyTree).
    fs.symlinkSync(canaryDir, path.join(src, "Personal Projects", "evil-dir"));
    // Symlinked top-level entry.
    fs.symlinkSync(canaryDir, path.join(src, "evil-top"));
    // Symlinked company folder itself.
    fs.symlinkSync(canaryDir, path.join(src, "Company", "Evil Co"));

    const r = importLegacy(src, dest, { now: FIXED });

    expect(r.skipped.some((s) => s.includes("evil-link.md") && s.includes("symlink"))).toBe(true);
    expect(r.skipped.some((s) => s.includes("evil-dir") && s.includes("symlink"))).toBe(true);
    expect(r.skipped.some((s) => s.includes("evil-top") && s.includes("symlink"))).toBe(true);
    expect(r.skipped.some((s) => s.includes("Evil Co") && s.includes("symlink"))).toBe(true);

    expect(findNames(dest, /evil/i)).toEqual([]);
    expect(findNames(dest, /canary/i)).toEqual([]);
  });

  it("2b. never follows a symlinked top-level folder (Visa/, Company/, Job-Hunt-Sponsorship/)", () => {
    const { src, dest } = setup();
    const canaryDir = tmpDir("legacy-sec-canary-top-");
    fs.writeFileSync(path.join(canaryDir, "canary.md"), "SYMLINK-CANARY-CONTENT\n");
    fs.writeFileSync(path.join(canaryDir, "sponsors.json"), JSON.stringify({ employers: [{ name: "Canary Corp" }] }));
    fs.writeFileSync(path.join(canaryDir, "SEARCH-LOG.md"), "| 2026-01-01 | canary | canary | x | 1 | 1 | canary |\n");
    fs.mkdirSync(path.join(canaryDir, "Canary Co"));
    fs.writeFileSync(path.join(canaryDir, "Canary Co", "application.json"), JSON.stringify({ company: "Canary Co", role: "Canary" }));
    for (const top of ["Visa", "Company", "Job-Hunt-Sponsorship"]) {
      fs.rmSync(path.join(src, top), { recursive: true, force: true });
      fs.symlinkSync(canaryDir, path.join(src, top));
    }

    const r = importLegacy(src, dest, { now: FIXED });

    for (const top of ["Visa", "Company", "Job-Hunt-Sponsorship"]) {
      expect(r.skipped).toContain(`${top} (symlink)`);
    }
    expect(r.actions.filter((a) => a.from.startsWith("Visa") || a.from.startsWith("Company") || a.from.startsWith("Job-Hunt-Sponsorship"))).toEqual([]);
    expect(findNames(dest, /canary/i)).toEqual([]);
    const all = fs.readdirSync(dest, { recursive: true }).map(String)
      .filter((f) => fs.statSync(path.join(dest, f)).isFile())
      .map((f) => fs.readFileSync(path.join(dest, f), "utf8")).join("\n");
    expect(all).not.toMatch(/canary/i);
  });

  it("3. dotfiles at any depth are skipped, never copied (.env, .mail-sync-state.json, .git)", () => {
    const { src, dest } = setup();
    fs.writeFileSync(path.join(src, "Company", "Acme Corp", ".mail-sync-state.json"), "{}\n");
    fs.mkdirSync(path.join(src, "Personal Projects", "side-app", ".git"), { recursive: true });
    fs.writeFileSync(path.join(src, "Personal Projects", "side-app", ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(src, "resume-docs", ".env"), `SECRET=${FICTIONAL_EMAIL}\n`);
    fs.mkdirSync(path.join(src, "Company", "Acme Corp", "Recruiter-email", ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(src, "Company", "Acme Corp", "Recruiter-email", ".draft.md"), `call ${FICTIONAL_PHONE}\n`);

    importLegacy(src, dest, { now: FIXED });

    expect(findNames(dest, /^\.env$/, /^settings\/\.env$/)).toEqual([]);
    expect(findNames(dest, /\.mail-sync-state\.json$/)).toEqual([]);
    expect(findNames(dest, /^\.git$/)).toEqual([]);
    expect(findNames(dest, /^\.hidden$/)).toEqual([]);
    expect(findNames(dest, /^\.draft\.md$/)).toEqual([]);
  });

  it("4. files copied into me/identity and me/employment stay inside those 0700 folders and keep 0600 source mode", () => {
    const { src, dest } = setup();
    const visaFile = path.join(src, "Visa", "26-27", "grant.pdf");
    const contractFile = path.join(src, "Current-company", "contract.pdf");
    fs.chmodSync(visaFile, 0o600);
    fs.chmodSync(contractFile, 0o600);

    importLegacy(src, dest, { now: FIXED });
    const L = layout(dest);

    expect((fs.statSync(L.me("identity")).mode & 0o777)).toBe(0o700);
    expect((fs.statSync(L.me("employment")).mode & 0o777)).toBe(0o700);

    const copiedVisa = path.join(dest, "me", "identity", "visa", "26-27", "grant.pdf");
    const copiedContract = path.join(dest, "me", "employment", "contract.pdf");
    expect(insideRoot(L.me("identity"), copiedVisa)).toBe(true);
    expect(insideRoot(L.me("employment"), copiedContract)).toBe(true);
    expect(fs.statSync(copiedVisa).mode & 0o777).toBe(0o600);
    expect(fs.statSync(copiedContract).mode & 0o777).toBe(0o600);
  });

  it("5. dryRun writes nothing at all; dest is not even created", () => {
    const { src, dest } = setup();
    const r = importLegacy(src, dest, { dryRun: true, now: FIXED });
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(path.dirname(dest))).toBe(true);
    expect(fs.readdirSync(path.dirname(dest))).toEqual([]);
    expect(r.actions.some((a) => a.kind !== "job" && a.kind !== "skip")).toBe(true); // planned, but nothing written
  });

  it("6. messy company names become safe slugs; every action lands inside dest", () => {
    const { src, dest } = setup();
    const messyName = "Acme/Partners Pty Ltd (client Côte Recruiting)";
    fs.mkdirSync(path.join(src, "Company", "Acme--Partners (client)"), { recursive: true });
    fs.writeFileSync(
      path.join(src, "Company", "Acme--Partners (client)", "application.json"),
      JSON.stringify({ company: messyName, role: "AI Developer", source: "LinkedIn", status: "Found", date_found: "2026-01-16" }),
    );

    const r = importLegacy(src, dest, { now: FIXED });
    const jobAction = r.actions.find((a) => a.kind === "job" && a.from === "Company/Acme--Partners (client)");
    expect(jobAction).toBeTruthy();
    const slug = jobAction!.to.split("/")[1];
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(slug).not.toMatch(/[/\\]/);

    const abs = path.join(dest, jobAction!.to, "job.json");
    expect(insideRoot(dest, abs)).toBe(true);
    expect(fs.existsSync(abs)).toBe(true);

    // Nothing was written outside dest for any recorded action.
    for (const a of r.actions) {
      if (a.kind === "copy" || a.kind === "job") {
        const target = path.resolve(dest, a.to);
        expect(insideRoot(dest, target)).toBe(true);
      }
    }

    // The dry-run planner (which computes its own slug before calling newJob)
    // must sanitize the same messy name the same way.
    const dryDest = path.join(tmpDir(), "ws-dry");
    const dr = importLegacy(src, dryDest, { dryRun: true, now: FIXED });
    const plannedAction = dr.actions.find((a) => a.kind === "job" && a.from === "Company/Acme--Partners (client)");
    expect(plannedAction).toBeTruthy();
    const plannedSlug = plannedAction!.to.split("/")[1];
    expect(plannedSlug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
