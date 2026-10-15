import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { suggestInboxTarget } from "../src/inbox.js";
import { newJob, setStatus } from "../src/jobs.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  const acme = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
  const old = newJob(root, { company: "Acme Corp", title: "Data Analyst" }, { now: new Date("2025-06-01T00:00:00.000Z") });
  setStatus(root, old.company_slug, old.id, "Rejected");
  const labs = newJob(root, { company: "Example Labs", title: "Backend Engineer (LLM)" }, { now: FIXED });
  return { root, acme, labs };
}
const drop = (root: string, name: string, body = "x") => fs.writeFileSync(path.join(layout(root).inbox, name), body);

describe("suggestInboxTarget", () => {
  it("sends identity, employment and education papers to me/ first", () => {
    const { root } = ws();
    expect(suggestInboxTarget(root, "Visa_Grant_Notice.pdf")).toMatchObject({ target: { kind: "me", dir: "identity", sub: "visa" }, confidence: "high" });
    expect(suggestInboxTarget(root, "passport-scan.jpg").target).toEqual({ kind: "me", dir: "identity" });
    expect(suggestInboxTarget(root, "acme-corp-payslip-march.pdf").target).toEqual({ kind: "me", dir: "employment" });
    expect(suggestInboxTarget(root, "Academic Transcript.pdf").target).toEqual({ kind: "me", dir: "education" });
  });
  it("matches a company in the name to its open job and picks a sub-folder", () => {
    const { root, acme, labs } = ws();
    expect(suggestInboxTarget(root, "acme-corp-cover-letter.docx")).toMatchObject({
      target: { kind: "job", company_slug: "acme-corp", id: acme.id, subdir: "application" }, confidence: "high",
    });
    expect(suggestInboxTarget(root, "Example Labs interview questions.md").target).toEqual({ kind: "job", company_slug: "example-labs", id: labs.id, subdir: "interview" });
    expect(suggestInboxTarget(root, "example_labs_offer.eml").target).toMatchObject({ subdir: "emails" });
    expect(suggestInboxTarget(root, "acme corp notes.pdf")).toMatchObject({ target: { kind: "job", subdir: "" }, confidence: "medium" });
  });
  it("files a plain resume into me/resumes and a portfolio into me/projects", () => {
    const { root } = ws();
    expect(suggestInboxTarget(root, "Alex_Example_CV_2026.pdf")).toMatchObject({ target: { kind: "me", dir: "resumes" }, confidence: "medium" });
    expect(suggestInboxTarget(root, "portfolio.pdf")).toMatchObject({ target: { kind: "me", dir: "projects" }, confidence: "low" });
  });
  it("reads small text files for a company name", () => {
    const { root, labs } = ws();
    drop(root, "notes.md", "Call with the Example Labs hiring manager on Thursday.");
    expect(suggestInboxTarget(root, "notes.md")).toMatchObject({ target: { kind: "job", company_slug: "example-labs", id: labs.id }, confidence: "medium" });
  });
  it("says so when nothing matches, and rejects unsafe names", () => {
    const { root } = ws();
    drop(root, "IMG_0001.heic");
    expect(suggestInboxTarget(root, "IMG_0001.heic")).toEqual({ target: null, reason: "No rule matched. Choose a folder.", confidence: "low" });
    expect(() => suggestInboxTarget(root, "../secret.txt")).toThrow(/not an inbox file name/);
  });
});
