import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout, readRecord, samplePdf } from "@careeros/core";
import { applyHandlers as A } from "../src/apply.js";
import { docsHandlers as D } from "../src/docs.js";
import { openSample } from "./helpers.js";
import { RESUME } from "./print-fixtures.js";

// Fictional data only (the Alex Example sample). Spec: docs/specs/2026-10-17-resume-checks.md.
const LABS = ["example-labs", "2026-01-12-backend-engineer-llm"] as const;
const appDir = (root: string) => path.join(layout(root).jobDir(...LABS), "application");

function withResume(md = RESUME) {
  const x = openSample();
  fs.mkdirSync(appDir(x.root), { recursive: true });
  fs.writeFileSync(path.join(appDir(x.root), "resume.md"), md);
  return x;
}

// Exports and the check run in worker threads; on a loaded machine that alone can take seconds.
describe("docs.check: the ATS check of the exported resume", { timeout: 60_000 }, () => {
  it("is null until the resume is exported", async () => {
    const { ctx } = withResume();
    expect(await D["docs.check"](ctx, ...LABS)).toBeNull();
  });

  it("checks the text that comes out of the Word export, without a page row", async () => {
    const { ctx } = withResume();
    await D["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false);
    const c = (await D["docs.check"](ctx, ...LABS))!;
    expect(c.file).toBe("resume.docx");
    expect(c.stale).toBe(false);
    const by = Object.fromEntries(c.items.map((i) => [i.id, i.status]));
    expect(Object.keys(by)).not.toContain("pages");
    // The fixture has the profile's email, no phone, only an Experience heading and few words.
    expect(by).toMatchObject({ text: "pass", email: "pass", phone: "warn", dates: "pass", headings: "warn", length: "warn" });
    expect(c.items.find((i) => i.id === "headings")!.detail).toContain("No Education or Skills heading");
  });

  it("prefers the PDF, and says so plainly when it can't be read", async () => {
    // The test printer's "PDF" is a stub with no pages, so it can't be read.
    const { ctx } = withResume();
    await D["docs.export"](ctx, ...LABS, ["resume"], ["pdf", "docx"], false);
    const c = (await D["docs.check"](ctx, ...LABS))!;
    expect(c.file).toBe("resume.pdf");
    expect(c.items).toEqual([{ id: "read", label: "Readable file", status: "warn", detail: "Couldn't read the exported file. Export it again, then check." }]);
  });

  it("reads a real PDF's text and page count", async () => {
    const { ctx, root } = withResume();
    const dir = path.join(appDir(root), "export");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "resume.pdf"), samplePdf(["Alex Example", "alex" + "@" + "example.com", "Experience", "Education", "Skills"]));
    const c = (await D["docs.check"](ctx, ...LABS))!;
    expect(c.items.find((i) => i.id === "pages")).toMatchObject({ status: "pass", detail: "1 page." });
    expect(c.items.find((i) => i.id === "email")!.status).toBe("pass");
  });

  it("says when the resume changed after the export", async () => {
    const { ctx, root } = withResume();
    await D["docs.export"](ctx, ...LABS, ["resume"], ["docx"], false);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(appDir(root), "resume.md"), later, later);
    expect((await D["docs.check"](ctx, ...LABS))!.stale).toBe(true);
  });
});

const REVIEW = {
  edits: [{ file: "resume.md", old: "Led a team of 12", new: "Worked in a team of 12", reason: "grounding", why: "No source says led." }],
  stretch: [
    { file: "resume.md", text: "Owned the retrieval platform at Example Labs", why: "The evidence shows support.", soften: "Supported the retrieval platform at Example Labs" },
    { file: "resume.md", text: "Set the team's roadmap", why: "No source.", soften: "" },
  ],
  facts: [{ fact: "Mentored 2 graduates in 2025", source: "your note" }],
  notes: "Two stretches to answer.",
};
const MD = "# Alex Example\n\n## Experience\n\n- Owned the retrieval platform at Example Labs\n- Set the team's roadmap\n- Built pipelines\n";

function withReview() {
  const x = withResume(MD);
  fs.writeFileSync(path.join(appDir(x.root), "review.json"), JSON.stringify(REVIEW));
  return x;
}
const facts = (root: string) => { try { return fs.readFileSync(path.join(root, "me", "history", "confirmed-facts.md"), "utf8"); } catch { return ""; } };
const reviewOnDisk = (root: string) => JSON.parse(fs.readFileSync(path.join(appDir(root), "review.json"), "utf8")) as typeof REVIEW & { stretch: { state?: string }[]; facts: { saved?: boolean }[] };

describe("Claude's review on the Apply screen", () => {
  it("shows the review with the application", () => {
    const { ctx } = withReview();
    const r = A["apply.state"](ctx, ...LABS).review!;
    expect(r.edits[0]).toMatchObject({ reason: "grounding", old: "Led a team of 12" });
    expect(r.stretch.map((s) => s.state)).toEqual(["open", "open"]);
    expect(r.facts).toEqual([{ fact: "Mentored 2 graduates in 2025", source: "your note", saved: false }]);
  });

  it("It's true: saves the claim to me/history and marks it kept, leaving the resume alone", () => {
    const { ctx, root } = withReview();
    const s = A["apply.stretch"](ctx, ...LABS, 0, REVIEW.stretch[0]!.text, "keep");
    expect(s.review!.stretch[0]!.state).toBe("kept");
    expect(facts(root)).toContain("- Owned the retrieval platform at Example Labs (confirmed ");
    expect(facts(root)).toContain("kept in a review, ");
    expect(reviewOnDisk(root).stretch[0]!.state).toBe("kept");
    expect(fs.readFileSync(path.join(appDir(root), "resume.md"), "utf8")).toBe(MD);
  });

  it("Soften and Drop change the resume, versioned, and log it", () => {
    const { ctx, root } = withReview();
    A["apply.stretch"](ctx, ...LABS, 0, REVIEW.stretch[0]!.text, "soften");
    const s = A["apply.stretch"](ctx, ...LABS, 1, REVIEW.stretch[1]!.text, "drop");
    expect(s.review!.stretch.map((x) => x.state)).toEqual(["softened", "dropped"]);
    expect(fs.readFileSync(path.join(appDir(root), "resume.md"), "utf8")).toBe("# Alex Example\n\n## Experience\n\n- Supported the retrieval platform at Example Labs\n- Built pipelines\n");
    expect(fs.readdirSync(path.join(appDir(root), ".versions", "resume.md")).length).toBeGreaterThan(0);
    expect(readRecord("job", layout(root).jobFile(...LABS)).timeline.at(-1)).toMatchObject({ event: "Bullet dropped" });
    expect(facts(root)).toBe("");
  });

  it("handles a stretch Claude wrote with its bullet marker and bold marks", () => {
    const { ctx, root } = withResume("## Experience\n\n- Owned **Python** services at Example Labs\n");
    fs.writeFileSync(path.join(appDir(root), "review.json"), JSON.stringify({ stretch: [{ text: "- Owned **Python** services at Example Labs", soften: "Supported **Python** services at Example Labs" }] }));
    const text = A["apply.state"](ctx, ...LABS).review!.stretch[0]!.text;
    expect(text).toBe("Owned **Python** services at Example Labs");
    A["apply.stretch"](ctx, ...LABS, 0, text, "keep");
    expect(facts(root)).toContain("- Owned Python services at Example Labs (confirmed ");
  });

  it("won't soften without a softer wording, or act on a review that changed", () => {
    const { ctx } = withReview();
    expect(() => A["apply.stretch"](ctx, ...LABS, 1, REVIEW.stretch[1]!.text, "soften")).toThrow("didn't suggest a softer wording");
    expect(() => A["apply.stretch"](ctx, ...LABS, 0, "Something else", "keep")).toThrow("Claude's review changed since you opened it.");
  });

  it("Save puts a fact from the note into me/history only on the click", () => {
    const { ctx, root } = withReview();
    expect(facts(root)).toBe("");
    const s = A["apply.saveFact"](ctx, ...LABS, 0, "Mentored 2 graduates in 2025");
    expect(s.review!.facts[0]!.saved).toBe(true);
    expect(facts(root)).toContain("- Mentored 2 graduates in 2025 (confirmed ");
    expect(facts(root)).toContain("your note, ");
  });
});
