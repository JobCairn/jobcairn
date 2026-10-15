import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { newJob } from "../src/jobs.js";
import { layout } from "../src/paths.js";
import { updateRecord } from "../src/store.js";
import { allowAccessRequest, claudeSettings } from "../src/privacy.js";
import { listApprovals, requestAccess } from "../src/queue.js";
import {
  buildDraftMessage, checkAttachmentScope, ME_NOT_ATTACHABLE, checkDraft, digestOf, formatAddress, parseAddressList, parseDraft, proposeEmailSend, readDraft, resolveAttachment, serializeDraft, writeDraft,
  type CanonicalMessage, type Draft,
} from "../src/drafts.js";
import { run } from "../src/cli.js";
import { FIXED, tmpDir } from "./helpers.js";

const at = (min: number) => ({ now: new Date(FIXED.getTime() + min * 60_000) });
/** An allow-once grant the app would make: backed by an allowed access request. */
const allowOnce = (root: string, c?: { now: Date }) => allowAccessRequest(root, requestAccess(root, { folder: "me/identity", why: "Attach it" }, c).id, 15, c);
const email = (u: string, d = "example.com") => u + "@" + d;
const STAMP = { message_id: "<d1.abc" + "@" + "example.com>", date: "2026-01-15T09:30:00.000Z" };

function ws() {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  const job = newJob(root, { company: "Acme Corp", title: "AI Engineer" }, { now: FIXED });
  updateRecord("integrations", layout(root).integrations, (i) => {
    i.mail.address = email("alex"); i.mail.display_name = "Alex Example"; i.mail.signature = "Alex Example\nAI Engineer";
  });
  return { root, job, L: layout(root) };
}
const draft = (over: Partial<Draft> = {}): Draft => ({
  to: [{ name: "Acme Talent", address: email("talent", "example.org") }], cc: [], subject: "Following up", attach: [], in_reply_to: "",
  references: [], purpose: "", body: "Hi,\n\nThanks for your time.\n\nRegards,\nAlex", ...over,
});

describe("addresses", () => {
  it("parses names and plain addresses, dedupes, and formats them back", () => {
    const list = parseAddressList(`Acme Talent <${email("talent", "example.org")}>; ${email("hr", "example.net")}, ${email("TALENT", "example.org")}`);
    expect(list).toEqual([{ name: "Acme Talent", address: email("talent", "example.org") }, { name: "", address: email("hr", "example.net") }]);
    expect(formatAddress(list[0]!)).toBe(`"Acme Talent" <${email("talent", "example.org")}>`);
    expect(formatAddress(list[1]!)).toBe(email("hr", "example.net"));
  });
  it("refuses anything that is not an address, line breaks, and too many people", () => {
    expect(() => parseAddressList("not-an-address")).toThrow(/isn't an email address/);
    expect(() => parseAddressList(email("a") + "\r\nBcc: " + email("b"))).toThrow(/line breaks/);
    expect(() => parseAddressList(Array.from({ length: 21 }, (_, i) => email(`p${i}`)).join(", "))).toThrow(/at most 20/);
    expect(() => parseAddressList(`"Al"ex" <${email("a")}>`)).toThrow();
  });
});

describe("draft files", () => {
  it("round-trips the legacy format", () => {
    const d = draft({ cc: [{ name: "", address: email("hr", "example.net") }], attach: ["companies/acme-corp/jobs/x/application/resume.pdf"], in_reply_to: "<m1" + "@" + "example.org>", references: ["<m0" + "@" + "example.org>", "<m1" + "@" + "example.org>"], purpose: "apply" });
    expect(parseDraft(serializeDraft(d))).toEqual(d);
  });
  it("refuses Bcc, unknown headers and a smuggled header line", () => {
    expect(() => parseDraft(`To: ${email("a")}\nBcc: ${email("b")}\n\nHi`)).toThrow(/BCC isn't supported/);
    expect(() => parseDraft(`To: ${email("a")}\nX-Priority: 1\n\nHi`)).toThrow(/Unknown draft header/);
    expect(() => parseDraft(`To: ${email("a")}\r\nSubject: Hi\r\nBcc: ${email("b")}\r\n\r\nBody`)).toThrow(/BCC isn't supported/);
    expect(() => parseDraft(`To: ${email("a")}\nPurpose: spam\n\nHi`)).toThrow(/Purpose/);
  });
  it("writes drafts into the job's drafts folder and reads them back", () => {
    const { root, job, L } = ws();
    const w = writeDraft(root, job.company_slug, job.id, draft(), undefined, at(0));
    expect(w.rel).toBe(`companies/${job.company_slug}/jobs/${job.id}/emails/drafts/${w.draft_id}.md`);
    expect(fs.existsSync(path.join(L.draftsDir(job.company_slug, job.id), `${w.draft_id}.md`))).toBe(true);
    expect(readDraft(root, job.company_slug, job.id, w.draft_id)).toEqual(draft());
    expect(() => writeDraft(root, "acme-corp", "missing", draft())).toThrow(/no job/);
  });
  it("refuses a recipient name that smuggles header lines, in a writeDraft -> readDraft round trip (I-1)", () => {
    const { root, job, L } = ws();
    const hostile = 'X" <' + email("a") + '>\nCc: ' + email("evil", "example.org") + '\nTo: "Y';
    expect(() => writeDraft(root, job.company_slug, job.id, draft({ to: [{ name: hostile, address: email("talent", "example.org") }] })))
      .toThrow(/isn't valid/);
    // Nothing should have been written: there is no draft to read back.
    expect(fs.existsSync(L.draftsDir(job.company_slug, job.id)) ? fs.readdirSync(L.draftsDir(job.company_slug, job.id)) : []).toEqual([]);
  });
  it("refuses an attachment whose file name contains \"=?\" when the draft is saved, not only when it is built (Task 8 review item a)", () => {
    const { root, job, L } = ws();
    const rel = `companies/${job.company_slug}/jobs/${job.id}/=?utf-8?q?FAKE?=.pdf`;
    expect(() => writeDraft(root, job.company_slug, job.id, draft({ attach: [rel] }))).toThrow(/can't contain "=\?"/);
    expect(fs.existsSync(L.draftsDir(job.company_slug, job.id)) ? fs.readdirSync(L.draftsDir(job.company_slug, job.id)) : []).toEqual([]);
    expect(() => checkDraft(draft({ attach: [rel] }), false)).toThrow(/can't contain "=\?"/);
    // A plain name still saves.
    const ok = `companies/${job.company_slug}/jobs/${job.id}/resume.pdf`;
    expect(() => writeDraft(root, job.company_slug, job.id, draft({ attach: [ok] }))).not.toThrow();
  });
  it("dedupes To and Cc case-insensitively, dropping a Cc entry already in To", () => {
    const { root, job } = ws();
    const d = draft({ cc: [{ name: "", address: email("TALENT", "example.org") }, { name: "", address: email("hr", "example.net") }] });
    const { draft_id } = writeDraft(root, job.company_slug, job.id, d);
    expect(readDraft(root, job.company_slug, job.id, draft_id).cc).toEqual([{ name: "", address: email("hr", "example.net") }]);
  });
});

describe("the message digest", () => {
  it("is stable for the same inputs and covers body, signature and attachments", () => {
    const { root, job, L } = ws();
    const app = path.join(L.jobDir(job.company_slug, job.id), "application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "# Alex Example\n");
    const rel = `companies/${job.company_slug}/jobs/${job.id}/application/resume.md`;
    const { draft_id } = writeDraft(root, job.company_slug, job.id, draft({ attach: [rel] }));
    const a = buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP);
    expect(buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP).digest).toBe(a.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.message.text.endsWith("Regards,\nAlex\n\nAlex Example\nAI Engineer\n")).toBe(true);
    expect(a.message.attachments).toEqual([expect.objectContaining({ rel, name: "resume.md", type: "text/markdown", locked: null })]);
    fs.writeFileSync(path.join(app, "resume.md"), "# Alex Example (edited)\n");
    expect(buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP).digest).not.toBe(a.digest);
    updateRecord("integrations", L.integrations, (i) => { i.mail.signature = "Alex"; });
    const b = buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP);
    writeDraft(root, job.company_slug, job.id, draft({ attach: [rel], body: "Hello" }), draft_id);
    expect(buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP).digest).not.toBe(b.digest);
  });
  it("changes whenever any one field the send will use changes (I-3)", () => {
    const { root, job } = ws();
    const { draft_id } = writeDraft(root, job.company_slug, job.id, draft());
    const variants: Partial<Draft>[] = [
      { subject: "A different subject" },
      { to: [{ name: "", address: email("other", "example.org") }] },
      { cc: [{ name: "", address: email("cc1", "example.org") }] },
      { in_reply_to: "<prior" + "@" + "example.org>" },
      { references: ["<prior" + "@" + "example.org>"] },
      { purpose: "apply" },
    ];
    for (const over of variants) {
      // Reset the same draft_id back to the unchanged baseline, rebuild, then apply
      // exactly one changed field and rebuild again: an isolated before/after pair.
      writeDraft(root, job.company_slug, job.id, draft(), draft_id);
      const before = buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP);
      writeDraft(root, job.company_slug, job.id, draft(over), draft_id);
      const after = buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP);
      expect(after.digest, JSON.stringify(over)).not.toBe(before.digest);
    }
  });
  it("digestOf stringifies with sorted keys, so key order can never change the digest", () => {
    const base: CanonicalMessage = {
      draft_id: "d1", message_id: STAMP.message_id, date: STAMP.date,
      from: { name: "Alex Example", address: email("alex") }, to: [{ name: "", address: email("talent", "example.org") }], cc: [],
      subject: "Hi", in_reply_to: "", references: [], text: "Hi,\n\nRegards,\nAlex\n", purpose: "", attachments: [],
    };
    // Same values, built with every top-level and nested key in reverse order.
    const reordered: CanonicalMessage = {
      attachments: [], purpose: "", text: "Hi,\n\nRegards,\nAlex\n", references: [], in_reply_to: "", subject: "Hi",
      cc: [], to: [{ address: email("talent", "example.org"), name: "" }],
      from: { address: email("alex"), name: "Alex Example" }, date: STAMP.date, message_id: STAMP.message_id, draft_id: "d1",
    };
    expect(digestOf(reordered)).toBe(digestOf(base));
  });
  it("needs a connected account, a recipient and a subject", () => {
    const { root, job, L } = ws();
    const { draft_id } = writeDraft(root, job.company_slug, job.id, draft({ to: [] }));
    expect(() => buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP)).toThrow(/at least one recipient/);
    writeDraft(root, job.company_slug, job.id, draft({ subject: " " }), draft_id);
    expect(() => buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP)).toThrow(/subject/);
    updateRecord("integrations", L.integrations, (i) => { i.mail.address = ""; });
    writeDraft(root, job.company_slug, job.id, draft(), draft_id);
    expect(() => buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP)).toThrow(/Gmail isn't connected/);
  });
  it("refuses files from me/ in plain words, and a job-folder link into me/identity even once it is allowed", () => {
    const { root, job } = ws();
    const secret = path.join(root, "me", "identity", "visa.pdf");
    fs.writeFileSync(secret, "fictional");
    expect(() => writeDraft(root, job.company_slug, job.id, draft({ attach: ["me/identity/visa.pdf"] }))).toThrow(ME_NOT_ATTACHABLE);
    expect(ME_NOT_ATTACHABLE).toBe("Files from your private me/ folder can't be attached to an email. If you want to send one, copy it into this job's folder first, then attach it from there.");
    // A job subfolder linked to me/identity: the real path is checked, so it's refused the same way, grant or not.
    const jobDir = path.join(root, "companies", job.company_slug, "jobs", job.id);
    fs.symlinkSync(path.join(root, "me", "identity"), path.join(jobDir, "evidence"), "dir");
    const { draft_id } = writeDraft(root, job.company_slug, job.id, draft({ attach: [`companies/${job.company_slug}/jobs/${job.id}/evidence/visa.pdf`] }));
    expect(() => buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP)).toThrow(ME_NOT_ATTACHABLE);
    allowOnce(root);
    expect(() => buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP)).toThrow(ME_NOT_ATTACHABLE);
    // A hard link in the job's folder is refused before anything is read.
    fs.linkSync(secret, path.join(jobDir, "visa.pdf"));
    expect(() => resolveAttachment(root, job.company_slug, job.id, `companies/${job.company_slug}/jobs/${job.id}/visa.pdf`)).toThrow(/is a hard link/);
  });
  it("names an attachment that is gone, and refuses hidden files such as settings/.env", () => {
    const { root, job } = ws();
    const goneRel = `companies/${job.company_slug}/jobs/${job.id}/gone.pdf`;
    const { draft_id } = writeDraft(root, job.company_slug, job.id, draft({ attach: [goneRel] }));
    expect(() => buildDraftMessage(root, job.company_slug, job.id, draft_id, STAMP)).toThrow(/can't be found/);
    for (const rel of ["settings/.env", ".careeros/activity.jsonl", "../outside.pdf"]) {
      expect(() => writeDraft(root, job.company_slug, job.id, draft({ attach: [rel] })), rel).toThrow(/can't be attached/);
    }
  });
  it("refuses an attachment from another company's or job's folder (R-A)", () => {
    const { root, job } = ws();
    const other = newJob(root, { company: "Example Labs", title: "Backend Engineer" }, { now: FIXED });
    for (const rel of [
      `companies/${other.company_slug}/jobs/${other.id}/resume.pdf`,
      `companies/${job.company_slug}/resume.pdf`,
      "learning/notes.md",
    ]) {
      expect(() => writeDraft(root, job.company_slug, job.id, draft({ attach: [rel] })), rel).toThrow(/Attach a file from this job's own folder\./);
    }
  });
  it("refuses any file from me/, even outside identity/employment (stricter than R-A, final review M3)", () => {
    const { root, job } = ws();
    fs.mkdirSync(path.join(root, "me", "resumes"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "resumes", "resume.pdf"), "fictional resume");
    expect(() => writeDraft(root, job.company_slug, job.id, draft({ attach: ["me/resumes/resume.pdf"] }))).toThrow(ME_NOT_ATTACHABLE);
  });
  it("refuses an attachment swapped for a symlink between the check and the read (I-5, TOCTOU)", () => {
    const { root, job } = ws();
    const app = path.join(root, "companies", job.company_slug, "jobs", job.id, "application");
    fs.mkdirSync(app, { recursive: true });
    const target = path.join(app, "resume.pdf");
    fs.writeFileSync(target, "fictional resume content");
    const secretDir = path.join(root, "me", "identity");
    fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, "visa.pdf");
    fs.writeFileSync(secret, "fictional secret content");
    const rel = `companies/${job.company_slug}/jobs/${job.id}/application/resume.pdf`;

    const realLstat = fs.lstatSync;
    const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, opts?: fs.StatOptions) => {
      const st = realLstat(p as string, opts as undefined);
      // Simulate a race: the instant after the safety lstat is taken, swap the
      // checked path for a symlink into a locked folder.
      if (p === target) { fs.rmSync(target, { force: true }); fs.symlinkSync(secret, target); }
      return st;
    }) as typeof fs.lstatSync);
    try {
      expect(() => resolveAttachment(root, job.company_slug, job.id, rel)).toThrow(/can't be found/);
    } finally {
      spy.mockRestore();
    }
  });
  it("refuses an attachment when an ancestor folder is swapped between opening the file and resolving its real path (I-5, parent swap)", () => {
    const { root, job } = ws();
    const app = path.join(root, "companies", job.company_slug, "jobs", job.id, "application");
    fs.mkdirSync(app, { recursive: true });
    const target = path.join(app, "resume.pdf");
    fs.writeFileSync(target, "fictional resume content");
    const decoyDir = path.join(tmpDir(), "decoy-application");
    fs.mkdirSync(decoyDir, { recursive: true });
    fs.writeFileSync(path.join(decoyDir, "resume.pdf"), "fictional decoy content");
    const rel = `companies/${job.company_slug}/jobs/${job.id}/application/resume.pdf`;

    const realOpenSync = fs.openSync;
    const spy = vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags: number, mode?: number) => {
      const fd = realOpenSync(p as string, flags, mode);
      // Simulate a race the other way round: the fd is pinned to the real
      // application/ folder first, then -- before resolveAttachment gets to
      // compute the realpath -- application/ itself is swapped for a symlink
      // elsewhere, so a naive realpath taken after open would resolve somewhere
      // the fd was never opened against.
      if (p === target) { fs.rmSync(app, { recursive: true, force: true }); fs.symlinkSync(decoyDir, app, "dir"); }
      return fd;
    }) as typeof fs.openSync);
    try {
      expect(() => resolveAttachment(root, job.company_slug, job.id, rel)).toThrow(/changed while it was being attached/);
    } finally {
      spy.mockRestore();
    }
  });
  it("decides 'locked' by inode membership, not a second path resolution, closing the realpath/stat interleave gap (I-5, fix round 3)", () => {
    const { root, job } = ws();
    const app = path.join(root, "companies", job.company_slug, "jobs", job.id, "application");
    const secretDir = path.join(root, "me", "identity");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "resume.pdf"), "fictional secret content");
    // The attachment is reached through an ancestor symlink into the locked folder,
    // so the fd genuinely reads bytes that live inside me/identity.
    fs.symlinkSync(secretDir, app, "dir");
    const rel = `companies/${job.company_slug}/jobs/${job.id}/application/resume.pdf`;
    const trueReal = fs.realpathSync.native(path.join(secretDir, "resume.pdf"));

    const decoy = path.join(tmpDir(), "decoy.pdf");
    fs.writeFileSync(decoy, "fictional decoy content");
    const realNative = fs.realpathSync.native;
    let trueValueSeen = 0;
    const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: fs.PathLike, enc?: unknown) => {
      const real = realNative(p as string, enc as undefined);
      if (real === trueReal) {
        trueValueSeen++;
        // Two resolutions of this exact, true (locked) location already happen
        // legitimately before any "locked" decision is made (once inside insideRoot's
        // own symlink check, once for resolveAttachment's own realAbs) -- let those
        // through correctly. A *third* resolution of that same, already-resolved
        // location is what a path-based "is this locked" check (the kind this round's
        // fix replaces) would need to perform all over again, and is made to see an
        // unrelated decoy instead, as if the world had shifted again in between. The
        // current code never performs that third resolution at all -- it goes
        // straight from the pinned fd to lockedFolderForFd -- so this decoy should
        // never even be consulted, and the file must still come back as locked.
        if (trueValueSeen >= 3) return decoy;
      }
      return real;
    }) as typeof fs.realpathSync.native);
    try {
      expect(() => resolveAttachment(root, job.company_slug, job.id, rel)).toThrow(/private/);
    } finally {
      spy.mockRestore();
    }
  });
  it("refuses an attachment reached through a job subfolder symlinked to another company's job (R-A real path)", () => {
    const { root, job } = ws();
    const other = newJob(root, { company: "Example Labs", title: "Backend Engineer" }, { now: FIXED });
    const otherDir = path.join(root, "companies", other.company_slug, "jobs", other.id);
    fs.writeFileSync(path.join(otherDir, "resume.pdf"), "fictional");
    const jobDir = path.join(root, "companies", job.company_slug, "jobs", job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.symlinkSync(otherDir, path.join(jobDir, "evidence"), "dir");
    const rel = `companies/${job.company_slug}/jobs/${job.id}/evidence/resume.pdf`;
    expect(() => resolveAttachment(root, job.company_slug, job.id, rel)).toThrow(/Attach a file from this job's own folder\./);
  });
  it("refuses an attachment when the whole job folder is symlinked to another job (R-A real path)", () => {
    const { root, job } = ws();
    const other = newJob(root, { company: "Example Labs", title: "Backend Engineer" }, { now: FIXED });
    const otherDir = path.join(root, "companies", other.company_slug, "jobs", other.id);
    fs.writeFileSync(path.join(otherDir, "resume.pdf"), "fictional");
    const jobDir = path.join(root, "companies", job.company_slug, "jobs", job.id);
    fs.rmSync(jobDir, { recursive: true, force: true });
    fs.symlinkSync(otherDir, jobDir, "dir");
    const rel = `companies/${job.company_slug}/jobs/${job.id}/resume.pdf`;
    expect(() => resolveAttachment(root, job.company_slug, job.id, rel)).toThrow(/Attach a file from this job's own folder\./);
  });
  it("refuses an attachment reached through a symlink into .careeros/ (R-A real path)", () => {
    const { root, job } = ws();
    fs.mkdirSync(path.join(root, ".careeros"), { recursive: true });
    fs.writeFileSync(path.join(root, ".careeros", "secret.txt"), "fictional");
    const jobDir = path.join(root, "companies", job.company_slug, "jobs", job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.symlinkSync(path.join(root, ".careeros"), path.join(jobDir, "evidence"), "dir");
    const rel = `companies/${job.company_slug}/jobs/${job.id}/evidence/secret.txt`;
    expect(() => resolveAttachment(root, job.company_slug, job.id, rel)).toThrow(/Attach files from inside the workspace/);
  });
  it("checkAttachmentScope compares case-sensitively by default, only folding case when explicitly told to (fix round 3)", () => {
    // Not folding case by default matters on a case-sensitive volume: a look-alike
    // folder with the same letters as "me" but different case (say "ME/secret-data",
    // a real, distinct directory unrelated to the real me/ folder) must not be able
    // to pass itself off as "me/" just because a blind .toLowerCase() would match.
    expect(() => checkAttachmentScope("acme-corp", "job-1", "ME/resumes/resume.pdf")).toThrow(/Attach a file from this job's own folder\./);
    expect(() => checkAttachmentScope("acme-corp", "job-1", "ME/resumes/resume.pdf", false)).toThrow(/Attach a file from this job's own folder\./);
    // Folding is only safe once a caller has confirmed (via isCaseInsensitiveFs) that
    // the volume really is case-insensitive, in which case "ME/..." and "me/..." are
    // guaranteed to be the exact same real directory, not two different ones.
    expect(() => checkAttachmentScope("acme-corp", "job-1", "ME/resumes/resume.pdf", true)).toThrow(ME_NOT_ATTACHABLE);
    expect(() => checkAttachmentScope("ACME-CORP", "JOB-1", "companies/acme-corp/jobs/job-1/resume.pdf")).toThrow(/Attach a file from this job's own folder\./);
    expect(() => checkAttachmentScope("ACME-CORP", "JOB-1", "companies/acme-corp/jobs/job-1/resume.pdf", true)).not.toThrow();
  });
  it("refuses a drafts folder reached through a job folder symlinked into me/identity (I-6, ancestor realpath)", () => {
    const { root, job } = ws();
    const jobDir = path.join(root, "companies", job.company_slug, "jobs", job.id);
    fs.rmSync(jobDir, { recursive: true, force: true });
    // jobFilePath only checks that a file exists at the literal path; it doesn't
    // parse it, so a placeholder is enough to get past that check and into
    // draftsFolder's own locked-folder check, which is what this test exercises.
    fs.writeFileSync(path.join(root, "me", "identity", "job.json"), "placeholder");
    fs.symlinkSync(path.join(root, "me", "identity"), jobDir, "dir");
    expect(() => writeDraft(root, job.company_slug, job.id, draft())).toThrow(/locked/);
  });
  it("refuses a drafts folder reached through a differently-cased ME/IDENTITY symlink target, and creates nothing inside the real folder (realish case, fix round 3)", (ctx) => {
    const { root, job } = ws();
    // Only meaningful where ME/IDENTITY and me/identity are the same folder (macOS, Windows), not on Linux.
    if (!fs.existsSync(path.join(root, "ME", "IDENTITY"))) ctx.skip();
    const jobDir = path.join(root, "companies", job.company_slug, "jobs", job.id);
    fs.rmSync(jobDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(root, "me", "identity", "job.json"), "placeholder");
    // The symlink's target string is upper-cased; on a case-insensitive filesystem it
    // still resolves to the exact same real me/identity directory on disk. realish()
    // must normalise this case the same way lockedFolderFor's own resolution does,
    // or the two resolved strings would mismatch and the lock would go undetected.
    fs.symlinkSync(path.join(root, "ME", "IDENTITY"), jobDir, "dir");
    const before = fs.readdirSync(path.join(root, "me", "identity")).sort();
    expect(() => writeDraft(root, job.company_slug, job.id, draft())).toThrow(/locked/);
    expect(fs.readdirSync(path.join(root, "me", "identity")).sort()).toEqual(before);
  });
  it("refuses a drafts folder reached through a symlinked emails/ (I-6)", () => {
    const { root, job, L } = ws();
    const jobDir = L.jobDir(job.company_slug, job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.symlinkSync(path.join(root, "me", "identity"), path.join(jobDir, "emails"), "dir");
    expect(() => writeDraft(root, job.company_slug, job.id, draft())).toThrow(/not a real folder/);
  });
  it("refuses an attachment that is a symlink", () => {
    const { root, job } = ws();
    const app = path.join(root, "companies", job.company_slug, "jobs", job.id, "application");
    fs.mkdirSync(app, { recursive: true });
    const real = path.join(tmpDir(), "outside-resume.pdf");
    fs.writeFileSync(real, "fictional");
    fs.symlinkSync(real, path.join(app, "resume.pdf"));
    const rel = `companies/${job.company_slug}/jobs/${job.id}/application/resume.pdf`;
    expect(() => resolveAttachment(root, job.company_slug, job.id, rel)).toThrow(/isn't a regular file/);
  });
  it("refuses an attachment that is a hard link (nlink > 1)", () => {
    const { root, job } = ws();
    const app = path.join(root, "companies", job.company_slug, "jobs", job.id, "application");
    fs.mkdirSync(app, { recursive: true });
    const original = path.join(app, "resume.pdf");
    fs.writeFileSync(original, "fictional");
    const linked = path.join(app, "resume-copy.pdf");
    fs.linkSync(original, linked);
    const rel = `companies/${job.company_slug}/jobs/${job.id}/application/resume-copy.pdf`;
    expect(() => resolveAttachment(root, job.company_slug, job.id, rel)).toThrow(/hard link/);
  });
  it("refuses an attachment whose file name contains a literal RFC 2047 encoded word (mail package review, fix round 2: what the recruiter sees wins)", () => {
    // A name like this would decode to different visible text in a standards-compliant mail
    // client than what CareerOS's own preview and approval digest show for the exact same file --
    // refused upstream, before a draft/digest/wire disagreement is even possible, rather than left
    // for the mail package to paper over on the way out.
    const { root, job } = ws();
    const app = path.join(root, "companies", job.company_slug, "jobs", job.id, "application");
    fs.mkdirSync(app, { recursive: true });
    const hostile = "resume =?utf-8?q?FAKE?=.pdf";
    fs.writeFileSync(path.join(app, hostile), "fictional");
    const rel = `companies/${job.company_slug}/jobs/${job.id}/application/${hostile}`;
    expect(() => resolveAttachment(root, job.company_slug, job.id, rel)).toThrow(/An attachment name can't contain "=\?"/);
  });
});

describe("proposing a send", () => {
  it("records the digest and stamp, and replaces an older pending proposal of the same draft", () => {
    const { root, job } = ws();
    const { draft_id } = writeDraft(root, job.company_slug, job.id, draft());
    const first = proposeEmailSend(root, job.company_slug, job.id, draft_id, "app", at(0));
    expect(first).toMatchObject({ action: "email_send", status: "pending", created_by: "app" });
    expect(first.payload).toMatchObject({ company_slug: job.company_slug, id: job.id, draft_id, account: email("alex"), purpose: "" });
    expect(String(first.payload.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(first.payload.message_id)).toMatch(new RegExp(`^<${draft_id}\\.[0-9a-f]{12}@example\\.com>$`));
    const second = proposeEmailSend(root, job.company_slug, job.id, draft_id, "app", at(1));
    const all = listApprovals(root);
    expect(all.find((a) => a.id === first.id)).toMatchObject({ status: "declined", result_note: "Replaced by a newer version of the draft" });
    expect(all.find((a) => a.id === second.id)?.status).toBe("pending");
  });
  it("keeps the older pending approval when the replacement proposal fails (I-4, failure path)", () => {
    const { root, job } = ws();
    const { draft_id } = writeDraft(root, job.company_slug, job.id, draft());
    const first = proposeEmailSend(root, job.company_slug, job.id, draft_id, "app", at(0));
    const spy = vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated disk failure"), { code: "EACCES" });
    });
    try {
      expect(() => proposeEmailSend(root, job.company_slug, job.id, draft_id, "app", at(1))).toThrow(/simulated disk failure/);
    } finally {
      spy.mockRestore();
    }
    expect(listApprovals(root).find((a) => a.id === first.id)?.status).toBe("pending");
  });
});

describe("cli", () => {
  it("lets Claude draft an email and propose it, but never send", () => {
    const { root, job } = ws();
    const body = path.join(root, "body.txt");
    fs.writeFileSync(body, "Hi,\n\nCould we talk this week?\n\nRegards,\nAlex\n");
    const r = run(["mail", "draft", "--ws", root, "--job", `${job.company_slug}/${job.id}`, "--to", email("talent", "example.org"), "--subject", "Quick question", "--body-file", body]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.approval).toMatchObject({ action: "email_send", status: "pending", created_by: "cli" });
    expect(fs.existsSync(path.join(root, out.draft.rel))).toBe(true);
  });
  it("refuses a body file in a locked folder and an attachment outside the workspace", () => {
    const { root, job } = ws();
    const secret = path.join(root, "me", "identity", "notes.txt");
    fs.writeFileSync(secret, "fictional");
    const base = ["mail", "draft", "--ws", root, "--job", `${job.company_slug}/${job.id}`, "--to", email("talent", "example.org"), "--subject", "Hi"];
    expect(run([...base, "--body-file", secret]).err).toMatch(/me\/identity.*locked/);
    const body = path.join(root, "body.txt");
    fs.writeFileSync(body, "Hi");
    const outside = path.join(tmpDir(), "cv.pdf");
    fs.writeFileSync(outside, "fictional");
    expect(run([...base, "--body-file", body, "--attach", outside]).err).toMatch(/inside the workspace/);
  });
  it("reads --body-file only from inside the workspace, never through a link or a second hard-link name (fix round 0)", () => {
    const { root, job, L } = ws();
    const base = ["mail", "draft", "--ws", root, "--job", `${job.company_slug}/${job.id}`, "--to", email("talent", "example.org"), "--subject", "Hi"];
    const secret = path.join(root, "me", "identity", "notes.txt");
    fs.writeFileSync(secret, "fictional secret");
    const hard = path.join(root, "body-hard.txt");
    fs.linkSync(secret, hard);
    expect(run([...base, "--body-file", hard]).err).toMatch(/second name/);
    const plain = path.join(root, "plain.txt");
    fs.writeFileSync(plain, "Hi");
    fs.linkSync(plain, path.join(root, "plain-2.txt"));
    expect(run([...base, "--body-file", plain]).err).toMatch(/second name/);
    const target = path.join(root, "target.txt");
    fs.writeFileSync(target, "Hi");
    const link = path.join(root, "body-link.txt");
    fs.symlinkSync(target, link);
    expect(run([...base, "--body-file", link]).err).toMatch(/is a link/);
    fs.symlinkSync(secret, path.join(root, "secret-link.txt"));
    expect(run([...base, "--body-file", path.join(root, "secret-link.txt")]).err).toMatch(/me\/identity.*locked/);
    const outside = path.join(tmpDir(), "body.txt");
    fs.writeFileSync(outside, "Hi");
    expect(run([...base, "--body-file", outside]).err).toMatch(/outside the workspace/);
    expect(fs.existsSync(L.draftsDir(job.company_slug, job.id)) ? fs.readdirSync(L.draftsDir(job.company_slug, job.id)) : []).toEqual([]);
  });
  it("refuses --job with more than two parts", () => {
    const { root, job } = ws();
    const body = path.join(root, "body.txt");
    fs.writeFileSync(body, "Hi");
    const r = run(["mail", "draft", "--ws", root, "--job", `${job.company_slug}/${job.id}/extra`, "--to", email("talent", "example.org"), "--subject", "Hi", "--body-file", body]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--job must be SLUG\/ID/);
  });
  it("refuses a --body-file that is a directory, with a clear error", () => {
    const { root, job } = ws();
    const dir = path.join(root, "a-folder");
    fs.mkdirSync(dir, { recursive: true });
    const r = run(["mail", "draft", "--ws", root, "--job", `${job.company_slug}/${job.id}`, "--to", email("talent", "example.org"), "--subject", "Hi", "--body-file", dir]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/regular file/);
  });
  it("refuses a U+2028 line-separator subject and leaves no draft behind (I-2)", () => {
    const { root, job, L } = ws();
    const body = path.join(root, "body.txt");
    fs.writeFileSync(body, "Hi");
    const subject = "Hi" + String.fromCodePoint(0x2028) + "there";
    const r = run(["mail", "draft", "--ws", root, "--job", `${job.company_slug}/${job.id}`, "--to", email("talent", "example.org"), "--subject", subject, "--body-file", body]);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(L.draftsDir(job.company_slug, job.id)) ? fs.readdirSync(L.draftsDir(job.company_slug, job.id)) : []).toEqual([]);
  });
  it("deletes the draft it just wrote if proposing the send fails, instead of leaving an orphan (I-2)", () => {
    const { root, job, L } = ws();
    updateRecord("integrations", L.integrations, (i) => { i.mail.address = ""; });
    const body = path.join(root, "body.txt");
    fs.writeFileSync(body, "Hi,\n\nJust checking in.\n\nRegards,\nAlex\n");
    const r = run(["mail", "draft", "--ws", root, "--job", `${job.company_slug}/${job.id}`, "--to", email("talent", "example.org"), "--subject", "Hi", "--body-file", body]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/Gmail isn't connected/);
    expect(fs.readdirSync(L.draftsDir(job.company_slug, job.id)).filter((n) => n.endsWith(".md"))).toEqual([]);
  });
  it("expires grants whose time is up (the SessionStart hook)", () => {
    const { root } = ws();
    allowOnce(root, at(-60));
    const r = run(["privacy", "expire", "--ws", root]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ expired: ["me/identity"] });
  });
  it("adds a SessionStart hook that expires grants, passing the project dir explicitly", () => {
    expect(claudeSettings([]).hooks).toEqual({
      SessionStart: [{ hooks: [{ type: "command", command: 'careeros privacy expire --ws "$CLAUDE_PROJECT_DIR" || true' }] }],
    });
  });
  it("there is no CLI command to decide or approve anything", () => {
    const { root } = ws();
    const r = run(["approval", "decide", "--ws", root, "x", "approved"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/unknown command/);
    const r2 = run(["approval", "approve", "--ws", root, "x"]);
    expect(r2.code).not.toBe(0);
    expect(r2.err).toMatch(/unknown command/);
  });
});

// The fd walk's fail-closed limits (depth, entry count, read errors) are tested directly in privacy.test.ts
// ("lockedFolderForFd fails closed"). Since the final review, no attachment path can reach me/ at all: me/ paths
// and real paths under me/ are refused by scope, and hard links are refused outright, so the walk here is a
// second line only.


