import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allowAccessRequest, layout, requestAccess } from "@careeros/core";
import { checkIncomingFile, copyIncoming, fileHandlers as F, MAX_TEXT_BYTES, resolveWorkspaceFile } from "../src/files.js";
import { inboxHandlers as I } from "../src/inbox.js";
import { learnHandlers } from "../src/learn.js";
import { jobDetail } from "../src/read.js";
import { openSample, tmpDir } from "./helpers.js";

function downloads() {
  const dir = tmpDir();
  const file = (name: string, text = "fictional") => { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  return { dir, file };
}

function messageOf(fn: () => unknown): string {
  try { fn(); } catch (e) { return (e as Error).message; }
  return "(no error)";
}

describe("reading workspace files (Review Focus 1)", () => {
  it("reads normal files", async () => {
    const { ctx } = openSample();
    expect(await F["files.readText"](ctx, "learning/rag-pipelines/guide.md")).toContain("Chunk the documents");
  });
  it("refuses dot segments, escapes and locked folders", () => {
    const { ctx, root } = openSample();
    fs.mkdirSync(path.join(root, "me", "identity", "visa"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "identity", "visa", "grant.md"), "fictional grant");
    for (const rel of ["settings/.env", ".claude/settings.json", ".careeros/activity.jsonl", "../outside.md", "learning/../../x", "/etc/hosts", "learning\\guide.md", "learning//guide.md"]) {
      expect(messageOf(() => resolveWorkspaceFile(ctx, rel, "read")), rel).toBe(`"${rel}" isn't available to the app.`);
    }
    expect(() => resolveWorkspaceFile(ctx, "me/identity/visa/grant.md", "read")).toThrow(/me\/identity is locked/);
  });
  it("follows symlinks before deciding", () => {
    const { ctx, root } = openSample();
    const outside = downloads().file("secret.md");
    fs.symlinkSync(outside, path.join(root, "learning", "rag-pipelines", "escape.md"));
    expect(messageOf(() => resolveWorkspaceFile(ctx, "learning/rag-pipelines/escape.md", "read"))).toBe('"learning/rag-pipelines/escape.md" points outside the workspace.');
    fs.mkdirSync(path.join(root, "me", "identity"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "identity", "passport.md"), "fictional passport");
    fs.symlinkSync(path.join(root, "me", "identity", "passport.md"), path.join(root, "learning", "rag-pipelines", "notes.md"));
    expect(() => resolveWorkspaceFile(ctx, "learning/rag-pipelines/notes.md", "read")).toThrow(/me\/identity is locked/);
  });
  it("refuses a hard link (a second name for a file, maybe one in a locked folder) for reading and media", () => {
    const { ctx, root } = openSample();
    fs.mkdirSync(path.join(root, "me", "identity"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "identity", "passport.md"), "fictional passport");
    fs.writeFileSync(path.join(root, "me", "identity", "scan.png"), "fictional scan");
    fs.linkSync(path.join(root, "me", "identity", "passport.md"), path.join(root, "learning", "rag-pipelines", "notes.md"));
    fs.linkSync(path.join(root, "me", "identity", "scan.png"), path.join(root, "learning", "rag-pipelines", "diagram.png"));
    expect(messageOf(() => F["files.readText"](ctx, "learning/rag-pipelines/notes.md"))).toBe('"learning/rag-pipelines/notes.md" is linked to another file, so the app won\'t open it.');
    expect(messageOf(() => resolveWorkspaceFile(ctx, "learning/rag-pipelines/diagram.png", "media"))).toBe('"learning/rag-pipelines/diagram.png" is linked to another file, so the app won\'t open it.');
    // Revealing it in the file manager is still the person's own action.
    expect(resolveWorkspaceFile(ctx, "learning/rag-pipelines/notes.md", "reveal")).toContain("notes.md");
  });
  const caseInsensitive = (() => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "probe"), "");
    return fs.existsSync(path.join(dir, "PROBE"));
  })();
  it.skipIf(!caseInsensitive)("refuses a differently-cased path into a locked folder (case-insensitive disks)", () => {
    const { ctx, root } = openSample();
    fs.writeFileSync(path.join(root, "me", "identity", "passport.md"), "fictional passport");
    expect(() => resolveWorkspaceFile(ctx, "ME/Identity/passport.md", "read")).toThrow(/me\/identity is locked/);
    expect(() => resolveWorkspaceFile(ctx, "me/IDENTITY/passport.md", "media")).toThrow(/me\/identity is locked/);
  });
  it("opens a locked folder only while a grant is open", () => {
    const { ctx, root } = openSample();
    fs.writeFileSync(path.join(root, "me", "identity", "passport.md"), "fictional passport");
    allowAccessRequest(root, requestAccess(root, { folder: "me/identity", why: "Need a passport date" }, ctx.clock()).id, 15, ctx.clock());
    expect(resolveWorkspaceFile(ctx, "me/identity/passport.md", "read")).toBe(path.join(root, "me", "identity", "passport.md"));
  });
  it("reveals files and folders, but never outside the workspace", () => {
    const { ctx, root, host } = openSample();
    F["files.reveal"](ctx, "companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md");
    expect(host.shell.shown).toEqual([path.join(root, "companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md")]);
    expect(() => F["files.reveal"](ctx, "settings/.env")).toThrow(/isn't available/);
  });
  it("refuses text files over 2 MB", () => {
    const { ctx, root } = openSample();
    const big = path.join(root, "learning", "rag-pipelines", "huge.md");
    fs.writeFileSync(big, "# Huge\n");
    fs.truncateSync(big, MAX_TEXT_BYTES + 1);
    expect(() => F["files.readText"](ctx, "learning/rag-pipelines/huge.md")).toThrow('"learning/rag-pipelines/huge.md" can\'t be shown as text.');
    fs.truncateSync(big, MAX_TEXT_BYTES);
    expect(F["files.readText"](ctx, "learning/rag-pipelines/huge.md")).toContain("# Huge");
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("wraps raw fs errors in a plain message without absolute paths", () => {
    const { ctx, root } = openSample();
    const f = path.join(root, "learning", "rag-pipelines", "guide.md");
    fs.chmodSync(f, 0o000);
    try {
      const msg = messageOf(() => F["files.readText"](ctx, "learning/rag-pipelines/guide.md"));
      expect(msg).toBe('"learning/rag-pipelines/guide.md" can\'t be read.');
      expect(msg).not.toContain(root);
    } finally { fs.chmodSync(f, 0o644); }
  });
  it("refuses media that isn't media", () => {
    const { ctx } = openSample();
    expect(() => resolveWorkspaceFile(ctx, "learning/rag-pipelines/guide.md", "media")).toThrow(/can't be shown/);
  });
});

describe("files coming in (Review Focus 1)", () => {
  it("accepts a normal file and copies it into the inbox", async () => {
    const { ctx, root } = openSample();
    const src = downloads().file("Visa_Grant_Notice.pdf");
    const items = await I["inbox.add"](ctx, [src]);
    expect(items.map((i) => i.name)).toEqual(["Visa_Grant_Notice.pdf"]);
    expect(items[0]?.suggestion.target).toEqual({ kind: "me", dir: "identity", sub: "visa" });
    expect(fs.existsSync(src)).toBe(true);
    await I["inbox.add"](ctx, [src]);
    expect(fs.readdirSync(layout(root).inbox).sort()).toEqual(["Visa_Grant_Notice-2.pdf", "Visa_Grant_Notice.pdf", "_filed.md"]);
  });
  it("refuses hidden files, hidden folders, links, folders, big files and files already in the workspace", () => {
    const { root } = openSample();
    const d = downloads();
    const big = d.file("big.pdf");
    fs.truncateSync(big, 26 * 1024 * 1024);
    const link = path.join(d.dir, "link.pdf");
    fs.symlinkSync(d.file("real.pdf"), link);
    fs.mkdirSync(path.join(d.dir, "folder.pdf"));
    const cases: [string, RegExp][] = [
      [d.file(".env"), /Hidden/], [d.file(".ssh/id_rsa"), /Hidden/], [link, /link/], [path.join(d.dir, "folder.pdf"), /regular file/],
      [big, /25 MB/], [path.join(root, "learning", "rag-pipelines", "guide.md"), /already in your workspace/], [path.join(d.dir, "missing.pdf"), /can't be found/],
    ];
    for (const [p, re] of cases) expect(() => checkIncomingFile(root, p), p).toThrow(re);
  });
  it("refuses a file reached through a linked folder into a hidden one", () => {
    const { ctx, root } = openSample();
    const base = tmpDir();
    fs.mkdirSync(path.join(base, ".ssh"));
    fs.writeFileSync(path.join(base, ".ssh", "id_rsa"), "fictional key");
    fs.mkdirSync(path.join(base, "Downloads"));
    fs.symlinkSync(path.join(base, ".ssh"), path.join(base, "Downloads", "keys"));
    expect(() => I["inbox.add"](ctx, [path.join(base, "Downloads", "keys", "id_rsa")])).toThrow('Hidden files and folders can\'t be added ("id_rsa").');
    expect(fs.readdirSync(layout(root).inbox)).toEqual(["_filed.md"]);
  });
  it("refuses hard-linked files", () => {
    const { root } = openSample();
    const d = downloads();
    const a = d.file("a.pdf");
    fs.linkSync(a, path.join(d.dir, "b.pdf"));
    expect(() => checkIncomingFile(root, a)).toThrow('"a.pdf" is linked to another file. Add a plain copy instead.');
  });
  it.skipIf(process.platform === "win32")("refuses a FIFO without hanging, at the check and at the copy", () => {
    const { root } = openSample();
    const d = downloads();
    const fifo = path.join(d.dir, "pipe.pdf");
    execFileSync("mkfifo", [fifo]);
    expect(() => checkIncomingFile(root, fifo)).toThrow(/isn't a regular file/);
    const st = fs.lstatSync(fifo);
    const dest = path.join(tmpDir(), "out.pdf");
    expect(() => copyIncoming({ abs: fifo, name: "pipe.pdf", size: 0, dev: st.dev, ino: st.ino }, dest)).toThrow(/changed after it was checked/);
    expect(fs.existsSync(dest)).toBe(false);
  });
  it("refuses to copy a file that was swapped after the check", () => {
    const { root } = openSample();
    const d = downloads();
    const src = d.file("cv.pdf");
    const checked = checkIncomingFile(root, src);
    const outDir = tmpDir();
    // Swapped for a symlink: O_NOFOLLOW refuses to open it.
    fs.rmSync(src);
    fs.symlinkSync(d.file("other.pdf", "something else"), src);
    expect(() => copyIncoming(checked, path.join(outDir, "cv.pdf"))).toThrow('"cv.pdf" changed after it was checked. Add it again.');
    // Swapped for a different regular file: dev/ino no longer match. Keep the old inode
    // alive (Linux reuses a freed inode number at once) so the new file can't inherit it.
    fs.renameSync(src, `${src}.old`);
    d.file("cv.pdf", "replaced");
    expect(() => copyIncoming(checked, path.join(outDir, "cv.pdf"))).toThrow(/changed after it was checked/);
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
  it("copies exclusively and leaves no partial file when the destination exists", () => {
    const { root } = openSample();
    const d = downloads();
    const checked = checkIncomingFile(root, d.file("cv.pdf", "new"));
    const outDir = tmpDir();
    fs.writeFileSync(path.join(outDir, "cv.pdf"), "old");
    expect(() => copyIncoming(checked, path.join(outDir, "cv.pdf"))).toThrow('"cv.pdf" can\'t be created.');
    expect(fs.readFileSync(path.join(outDir, "cv.pdf"), "utf8")).toBe("old");
    copyIncoming(checked, path.join(outDir, "cv-2.pdf"));
    expect(fs.readFileSync(path.join(outDir, "cv-2.pdf"), "utf8")).toBe("new");
  });
  it("refuses an inbox that was replaced by a link to a folder outside", () => {
    const { ctx, root } = openSample();
    const outside = tmpDir();
    fs.rmSync(layout(root).inbox, { recursive: true });
    fs.symlinkSync(outside, layout(root).inbox);
    expect(() => I["inbox.add"](ctx, [downloads().file("cv.pdf")])).toThrow("inbox/ isn't a real folder, so nothing was added.");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it("adds nothing when one dropped file is bad", () => {
    const { ctx, root } = openSample();
    const d = downloads();
    expect(() => I["inbox.add"](ctx, [d.file("ok.pdf"), d.file(".hidden.pdf")])).toThrow(/Hidden/);
    expect(fs.readdirSync(layout(root).inbox)).toEqual(["_filed.md"]);
  });
  it("files inbox items into me/ and into jobs", async () => {
    const { ctx, root } = openSample();
    const d = downloads();
    await I["inbox.add"](ctx, [d.file("Visa_Grant_Notice.pdf"), d.file("acme-corp-cover-letter.pdf")]);
    await I["inbox.file"](ctx, "Visa_Grant_Notice.pdf", { kind: "me", dir: "identity", sub: "visa" }, "");
    expect(fs.existsSync(path.join(root, "me", "identity", "visa", "Visa_Grant_Notice.pdf"))).toBe(true);
    const left = await I["inbox.file"](ctx, "acme-corp-cover-letter.pdf", { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer", subdir: "application" }, "Sent version");
    expect(left).toEqual([]);
    expect(fs.existsSync(path.join(layout(root).jobDir("acme-corp", "2026-01-12-ai-engineer"), "application", "acme-corp-cover-letter.pdf"))).toBe(true);
    expect(() => I["inbox.file"](ctx, "../workspace.json", { kind: "me", dir: "resumes" }, "")).toThrow(/not an inbox file name/);
  });
  it("attaches files with the same checks", () => {
    const { ctx, root } = openSample();
    const d = downloads();
    const detail = I["jobs.attach"](ctx, "acme-corp", "2026-01-12-ai-engineer", d.file("offer.pdf"), "Offer", "emails");
    expect(detail.files.at(-1)).toMatchObject({ path: "emails/offer.pdf", label: "Offer", exists: true });
    const before = I["jobs.attach"](ctx, "acme-corp", "2026-01-12-ai-engineer", d.file("note.pdf"), "Note", "").files;
    const jobDir = layout(root).jobDir("acme-corp", "2026-01-12-ai-engineer");
    const listing = () => fs.readdirSync(jobDir, { recursive: true }).map(String).sort();
    const onDisk = listing();
    expect(() => I["jobs.attach"](ctx, "acme-corp", "2026-01-12-ai-engineer", d.file(".env"), "x", "")).toThrow(/Hidden/);
    const a = d.file("a.pdf");
    fs.linkSync(a, path.join(d.dir, "a-link.pdf"));
    expect(() => I["jobs.attach"](ctx, "acme-corp", "2026-01-12-ai-engineer", a, "x", "emails")).toThrow(/linked to another file/);
    expect(listing()).toEqual(onDisk);
    expect(jobDetail(root, "acme-corp", "2026-01-12-ai-engineer").files).toEqual(before);
    expect(fs.readdirSync(path.join(root, ".careeros", "tmp"))).toEqual([]);
  });
  it("refuses an unknown attach folder before touching the disk", () => {
    const { ctx, root } = openSample();
    const jobDir = layout(root).jobDir("acme-corp", "2026-01-12-ai-engineer");
    const listing = () => fs.readdirSync(jobDir, { recursive: true }).map(String).sort();
    const onDisk = listing();
    for (const bad of ["../../../escape", "notes", "/tmp"]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => I["jobs.attach"](ctx, "acme-corp", "2026-01-12-ai-engineer", downloads().file("offer.pdf"), "Offer", bad as any))
        .toThrow(`unknown subdir "${bad}"`);
    }
    expect(listing()).toEqual(onDisk);
    expect(fs.existsSync(path.join(root, "escape"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".careeros", "tmp"))).toBe(false);
  });
  it("refuses to attach into a linked job folder", () => {
    const { ctx, root } = openSample();
    const outside = tmpDir();
    const emails = path.join(layout(root).jobDir("acme-corp", "2026-01-12-ai-engineer"), "emails");
    fs.rmSync(emails, { recursive: true, force: true });
    fs.symlinkSync(outside, emails);
    expect(() => I["jobs.attach"](ctx, "acme-corp", "2026-01-12-ai-engineer", downloads().file("offer.pdf"), "Offer", "emails"))
      .toThrow("companies/acme-corp/jobs/2026-01-12-ai-engineer/emails isn't a real folder, so nothing was added.");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it("asks the shell for a file", async () => {
    const { ctx } = openSample({ files: ["/fictional/alex-example/Downloads/cv.pdf"] });
    expect(await F["files.pick"](ctx)).toBe("/fictional/alex-example/Downloads/cv.pdf");
  });
});

describe("learn", () => {
  it("lists topics, videos and interview prep, and skips linked folders", () => {
    const { ctx, root } = openSample();
    fs.writeFileSync(path.join(root, "learning", "rag-pipelines", "demo.mp4"), "");
    fs.symlinkSync(tmpDir(), path.join(root, "learning", "linked"));
    const d = learnHandlers["learn.list"](ctx);
    expect(d.topics).toEqual([{
      slug: "rag-pipelines", title: "RAG pipelines",
      items: [{ path: "learning/rag-pipelines/demo.mp4", title: "demo.mp4", kind: "video" }, { path: "learning/rag-pipelines/guide.md", title: "RAG pipelines", kind: "guide" }],
    }]);
    expect(d.interviewPrep).toEqual([{
      company_slug: "acme-corp", id: "2026-01-12-ai-engineer", title: "AI Engineer", company_name: "Acme Corp",
      items: [{ path: "companies/acme-corp/jobs/2026-01-12-ai-engineer/interview/questions.md", title: "Interview prep: Acme Corp", kind: "guide" }],
    }]);
  });
  it("never lists or reads titles from an interview folder linked into a locked area", () => {
    const { ctx, root } = openSample();
    fs.writeFileSync(path.join(root, "me", "identity", "passport.md"), "# Fictional passport details\n");
    fs.symlinkSync(path.join(root, "me", "identity"), path.join(layout(root).jobDir("example-labs", "2026-01-12-backend-engineer-llm"), "interview"));
    const d = learnHandlers["learn.list"](ctx);
    expect(d.interviewPrep.map((p) => p.company_slug)).toEqual(["acme-corp"]);
    expect(JSON.stringify(d)).not.toContain("passport");
  });
  it("lists nothing when learning/ itself is a link", () => {
    const { ctx, root } = openSample();
    const outside = tmpDir();
    fs.mkdirSync(path.join(outside, "topic"));
    fs.writeFileSync(path.join(outside, "topic", "guide.md"), "# Outside topic\n");
    fs.rmSync(layout(root).learning, { recursive: true });
    fs.symlinkSync(outside, layout(root).learning);
    expect(learnHandlers["learn.list"](ctx).topics).toEqual([]);
  });
});
