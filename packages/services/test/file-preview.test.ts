import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { samplePdf } from "@careeros/core";
import { PREVIEW_LIMITS } from "@careeros/contract";
import { dispatch } from "../src/dispatch.js";
import { filePreviewHandlers as P } from "../src/file-preview.js";
import { openSample } from "./helpers.js";

// Fictional files only.
function docx(paras: string[]): Uint8Array {
  const p = paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join("");
  const doc = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${p}</w:body></w:document>`;
  return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(doc), "word/_rels/document.xml.rels": strToU8("<Relationships/>") });
}

function put(root: string, rel: string, data: string | Uint8Array): void {
  const p = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

const JOB = "companies/example-labs/jobs/2026-01-12-backend-engineer-llm/application";

describe("files.preview", () => {
  it("returns Markdown text with its size and date", async () => {
    const { ctx } = openSample();
    const r = await P["files.preview"](ctx, "learning/rag-pipelines/guide.md");
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.kind).toBe("markdown");
    expect(r.text).toContain("Chunk the documents");
    expect(r.size).toBeGreaterThan(0);
    expect(r.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reads a Word file's text in the isolated reader", async () => {
    const { ctx, root } = openSample();
    put(root, `${JOB}/cover-letter.docx`, docx(["Dear hiring team at Acme Corp,", "I build retrieval systems."]));
    const r = await P["files.preview"](ctx, `${JOB}/cover-letter.docx`);
    expect(r).toMatchObject({ state: "ready", kind: "word" });
    expect(r.state === "ready" && r.text).toContain("Acme Corp");
  }, 30_000);

  it("says a PDF is ready without sending its bytes (the file scheme serves it)", async () => {
    const { ctx, root } = openSample();
    put(root, `${JOB}/resume.pdf`, samplePdf(["Alex Example"]));
    expect(await P["files.preview"](ctx, `${JOB}/resume.pdf`)).toMatchObject({ state: "ready", kind: "pdf", text: null });
  });

  it("never reads a locked folder, and doesn't even say whether the file is there", async () => {
    const { ctx, root } = openSample();
    put(root, "me/identity/passport.md", "fictional passport");
    expect(await P["files.preview"](ctx, "me/identity/passport.md")).toEqual({ state: "locked", kind: "markdown", folder: "me/identity" });
    expect(await P["files.preview"](ctx, "me/identity/nothing-here.pdf")).toEqual({ state: "locked", kind: "pdf", folder: "me/identity" });
    expect(await P["files.preview"](ctx, "me/employment/payslip.pdf")).toEqual({ state: "locked", kind: "pdf", folder: "me/employment" });
  });

  it("follows a link into a locked folder and stays locked", async () => {
    const { ctx, root } = openSample();
    put(root, "me/identity/passport.md", "fictional passport");
    fs.symlinkSync(path.join(root, "me", "identity", "passport.md"), path.join(root, "learning", "rag-pipelines", "notes.md"));
    const r = await P["files.preview"](ctx, "learning/rag-pipelines/notes.md");
    expect(r).toEqual({ state: "locked", kind: "markdown", folder: "me/identity" });
  });

  it("caps text at the preview limit and refuses kinds it can't show", async () => {
    const { ctx, root } = openSample();
    put(root, `${JOB}/huge.md`, "x".repeat(PREVIEW_LIMITS.text + 1));
    expect(await P["files.preview"](ctx, `${JOB}/huge.md`)).toMatchObject({ state: "too_large", kind: "markdown", limit: PREVIEW_LIMITS.text });
    put(root, `${JOB}/notes.pages`, "fictional");
    expect(await P["files.preview"](ctx, `${JOB}/notes.pages`)).toMatchObject({ state: "unsupported", kind: "other", reason: "kind" });
    put(root, `${JOB}/old.doc`, "fictional");
    expect(await P["files.preview"](ctx, `${JOB}/old.doc`)).toMatchObject({ state: "unsupported", reason: "old_word" });
  });

  it("reports a missing file, and refuses dot segments and escapes without quoting the path", async () => {
    const { ctx } = openSample();
    expect(await P["files.preview"](ctx, `${JOB}/gone.md`)).toEqual({ state: "missing", kind: "markdown" });
    for (const rel of ["../outside.md", "settings/.env", "/etc/hosts", "a\\b.md"]) {
      await expect(P["files.preview"](ctx, rel)).rejects.toThrow("This file isn't available to the app.");
    }
  });

  it("is reachable through dispatch with argument checks", async () => {
    const { ctx } = openSample();
    await expect(dispatch(ctx, "files.preview", ["learning/rag-pipelines/guide.md"])).resolves.toMatchObject({ state: "ready" });
  });
});

describe("files.open", () => {
  it("opens a document in its default app", async () => {
    const { ctx, root, host } = openSample();
    const shell = host.shell;
    put(root, `${JOB}/resume.pdf`, samplePdf(["Alex Example"]));
    await P["files.open"](ctx, `${JOB}/resume.pdf`);
    expect(shell.openedPaths).toHaveLength(1);
    expect(shell.openedPaths[0]).toMatch(/resume\.pdf$/);
  });

  it("never opens an app or a script, or a locked file", async () => {
    const { ctx, root, host } = openSample();
    const shell = host.shell;
    put(root, "inbox/run-me.command", "echo fictional");
    await expect(P["files.open"](ctx, "inbox/run-me.command")).rejects.toThrow(/can't be opened from the app/);
    put(root, "me/identity/passport.pdf", samplePdf(["fictional"]));
    await expect(P["files.open"](ctx, "me/identity/passport.pdf")).rejects.toThrow(/locked folder/);
    expect(shell.openedPaths).toEqual([]);
  });
});
