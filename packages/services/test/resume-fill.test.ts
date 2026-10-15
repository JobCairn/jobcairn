import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { readRecord, layout, samplePdf } from "@careeros/core";
import { buildActionPrompt, SUGGESTIONS_REL } from "@careeros/contract";
import { dispatch } from "../src/dispatch.js";
import { promptInfo } from "../src/actions.js";
import { copyName, resumeFillHandlers as R, sniffResume } from "../src/resume-fill.js";
import { createWorkspace } from "../src/workspace.js";
import { makeCtx, openSample, tmpDir } from "./helpers.js";

// Fictional resumes only.
const HEADER = ["Alex Example", "1 Example Street, Sampletown NSW 2000", "0491 570 006 | alex@example.com", "linkedin.com/in/alex-example | github.com/alexexample"];

function put(name: string, data: string | Uint8Array): string {
  const p = path.join(tmpDir(), name);
  fs.writeFileSync(p, data);
  return p;
}

/** A minimal .docx: one document part with paragraphs, a tab, and a hyperlink whose address lives in the rels part. */
function docx(paras: string[], link?: { text: string; url: string }): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const p = paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`).join("");
  const h = link ? `<w:p><w:hyperlink r:id="rId9"><w:r><w:t>${esc(link.text)}</w:t></w:r></w:hyperlink></w:p>` : "";
  const doc = `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:r="r"><w:body>${p}${h}</w:body></w:document>`;
  const rels = link ? `<?xml version="1.0"?><Relationships><Relationship Id="rId9" Type="hyperlink" Target="${link.url}" TargetMode="External"/></Relationships>` : "<Relationships/>";
  return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(doc), "word/_rels/document.xml.rels": strToU8(rels) });
}

afterEach(() => { vi.restoreAllMocks(); });

describe("profile.readResume", () => {
  it("reads a PDF without a workspace open", async () => {
    const { ctx } = makeCtx();
    const r = await R["profile.readResume"](ctx, put("Alex resume.pdf", samplePdf(HEADER)));
    expect(r.kind).toBe("pdf");
    expect(r.file).toBe("Alex resume.pdf");
    expect(r.fields).toEqual({
      name: "Alex Example", email: "alex@example.com", phone: "0491 570 006", city: "Sampletown NSW",
      links: ["https://linkedin.com/in/alex-example", "https://github.com/alexexample"],
    });
  }, 30_000);

  it("reads a Word document, keeping hyperlink addresses", async () => {
    const { ctx } = makeCtx();
    const r = await R["profile.readResume"](ctx, put("cv.docx", docx(["ALEX EXAMPLE", "Sampletown NSW • 0491 570 006 • alex@example.com"], { text: "Portfolio", url: "https://alexexample.dev" })));
    expect(r.kind).toBe("word");
    expect(r.fields).toMatchObject({ name: "Alex Example", phone: "0491 570 006", email: "alex@example.com", city: "Sampletown NSW", links: ["https://alexexample.dev"] });
  }, 30_000);

  it("reads Markdown and plain text", async () => {
    const { ctx } = makeCtx();
    const md = await R["profile.readResume"](ctx, put("resume.md", "# Alex Example\n\n**Email:** alex@example.com\n"));
    expect(md).toMatchObject({ kind: "markdown", fields: { name: "Alex Example", email: "alex@example.com" } });
    const txt = await R["profile.readResume"](ctx, put("resume.txt", HEADER.join("\n")));
    expect(txt.kind).toBe("text");
    expect(txt.fields.phone).toBe("0491 570 006");
  });

  it("judges the type by content, not the extension", async () => {
    const { ctx } = makeCtx();
    expect((await R["profile.readResume"](ctx, put("resume.txt", samplePdf(HEADER)))).kind).toBe("pdf");
    expect((await R["profile.readResume"](ctx, put("resume.pdf", HEADER.join("\n")))).kind).toBe("text");
  }, 30_000);

  it("refuses files it can't read, in plain words", async () => {
    const { ctx } = makeCtx();
    await expect(R["profile.readResume"](ctx, put("old.doc", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])))).rejects.toThrow(/older Word file/);
    await expect(R["profile.readResume"](ctx, put("photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])))).rejects.toThrow(/PDF, Word \(\.docx\), Markdown or text/);
    await expect(R["profile.readResume"](ctx, put("empty.txt", ""))).rejects.toThrow(/is empty/);
    await expect(R["profile.readResume"](ctx, put("blank.txt", "  \n \n"))).rejects.toThrow(/no text to read/);
    await expect(R["profile.readResume"](ctx, put("broken.docx", Buffer.from("PK\x03\x04not a zip")))).rejects.toThrow(/can't be read as a Word document/);
    await expect(R["profile.readResume"](ctx, put("other.zip", zipSync({ "a.txt": strToU8("hi") })))).rejects.toThrow(/can't be read as a Word document/);
    await expect(R["profile.readResume"](ctx, put("broken.pdf", "%PDF-1.4\nnot really"))).rejects.toThrow(/PDF/);
  }, 30_000);

  it("refuses a file over 10 MB before reading it", async () => {
    const { ctx } = makeCtx();
    const p = put("big.txt", "");
    fs.truncateSync(p, 10 * 1024 * 1024 + 1);
    await expect(R["profile.readResume"](ctx, p)).rejects.toThrow(/larger than 10 MB/);
  });

  it("refuses links and hidden files", async () => {
    const { ctx } = makeCtx();
    const real = put("resume.txt", HEADER.join("\n"));
    const link = path.join(path.dirname(real), "link.txt");
    fs.symlinkSync(real, link);
    await expect(R["profile.readResume"](ctx, link)).rejects.toThrow(/is a link/);
    const hidden = put(".resume.txt", HEADER.join("\n"));
    await expect(R["profile.readResume"](ctx, hidden)).rejects.toThrow(/Hidden files/);
  });

  it("never logs the resume's text", async () => {
    const { ctx } = makeCtx();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await R["profile.readResume"](ctx, put("r.pdf", samplePdf(HEADER)));
    await R["profile.readResume"](ctx, put("r.docx", docx(HEADER)));
    await expect(R["profile.readResume"](ctx, put("bad.pdf", "%PDF-1.4 alex@example.com"))).rejects.toThrow();
    const said = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    expect(said).not.toMatch(/alex@example\.com|0491 570 006|Alex Example/);
  }, 30_000);

  it("is checked by the dispatcher", async () => {
    const { ctx } = makeCtx();
    await expect(dispatch(ctx, "profile.readResume", ["relative.pdf"])).rejects.toThrow(/absolute path/);
  });
});

describe("profile.fillFromResume", () => {
  const fresh = () => {
    const x = makeCtx();
    createWorkspace(x.ctx, path.join(tmpDir(), "CareerOS"), "");
    return { ...x, root: x.ctx.requireRoot() };
  };

  it("fills an empty profile, copies the resume into me/resumes with a text copy, and records it", async () => {
    const { ctx, root } = fresh();
    const src = put("Alex Example résumé.pdf", samplePdf(HEADER));
    const before = fs.readFileSync(src);
    const { fields } = await R["profile.readResume"](ctx, src);
    const s = await dispatch(ctx, "profile.fillFromResume", [src, fields, []]) as Awaited<ReturnType<typeof R["profile.fillFromResume"]>>;
    expect(s).toMatchObject({ file: "Alex Example résumé.pdf", kind: "pdf", filled: ["name", "email", "phone", "city", "links"], kept: [], seen: false });
    const c = readRecord("profile", layout(root).profile).contact;
    expect(c).toMatchObject({ name: "Alex Example", email: "alex@example.com", phone: "0491 570 006", city: "Sampletown NSW" });
    expect(c.links).toEqual(["https://linkedin.com/in/alex-example", "https://github.com/alexexample"]);
    const files = fs.readdirSync(path.join(root, "me", "resumes")).sort();
    expect(files).toEqual(["Alex Example resume (text).txt", "Alex Example resume.pdf"]);
    expect(fs.readFileSync(path.join(root, "me", "resumes", "Alex Example resume.pdf"))).toEqual(before);
    expect(fs.statSync(path.join(root, "me", "resumes", "Alex Example resume.pdf")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(root, "me", "resumes", "Alex Example resume (text).txt"), "utf8")).toContain("alex@example.com");
    expect(fs.readFileSync(src)).toEqual(before); // the original isn't touched
    expect(R["profile.fillState"](ctx)).toEqual(s);
    // Claude's suggestion step reads exactly that text copy.
    const info = promptInfo(root, { kind: "workspace" });
    expect(info.resume).toBe("me/resumes/Alex Example resume (text).txt");
    expect(buildActionPrompt("suggest_targets", { kind: "workspace" }, info)).toContain("me/resumes/Alex Example resume (text).txt only");
  }, 30_000);

  it("never overwrites a value silently: only listed fields replace what is there", async () => {
    const { ctx, root } = openSample(); // contact already filled
    const src = put("cv.txt", "Alex Example\nalex.work@example.com\n0491 570 006\nToronto, ON\n");
    const values = { name: "Alex Example", email: "alex.work@example.com", phone: "0491 570 006", city: "Toronto, ON" };
    const kept = await R["profile.fillFromResume"](ctx, src, values, []);
    expect(kept.kept.sort()).toEqual(["city", "email"]);
    expect(readRecord("profile", layout(root).profile).contact).toMatchObject({ email: "alex@example.com", city: "Sampletown NSW" });
    const used = await R["profile.fillFromResume"](ctx, src, values, ["email"]);
    expect(used.filled).toContain("email");
    expect(used.kept).toEqual(["city"]);
    expect(readRecord("profile", layout(root).profile).contact.email).toBe("alex.work@example.com");
    // A second copy gets its own name; nothing is overwritten.
    expect(fs.readdirSync(path.join(root, "me", "resumes")).filter((n) => n.startsWith("cv"))).toEqual(["cv-2.txt", "cv.txt"]);
  });

  it("saves nothing for a field left out or emptied on the review form, and never touches work rights", async () => {
    const { ctx, root } = fresh();
    const before = readRecord("profile", layout(root).profile).work_rights;
    const s = await R["profile.fillFromResume"](ctx, put("r.md", "# Alex Example\n"), { name: "  ", email: "alex@example.com" }, []);
    expect(s.filled).toEqual(["email"]);
    const p = readRecord("profile", layout(root).profile);
    expect(p.contact.name).toBe("");
    expect(p.work_rights).toEqual(before);
  });

  it("marks the notice seen", async () => {
    const { ctx } = fresh();
    expect(R["profile.fillState"](ctx)).toBeNull();
    await R["profile.fillFromResume"](ctx, put("r.txt", "Alex Example\n"), { name: "Alex Example" }, []);
    expect(R["profile.markFillSeen"](ctx)?.seen).toBe(true);
    expect(R["profile.fillState"](ctx)?.seen).toBe(true);
  });

  it("needs an open workspace to save", async () => {
    const { ctx } = makeCtx();
    await expect(R["profile.fillFromResume"](ctx, put("r.txt", "Alex Example"), {}, [])).rejects.toThrow(/No workspace/);
  });
});

describe("profile.suggestions", () => {
  it("reads Claude's suggestions file, cleaned", () => {
    const { ctx, root } = openSample();
    expect(R["profile.suggestions"](ctx)).toBeNull();
    const abs = path.join(root, ...SUGGESTIONS_REL.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify({ roles: ["Data Analyst", "BI Developer"], keywords: ["SQL"], seniority: "Mid-level" }));
    expect(R["profile.suggestions"](ctx)).toMatchObject({ roles: ["Data Analyst", "BI Developer"], keywords: ["SQL"], seniority: "Mid-level" });
    fs.writeFileSync(abs, "not json");
    expect(R["profile.suggestions"](ctx)).toBeNull();
  });

  it("ignores a link in its place", () => {
    const { ctx, root } = openSample();
    const abs = path.join(root, ...SUGGESTIONS_REL.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const outside = put("x.json", JSON.stringify({ roles: ["Data Analyst"] }));
    fs.symlinkSync(outside, abs);
    expect(R["profile.suggestions"](ctx)).toBeNull();
  });
});

describe("helpers", () => {
  it("names copies plainly", () => {
    expect(copyName("Alex Example résumé.PDF", "pdf")).toBe("Alex Example resume.pdf");
    expect(copyName("../../.hidden", "text")).toBe("resume.txt");
    expect(copyName("簡歷.docx", "word")).toBe("resume.docx");
  });

  it("sniffs by content", () => {
    expect(sniffResume(Buffer.from("%PDF-1.7"), "x")).toBe("pdf");
    expect(sniffResume(Buffer.from("# Alex Example"), "x")).toBe("markdown");
    expect(sniffResume(Buffer.from("Alex Example"), "x")).toBe("text");
  });
});
