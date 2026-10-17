import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importLegacy, legacyStatus } from "../src/legacy.js";
import { listJobs } from "../src/jobs.js";
import { readRecord } from "../src/store.js";
import { readSearches } from "../src/knowledge.js";
import { layout } from "../src/paths.js";
import { makeLegacy } from "./fixtures/make-legacy.js";
import { FIXED, tmpDir } from "./helpers.js";

function setup() {
  const src = tmpDir("legacy-"); makeLegacy(src);
  const dest = path.join(tmpDir(), "ws");
  return { src, dest };
}

describe("legacyStatus", () => {
  it("keeps Withdrawn and No response as final statuses, and still folds Closed into Skipped", () => {
    expect(legacyStatus("Withdrawn")).toBe("Withdrawn");
    expect(legacyStatus("No response")).toBe("No response");
    expect(legacyStatus("Ghosted")).toBe("No response");
    expect(legacyStatus("Closed")).toBe("Skipped");
    expect(legacyStatus("Interviewing")).toBe("Interview");
    expect(legacyStatus("Something else")).toBe("Found");
    expect(legacyStatus(undefined)).toBe("Found");
  });
});

describe("importLegacy", () => {
  it("dry run plans everything and writes nothing", () => {
    const { src, dest } = setup();
    const r = importLegacy(src, dest, { dryRun: true, now: FIXED });
    expect(fs.existsSync(dest)).toBe(false);
    expect(r.actions.filter((a) => a.kind === "job").map((a) => a.to)).toEqual([
      "companies/acme-corp/jobs/2026-01-12-ai-engineer",
      "companies/acme-recruiting/jobs/2026-01-13-ai-developer",
    ]);
    expect(r.unmapped).toEqual(expect.arrayContaining(["scripts", "Company/No Record Co"]));
    expect(r.skipped).toContain(".env");
  });
  it("imports jobs with mapped status, work rights, scores, timeline and files", () => {
    const { src, dest } = setup();
    const r = importLegacy(src, dest, { now: FIXED });
    expect(r.issues).toEqual([]);
    const L = layout(dest);
    const j = readRecord("job", L.jobFile("acme-corp", "2026-01-12-ai-engineer"));
    expect(j.status).toBe("Applied");
    expect(j.url).toBe("https://jobs.example.com/77");
    expect(j.source).toBe("browser");
    expect(j.source_site).toBe("SEEK");
    expect(j.work_rights).toMatchObject({ label: "sponsorship_offered", quotes: ["Visa sponsorship available"], decided_by: "scan" });
    expect(j.scores.sponsor.value).toBe(95);
    expect(j.scores.career).toMatchObject({ match: 80, odds: 60, tier: "Good Fit" });
    expect(j.timeline.map((e) => e.event)).toEqual(["Found", "Applied"]);
    expect(j.custom.legacy_folder).toBe("Company/Acme Corp");
    const dir = L.jobDir("acme-corp", "2026-01-12-ai-engineer");
    expect(fs.existsSync(path.join(dir, "jd.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "score.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "application", "resume-2026-01-13-ai-engineer.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "emails", "thread.md"))).toBe(true);
    const rec = readRecord("job", L.jobFile("acme-recruiting", "2026-01-13-ai-developer"));
    expect(rec.client).toBe("Example University");
    expect(rec.work_rights.label).toBe("citizen_pr_only");
  });
  it("imports sponsors, the search log and personal folders, never .env or node_modules", () => {
    const { src, dest } = setup();
    importLegacy(src, dest, { now: FIXED });
    const L = layout(dest);
    expect(readRecord("sponsors", L.sponsors).employers).toEqual([{ name: "Acme Corp", status: "verified" }]);
    expect(readSearches(dest).entries.map((e) => [e.at, e.site])).toEqual([["2026-01-12T14:05:00", "SEEK"], ["2026-01-11T00:00:00", "LinkedIn"]]);
    expect(fs.existsSync(path.join(dest, "me", "identity", "visa", "26-27", "grant.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "me", "identity", "address", "lease.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "me", "employment", "contract.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "me", "history", "profile.md"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "me", "projects", "side-app", "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "me", "projects", "side-app", "node_modules"))).toBe(false);
    expect(fs.readFileSync(L.env, "utf8")).not.toContain("SECRET");
  });
  it("is idempotent and never touches the source", () => {
    const { src, dest } = setup();
    const before = fs.readdirSync(src).sort();
    importLegacy(src, dest, { now: FIXED });
    const again = importLegacy(src, dest, { now: FIXED });
    expect(listJobs(dest)).toHaveLength(2);
    expect(again.actions.filter((a) => a.kind === "job")).toEqual([]);
    expect(readSearches(dest).entries).toHaveLength(2);
    expect(fs.readdirSync(src).sort()).toEqual(before);
  });
  it("copies a nested sub-folder inside a job folder recursively, instead of dropping it (I5)", () => {
    const { src, dest } = setup();
    fs.mkdirSync(path.join(src, "Company", "Acme Corp", "Interview", "Round 2"), { recursive: true });
    fs.writeFileSync(path.join(src, "Company", "Acme Corp", "Interview", "Round 2", "notes.md"), "second round notes\n");

    const r = importLegacy(src, dest, { now: FIXED });
    expect(r.issues).toEqual([]);
    const dir = layout(dest).jobDir("acme-corp", "2026-01-12-ai-engineer");
    expect(fs.existsSync(path.join(dir, "interview", "Round 2", "notes.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "interview", "Round 2", "notes.md"), "utf8")).toBe("second round notes\n");
  });
  it("keeps both files when two legacy sub-folders map to the same target name (I5)", () => {
    const { src, dest } = setup();
    // The existing fixture already has "Recruiter-email/thread.md" -> emails/thread.md.
    // Add a second, differently-named folder that also maps to "emails" with a
    // colliding file name but different content.
    fs.mkdirSync(path.join(src, "Company", "Acme Corp", "Emails"), { recursive: true });
    fs.writeFileSync(path.join(src, "Company", "Acme Corp", "Emails", "thread.md"), "a different, longer thread\n");

    const r = importLegacy(src, dest, { now: FIXED });
    expect(r.issues).toEqual([]);
    const emailsDir = path.join(layout(dest).jobDir("acme-corp", "2026-01-12-ai-engineer"), "emails");
    const files = fs.readdirSync(emailsDir).sort();
    expect(files).toEqual(["thread-2.md", "thread.md"]);
    const contents = files.map((f) => fs.readFileSync(path.join(emailsDir, f), "utf8")).sort();
    expect(contents).toEqual(["Hi Alex\n", "a different, longer thread\n"].sort());
  });
});
