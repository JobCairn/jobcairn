import fs from "node:fs";
import path from "node:path";
import { allowAccessRequest, ME_NOT_ATTACHABLE, requestAccess, layout, readRecord, writeDraft } from "@careeros/core";
import { addr, ALEX, rawMessage, readMailState, TALENT, updateStored } from "@careeros/mail";
import { mailRefToken, mailUrlFor, mailViewUrl } from "@careeros/contract";
import { describe, expect, it, vi } from "vitest";
import { approvalHandlers as AP } from "../src/approvals.js";
import { fakeMailHost, PNG_1X1 } from "../src/fakes.js";
import { mailAccountHandlers } from "../src/mail-account.js";
import { allDrafts, mailAsset, mailReadHandlers as R } from "../src/mail-read.js";
import { readHandlers } from "../src/read.js";
import { openSample } from "./helpers.js";
import { ACME, connectMail, LABS, storeRaw } from "./mail-helpers.js";

const SEEK = addr("noreply", "s.seek.com.au");
const HTML = '<p>Hi Alex <a href="https://jobs.example.com/apply">www.acme.example.com</a><img src="https://images.example.com/p.gif"><img src="cid:logo@acme"></p>';
const draftInput = (over = {}) => ({ to: `Acme Talent <${TALENT}>`, cc: "", subject: "Re: Interview for AI Engineer", body: "Hi,\n\nFriday works.\n\nRegards,\nAlex", attach: [], in_reply_to: "", references: [], purpose: "" as const, ...over });

async function seeded() {
  const mail = fakeMailHost();
  const x = openSample({ mail });
  connectMail(x.ctx, x.root);
  const job = await storeRaw(x.root, { company_slug: ACME[0], job_id: ACME[1] }, rawMessage({
    id: "m1", html: HTML,
    attachments: [
      { name: "logo.png", type: "image/png", content: PNG_1X1, cid: "logo@acme" },
      { name: "Interview details.pdf", type: "application/pdf", content: Buffer.from("%PDF-1.4 fictional") },
      { name: "setup.exe", type: "application/octet-stream", content: Buffer.from("MZ") },
    ],
  }));
  const company = await storeRaw(x.root, { company_slug: ACME[0], job_id: "" }, rawMessage({ id: "c1", subject: "Hello from Acme", date: "Tue, 13 Jan 2026 09:00:00 +0000" }), { uid: 2 });
  const spoof = await storeRaw(x.root, { company_slug: LABS[0], job_id: LABS[1] }, rawMessage({
    id: "s1", from: addr("x", "evil.example.net"), fromName: `Example Labs (${addr("talent", "examplelabs.example.net")})`, subject: "Urgent: confirm your details",
    auth: "mx.google.com; spf=fail; dmarc=fail header.from=evil.example.net", date: "Mon, 12 Jan 2026 09:00:00 +0000",
  }), { uid: 3 });
  const triage = await storeRaw(x.root, "triage", rawMessage({ id: "t1", from: addr("people", "examplelabs-mail.example.org"), subject: "Your application" }), { uid: 4 });
  const board = await storeRaw(x.root, "triage", rawMessage({ id: "t2", from: SEEK, subject: "New jobs", date: "Tue, 13 Jan 2026 08:00:00 +0000" }), { uid: 5 });
  return { ...x, mail, job, company, spoof, triage, board };
}

describe("mail list", () => {
  it("lists job and company mail newest first, with names, and filters", async () => {
    const { ctx } = await seeded();
    const all = R["mail.list"](ctx, {});
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => [r.subject, r.company_name, r.job_title])).toEqual([
      ["Interview for AI Engineer", "Acme Corp", "AI Engineer"], ["Hello from Acme", "Acme Corp", ""], ["Urgent: confirm your details", "Example Labs", "Backend Engineer (LLM)"],
    ]);
    expect(R["mail.list"](ctx, { company_slug: ACME[0], id: ACME[1] }).total).toBe(1);
    expect(R["mail.list"](ctx, { company_slug: ACME[0], id: ACME[1], includeCompany: true }).total).toBe(2);
    expect(R["mail.list"](ctx, { attachments: true }).rows.map((r) => r.attachments)).toEqual([2]);
    expect(R["mail.list"](ctx, { text: "urgent" }).total).toBe(1);
    expect(R["mail.list"](ctx, { direction: "out" }).total).toBe(0);
  });
  it("gives each listed row a one-line snippet of the body text", async () => {
    const { ctx, root } = await seeded();
    const rows = R["mail.list"](ctx, {}).rows;
    expect(rows.find((r) => r.subject === "Hello from Acme")?.snippet).toBe("Hi Alex, Could you talk on Friday? Acme Talent");
    const long = await storeRaw(root, { company_slug: ACME[0], job_id: "" }, rawMessage({
      id: "l1", subject: "Long one", text: `${"word ".repeat(200)}end`,
      attachments: Array.from({ length: 30 }, (_, i) => ({ name: `${"file-".repeat(10)}${i}.pdf`, type: "application/pdf", content: Buffer.from("%PDF") })),
    }), { uid: 8 });
    const row = R["mail.list"](ctx, {}).rows.find((r) => r.ref === long)!;
    expect(row.snippet?.startsWith("word word")).toBe(true);
    expect(row.snippet?.length).toBeLessThanOrEqual(160);
  });
});

describe("viewer", () => {
  it("marks incoming mail opened once and shows attachments with risk flags", async () => {
    const { ctx, job, setNow } = await seeded();
    expect(R["mail.list"](ctx, { unread: true }).total).toBe(3);
    const v = R["mail.get"](ctx, job);
    expect(v).toMatchObject({ subject: "Interview for AI Engineer", company_name: "Acme Corp", job_title: "AI Engineer", remote_images: 1, images_allowed: false, has_raw: true, warnings: [] });
    expect(v.attachments.map((a) => [a.name, a.risky])).toEqual([["Interview details.pdf", false], ["setup.exe", true]]);
    setNow(new Date("2026-01-16T09:00:00.000Z"));
    expect(R["mail.get"](ctx, job).opened_at).toBe(v.opened_at);
    expect(R["mail.list"](ctx, { unread: true }).total).toBe(2);
  });
  it("warns about failed sender checks and display names that claim another domain", async () => {
    const { ctx, spoof } = await seeded();
    expect(R["mail.get"](ctx, spoof).warnings).toEqual([
      "Gmail couldn't confirm this email really came from evil.example.net. Be careful with its links and attachments.",
      `The sender's name shows examplelabs.example.net, but the email came from ${addr("x", "evil.example.net")}.`,
    ]);
  });
  it("serves a sanitized document with the frame CSP and no remote images until allowed", async () => {
    const { ctx, job, mail } = await seeded();
    const doc = await mailAsset(ctx, mailUrlFor(job));
    expect(doc.status).toBe(200);
    expect(doc.headers["Content-Security-Policy"]).toBe("default-src 'none'; img-src careeros-mail: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    const html = String(doc.body);
    const t = mailRefToken(job);
    expect(html).toContain(`careeros-mail://link/${t}/0`);
    expect(html).toContain(`careeros-mail://cid/${t}/logo%40acme`);
    expect(html).not.toContain("images.example.com");
    expect((await mailAsset(ctx, `careeros-mail://img/${t}/0`)).status).toBe(403);
    expect(mail.images).toEqual([]);
    expect(R["mail.loadImages"](ctx, job).images_allowed).toBe(true);
    expect(String((await mailAsset(ctx, mailUrlFor(job))).body)).toContain(`careeros-mail://img/${t}/0`);
    const img = await mailAsset(ctx, `careeros-mail://img/${t}/0`);
    expect(img).toMatchObject({ status: 200, headers: { "Content-Type": "image/png" } });
    expect(mail.images).toEqual(["https://images.example.com/p.gif"]);
    const cid = await mailAsset(ctx, `careeros-mail://cid/${t}/logo%40acme`);
    expect(Buffer.from(cid.body as Buffer).equals(PNG_1X1)).toBe(true);
  });
  it("serves a plain-text view whose links open the text's own targets, never the original's", async () => {
    const { ctx, root, host } = await seeded();
    const both = await storeRaw(root, { company_slug: ACME[0], job_id: ACME[1] }, rawMessage({
      id: "v1", subject: "Two views", html: '<p>Apply <a href="https://html.example.com/a">here</a></p>',
      text: "Apply at https://text.example.com/b today.\r\n\r\n<script>alert(1)</script>",
    }), { uid: 9 });
    const t = mailRefToken(both);
    const doc = await mailAsset(ctx, mailViewUrl(mailUrlFor(both), "text"));
    expect(doc.status).toBe(200);
    expect(doc.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    const html = String(doc.body);
    expect(html).toContain("Apply at");
    expect(html).toContain(`careeros-mail://link/${t}/t0`);
    expect(html).not.toContain("html.example.com");
    expect(html).not.toContain("<script>");
    expect((await mailAsset(ctx, `careeros-mail://link/${t}/t0`)).status).toBe(204);
    expect((await mailAsset(ctx, `careeros-mail://link/${t}/0`)).status).toBe(204);
    expect(host.shell.opened).toEqual(["https://text.example.com/b", "https://html.example.com/a"]);
    // The original view's links keep their plain numbers.
    expect(String((await mailAsset(ctx, mailUrlFor(both))).body)).toContain(`careeros-mail://link/${t}/0"`);
  });
  it("opens links only through the safe link dialog, with a warning when the text names another site", async () => {
    const { ctx, job, host } = await seeded();
    const r = await mailAsset(ctx, `careeros-mail://link/${mailRefToken(job)}/0`);
    expect(r.status).toBe(204);
    expect(host.shell.opened).toEqual(["https://jobs.example.com/apply"]);
    expect(host.shell.notes).toEqual(["The link text shows www.acme.example.com but it goes to jobs.example.com."]);
  });
  it("serves an inline image only when its bytes are png, jpeg, gif or webp, whatever the email says", async () => {
    const { ctx, root } = await seeded();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const ref = await storeRaw(root, { company_slug: ACME[0], job_id: ACME[1] }, rawMessage({
      id: "i1", html: '<p><img src="cid:fake@acme"><img src="cid:real@acme"></p>',
      attachments: [
        { name: "fake.png", type: "image/png", content: svg, cid: "fake@acme" },
        { name: "real.bin", type: "application/octet-stream", content: PNG_1X1, cid: "real@acme" },
      ],
    }), { uid: 9 });
    const t = mailRefToken(ref);
    expect((await mailAsset(ctx, `careeros-mail://cid/${t}/fake%40acme`)).status).toBe(404);
    const real = await mailAsset(ctx, `careeros-mail://cid/${t}/real%40acme`);
    expect(real).toMatchObject({ status: 200, headers: { "Content-Type": "image/png", "Content-Security-Policy": "default-src 'none'" } });
  });
  it("never rejects: a failing link dialog or a raw copy gone mid-request still answers plainly", async () => {
    const { ctx, job, host, root } = await seeded();
    host.shell.openExternal = () => Promise.reject(new Error(`can't open ${root}/x`));
    expect((await mailAsset(ctx, `careeros-mail://link/${mailRefToken(job)}/0`)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 10));
    const statSync = fs.statSync;
    const spy = vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      if (String(p).endsWith(".eml")) throw Object.assign(new Error(`ENOENT: no such file, stat '${String(p)}'`), { code: "ENOENT", path: String(p) });
      return statSync(p, o);
    }) as typeof fs.statSync);
    try {
      expect((await mailAsset(ctx, mailUrlFor(job))).status).toBe(200);
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it("answers 404 for anything else", async () => {
    const { ctx } = await seeded();
    for (const u of ["careeros-mail://msg/xyz", `careeros-mail://msg/${mailRefToken("companies/acme-corp/emails/missing-aaaaaa.json")}`, "careeros-file://ws/x", "https://example.com/"]) {
      expect((await mailAsset(ctx, u)).status, u).toBe(404);
    }
  });
});

describe("attachments, moves and pruning", () => {
  it("saves an attachment into the job folder on request only", async () => {
    const { ctx, job, root } = await seeded();
    expect(fs.existsSync(path.join(root, "companies", ACME[0], "jobs", ACME[1], "emails", "attachments"))).toBe(false);
    const v = await R["mail.saveAttachment"](ctx, job, "2");
    expect(v.attachments[0]?.saved_rel).toBe(`companies/${ACME[0]}/jobs/${ACME[1]}/emails/attachments/interview-details.pdf`);
    expect(fs.readFileSync(path.join(root, v.attachments[0]!.saved_rel), "utf8")).toBe("%PDF-1.4 fictional");
    await expect(R["mail.saveAttachment"](ctx, job, "9")).rejects.toThrow(/isn't in this email/);
  });
  it("moves company mail to a job and puts it on the timeline", async () => {
    const { ctx, company, root } = await seeded();
    const v = R["mail.move"](ctx, company, { company_slug: ACME[0], id: ACME[1] });
    expect(v).toMatchObject({ job_id: ACME[1], job_title: "AI Engineer" });
    expect(readRecord("job", layout(root).jobFile(...ACME)).timeline.at(-1)).toMatchObject({ event: "Email received", note: "Hello from Acme" });
    expect(R["mail.list"](ctx, { company_slug: ACME[0], id: ACME[1] }).total).toBe(2);
  });
  it("keys the job's email event by Message-ID, so moving the same email back and forth never repeats it", async () => {
    const { ctx, company, root } = await seeded();
    const moved = R["mail.move"](ctx, company, { company_slug: ACME[0], id: ACME[1] });
    const back = R["mail.move"](ctx, moved.ref, { company_slug: ACME[0] });
    R["mail.move"](ctx, back.ref, { company_slug: ACME[0], id: ACME[1] });
    const events = readRecord("job", layout(root).jobFile(...ACME)).timeline.filter((e) => e.note === "Hello from Acme");
    expect(events).toHaveLength(1);
    expect(events[0]!.message_id).toMatch(/c1/);
  });
  it("never builds a path from a caller's ref, triage id, slug or job id", async () => {
    const { ctx } = await seeded();
    expect(() => R["mail.get"](ctx, "companies/acme-corp/../../etc/passwd.json")).toThrow("That isn't a stored email.");
    expect(() => R["mail.triage.assign"](ctx, "../../companies/acme-corp/emails/x", { company_slug: ACME[0] }, false)).toThrow("That isn't a stored email.");
    expect(() => R["mail.move"](ctx, "x", { company_slug: "../x" })).toThrow();
    expect(() => R["mail.drafts.list"](ctx, "..", "x")).toThrow();
  });
  it("removes raw copies older than N months but keeps the text", async () => {
    const { ctx, job, setNow } = await seeded();
    setNow(new Date("2026-06-15T09:00:00.000Z"));
    expect(R["mail.prune"](ctx, 3).removed).toBe(3);
    expect(R["mail.get"](ctx, job).has_raw).toBe(false);
    expect(String((await mailAsset(ctx, mailUrlFor(job))).body)).toContain("Could you talk on Friday?");
  });
});

describe("Mail to sort", () => {
  it("suggests a company, assigns with 'always match this sender', and lists the rest", async () => {
    const { ctx, root, triage } = await seeded();
    const items = R["mail.triage.list"](ctx);
    expect(items.map((i) => [i.subject, i.suggestion?.company_slug ?? null])).toEqual([["Your application", "example-labs"], ["New jobs", null]]);
    const left = R["mail.triage.assign"](ctx, triage.split("/").pop()!.replace(/\.json$/, ""), { company_slug: LABS[0], id: LABS[1] }, true);
    expect(left.map((i) => i.subject)).toEqual(["New jobs"]);
    expect(readRecord("company", layout(root).companyFile(LABS[0])).email_match).toContain(addr("people", "examplelabs-mail.example.org"));
    expect(R["mail.list"](ctx, { company_slug: LABS[0] }).total).toBe(2);
  });
  it("creates a company and job from a sorted email", async () => {
    const { ctx, board, root } = await seeded();
    R["mail.triage.createCompany"](ctx, board.split("/").pop()!.replace(/\.json$/, ""), "Contoso Talent", "AI Engineer");
    const rows = R["mail.list"](ctx, { company_slug: "contoso-talent" }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.job_title).toBe("AI Engineer");
    expect(readRecord("company", layout(root).companyFile("contoso-talent")).email_match).toEqual([SEEK]);
  });
  it("ignores a sender's domain: stores only the domain and removes matching items", async () => {
    const { ctx, root, board } = await seeded();
    expect(R["mail.triage.ignore"](ctx, board.split("/").pop()!.replace(/\.json$/, ""), "domain").map((i) => i.subject)).toEqual(["Your application"]);
    expect(readMailState(root).ignore).toEqual({ senders: [], domains: ["s.seek.com.au"] });
  });
  it("shows why sync held an email back from a job: the company it matched and what needs a check", async () => {
    const { ctx, triage, root } = await seeded();
    updateStored(root, triage, (e) => { e.custom = { needs_check: { company_slug: ACME[0], job_id: ACME[1], reason: "The job is Rejected, but the employer asked to talk or interview." } }; });
    const item = R["mail.triage.list"](ctx).find((i) => i.subject === "Your application")!;
    expect(item.suggestion).toMatchObject({ company_slug: ACME[0], reason: "Needs a check: The job is Rejected, but the employer asked to talk or interview." });
  });
});

describe("drafts and the exact-message preview", () => {
  it("saves a draft, previews it with the signature, and proposes it", async () => {
    const { ctx } = await seeded();
    const d = R["mail.drafts.save"](ctx, ...ACME, "", draftInput());
    expect(d.view).toMatchObject({ status: "draft", subject: "Re: Interview for AI Engineer", to: TALENT, job_title: "AI Engineer" });
    expect(d.preview).toMatchObject({ account: ALEX, from: { name: "Alex Example", address: ALEX }, to: [{ name: "Acme Talent", address: TALENT }], locked: false, problem: "" });
    expect(d.preview!.text).toBe("Hi,\n\nFriday works.\n\nRegards,\nAlex\n\nAlex Example\nAI Engineer\n");
    const a = R["mail.drafts.propose"](ctx, ...ACME, d.view.draft_id);
    expect(a).toMatchObject({ action: "email_send", status: "pending", created_by: "app", email: { current: true, problem: "" } });
    expect(R["mail.drafts.list"](ctx, ...ACME)[0]).toMatchObject({ status: "waiting", approval_id: a.id });
    expect(R["mail.drafts.all"](ctx).map((v) => v.draft_id)).toEqual([d.view.draft_id]);
  });
  it("marks a proposed email as changed when the draft is edited afterwards", async () => {
    const { ctx } = await seeded();
    const d = R["mail.drafts.save"](ctx, ...ACME, "", draftInput());
    R["mail.drafts.propose"](ctx, ...ACME, d.view.draft_id);
    R["mail.drafts.save"](ctx, ...ACME, d.view.draft_id, draftInput({ body: "Hi,\n\nActually Monday.\n" }));
    const card = (await AP["approvals.list"](ctx)).find((x) => x.action === "email_send")!;
    expect(card.email).toMatchObject({ current: false, problem: "The draft changed. Review it again." });
  });
  it("refuses bad addresses, and files from me/ in plain words even with a grant", async () => {
    const { ctx, root } = await seeded();
    expect(() => R["mail.drafts.save"](ctx, ...ACME, "", draftInput({ to: "not an address" }))).toThrow(/isn't an email address/);
    fs.writeFileSync(path.join(root, "me", "identity", "visa-letter.pdf"), "fictional");
    expect(() => R["mail.drafts.save"](ctx, ...ACME, "", draftInput({ attach: ["me/identity/visa-letter.pdf"] }))).toThrow(ME_NOT_ATTACHABLE);
    allowAccessRequest(root, requestAccess(root, { folder: "me/identity", why: "Attach it" }, ctx.clock()).id, 15, ctx.clock());
    expect(() => R["mail.drafts.save"](ctx, ...ACME, "", draftInput({ attach: ["me/identity/visa-letter.pdf"] }))).toThrow(ME_NOT_ATTACHABLE);
  });
  it("lists drafts Claude wrote with the CLI too", async () => {
    const { ctx, root } = await seeded();
    writeDraft(root, ...LABS, { to: [{ name: "", address: TALENT }], cc: [], subject: "Following up", attach: [], in_reply_to: "", references: [], purpose: "", body: "Hi" });
    expect(R["mail.drafts.list"](ctx, ...LABS).map((v) => [v.subject, v.status])).toEqual([["Following up", "draft"]]);
  });
});

describe("a job folder that can't be used", () => {
  it("is skipped with a plain log line, so Home and all drafts keep working", async () => {
    const { ctx, root } = await seeded();
    R["mail.drafts.save"](ctx, ...ACME, "", draftInput());
    const outside = fs.mkdtempSync(path.join(path.dirname(root), "outside-"));
    fs.cpSync(path.join(root, "companies", ACME[0]), path.join(outside, "linked-co"), { recursive: true });
    fs.symlinkSync(path.join(outside, "linked-co"), path.join(root, "companies", "linked-co"));
    const lines: string[] = [];
    const views = allDrafts(root, (l) => lines.push(l));
    expect(views.map((v) => v.company_slug)).toEqual([ACME[0]]);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) { expect(l).toMatch(/^Drafts for linked-co\//); expect(l).not.toContain(outside); expect(l).not.toContain(root); }
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(R["mail.drafts.all"](ctx).map((v) => v.company_slug)).toEqual([ACME[0]]);
      expect(readHandlers["home.summary"](ctx).nextUp.filter((i) => i.kind === "draft")).toHaveLength(1);
    } finally { console.warn = warn; }
  });
});

describe("home", () => {
  it("counts unread mail and lists replies and drafts", async () => {
    const { ctx } = await seeded();
    R["mail.drafts.save"](ctx, ...LABS, "", draftInput({ subject: "Following up" }));
    const h = readHandlers["home.summary"](ctx);
    expect(h.unreadMail).toBe(3);
    expect(h.nextUp.filter((i) => i.kind === "reply").map((i) => i.title)).toEqual(["Interview for AI Engineer", "Urgent: confirm your details"]);
    expect(h.nextUp.filter((i) => i.kind === "draft").map((i) => i.title)).toEqual(["Following up"]);
  });

  it("shows no unread mail when Gmail isn't connected, but keeps the drafts", async () => {
    const { ctx } = await seeded();
    R["mail.drafts.save"](ctx, ...LABS, "", draftInput({ subject: "Following up" }));
    await mailAccountHandlers["mail.disconnect"](ctx);
    const h = readHandlers["home.summary"](ctx);
    expect(h.unreadMail).toBe(0);
    expect(h.nextUp.filter((i) => i.kind === "reply")).toEqual([]);
    expect(h.nextUp.filter((i) => i.kind === "draft").map((i) => i.title)).toEqual(["Following up"]);
  });

  it("shows no unread mail when this app has no mail support", async () => {
    const x = openSample();
    await storeRaw(x.root, { company_slug: ACME[0], job_id: ACME[1] }, rawMessage({ id: "m1" }));
    expect(readHandlers["home.summary"](x.ctx).unreadMail).toBe(0);
  });
});
