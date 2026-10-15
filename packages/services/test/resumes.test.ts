import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { actionPaths, buildActionPrompt, DEFAULT_RESUME_STYLE, type ResumeLibrary, type ResumeState } from "@careeros/contract";
import { dispatch } from "../src/dispatch.js";
import { openSample } from "./helpers.js";

const MD = "# Alex Example\n\n## Summary\n\nBackend engineer.\n";

function setup() {
  const s = openSample();
  const call = <T>(m: string, ...args: unknown[]) => dispatch(s.ctx, m, args) as Promise<T>;
  return { ...s, call };
}

describe("Resumes: general versions", () => {
  it("makes a version's folder outside me/, lists it as not written yet, then ready once Claude writes it", async () => {
    const x = setup();
    const { variant } = await x.call<{ variant: string }>("resumes.newVariant", "Backend-heavy");
    expect(variant).toBe("backend-heavy");
    const dir = path.join(x.root, "resume-variants", variant);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "variant.json"), "utf8"))).toEqual({ name: "Backend-heavy", created_at: "2026-01-15T09:00:00.000Z" });
    // A second one with the same name gets its own folder.
    expect((await x.call<{ variant: string }>("resumes.newVariant", "Backend heavy")).variant).toBe("backend-heavy-2");

    let lib = await x.call<ResumeLibrary>("resumes.list");
    expect(lib.variants.find((v) => v.variant === "backend-heavy")).toMatchObject({ name: "Backend-heavy", ready: false });
    await expect(x.call("resume.load", { kind: "variant", variant }, "resume.md")).rejects.toThrow(/hasn't written this version yet/);

    fs.writeFileSync(path.join(dir, "resume.md"), MD);
    lib = await x.call<ResumeLibrary>("resumes.list");
    expect(lib.variants.find((v) => v.variant === "backend-heavy")).toMatchObject({ ready: true });
  });

  it("opens, saves, versions and copies a general version in Resume Studio; Claude's suggestions are for jobs only", async () => {
    const x = setup();
    const { variant } = await x.call<{ variant: string }>("resumes.newVariant", "For consulting firms");
    fs.writeFileSync(path.join(x.root, "resume-variants", variant, "resume.md"), MD);
    const ref = { kind: "variant", variant };
    const s0 = await x.call<ResumeState>("resume.load", ref, "resume.md");
    expect(s0).toMatchObject({ ref, title: "For consulting firms", company_name: "", suggestion: null });
    const s1 = await x.call<ResumeState>("resume.save", ref, "resume.md", `${MD}\nMore.\n`, DEFAULT_RESUME_STYLE, s0.digest, false);
    expect(s1.markdown).toContain("More.");
    expect(s1.versions.map((v) => v.kind)).toEqual(["original"]);
    await expect(x.call("resume.suggestion", ref, "resume.md", "accept", s1.digest)).rejects.toThrow(/for a job's tailored resume/);
    expect(await x.call("resume.copy", ref, "resume.md", "md")).toBe(true);
  });

  it("refuses a version name with odd characters, and a folder that isn't a version", async () => {
    const x = setup();
    await expect(x.call("resumes.newVariant", "Bad\nname")).rejects.toThrow();
    await expect(x.call("resumes.newVariant", "<script>")).rejects.toThrow(/invalid format/);
    await expect(x.call("resume.load", { kind: "variant", variant: "../me" }, "resume.md")).rejects.toThrow(/invalid format/);
    await expect(x.call("resume.load", { kind: "variant", variant: "missing" }, "resume.md")).rejects.toThrow(/isn't there any more/);
  });

  it("lists the base resume (not its text copy) and each job's tailored resume", async () => {
    const x = setup();
    fs.mkdirSync(path.join(x.root, "me/resumes"), { recursive: true });
    fs.writeFileSync(path.join(x.root, "me/resumes/Alex Example resume.pdf"), "%PDF-1.4");
    fs.writeFileSync(path.join(x.root, "me/resumes/Alex Example resume (text).txt"), "text");
    const app = path.join(x.root, "companies/acme-corp/jobs/2026-01-12-ai-engineer/application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), MD);
    const lib = await x.call<ResumeLibrary>("resumes.list");
    expect(lib.base.map((b) => b.rel)).toEqual(["me/resumes/Alex Example resume.pdf"]);
    expect(lib.tailored).toEqual([expect.objectContaining({ company_slug: "acme-corp", id: "2026-01-12-ai-engineer", title: "AI Engineer", company_name: "Acme Corp" })]);
  });

  it("the version prompt writes only into its own folder and never reads other versions as evidence", () => {
    const t = { kind: "resume_variant", variant: "backend-heavy", label: "Backend-heavy" } as const;
    expect(actionPaths("tailor_resume_variant", t, {}).outputs).toEqual(["resume-variants/backend-heavy/resume.md"]);
    const p = buildActionPrompt("tailor_resume_variant", t, {}, null, "0123456789abcdef");
    expect(p).toContain('Resume version: "Backend-heavy" (folder resume-variants/backend-heavy).');
    expect(p).toContain("Don't read other folders in resume-variants");
    expect(p).toContain("- resume-variants/backend-heavy/resume.md");
  });
});

describe("Resumes: duplicate and remove", () => {
  it("copies a general version with its style, and a base Markdown file, into new general versions", async () => {
    const x = setup();
    const { variant } = await x.call<{ variant: string }>("resumes.newVariant", "Backend-heavy");
    const ref = { kind: "variant", variant };
    fs.writeFileSync(path.join(x.root, "resume-variants", variant, "resume.md"), MD);
    const s0 = await x.call<ResumeState>("resume.load", ref, "resume.md");
    await x.call("resume.save", ref, "resume.md", MD, { ...DEFAULT_RESUME_STYLE, layout: "modern", accent: "teal" }, s0.digest, false);
    const copy = await x.call<{ variant: string }>("resumes.duplicate", ref, "Backend copy");
    const c = await x.call<ResumeState>("resume.load", { kind: "variant", variant: copy.variant }, "resume.md");
    expect(c.markdown).toBe(MD);
    expect(c.style).toMatchObject({ layout: "modern", accent: "teal" });

    const me = path.join(x.root, "me", "resumes");
    fs.mkdirSync(me, { recursive: true });
    fs.writeFileSync(path.join(me, "alex-example.md"), MD);
    const fromBase = await x.call<{ variant: string }>("resumes.duplicate", { kind: "base", rel: "me/resumes/alex-example.md" }, "From my own");
    expect(fs.readFileSync(path.join(x.root, "resume-variants", fromBase.variant, "resume.md"), "utf8")).toBe(MD);
    // Only names directly in me/resumes.
    await expect(x.call("resumes.duplicate", { kind: "base", rel: "me/identity/passport.md" }, "Nope")).rejects.toThrow();
    await expect(x.call("resumes.duplicate", { kind: "base", rel: "me/resumes/../identity/x.md" }, "Nope")).rejects.toThrow();
  });

  it("moves a general version's folder or a base file to Recently deleted", async () => {
    const x = setup();
    const { variant } = await x.call<{ variant: string }>("resumes.newVariant", "Old");
    fs.writeFileSync(path.join(x.root, "resume-variants", variant, "resume.md"), MD);
    expect(await x.call("resumes.remove", { kind: "variant", variant })).toMatchObject({ kind: "resume", title: "Old" });
    expect(fs.existsSync(path.join(x.root, "resume-variants", variant))).toBe(false);
    expect((await x.call<ResumeLibrary>("resumes.list")).variants.find((v) => v.variant === variant)).toBeUndefined();
    const me = path.join(x.root, "me", "resumes");
    fs.mkdirSync(me, { recursive: true });
    fs.writeFileSync(path.join(me, "old.md"), MD);
    expect(await x.call("resumes.remove", { kind: "base", rel: "me/resumes/old.md" })).toMatchObject({ kind: "resume", title: "old.md" });
    expect((await x.call<{ title: string }[]>("trash.list")).map((e) => e.title)).toEqual(["old.md", "Old"]);
    expect(fs.existsSync(path.join(me, "old.md"))).toBe(false);
    await expect(x.call("resumes.remove", { kind: "base", rel: "me/resumes/old.md" })).rejects.toThrow(/isn't there any more/);
  });
});
