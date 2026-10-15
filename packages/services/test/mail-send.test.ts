import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { allowAccessRequest, ME_NOT_ATTACHABLE, requestAccess, buildDraftMessage, layout, listApprovals, readActivity, readApproval, readDraft, readRecord, setApprovalStatus, updateRecord, writeDraft } from "@careeros/core";
import { ALEX, buildMime, rawMessage, TALENT } from "@careeros/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "../src/context.js";
import { approvalHandlers as AP, CHANGED_SINCE_APPROVED, mailSendHandlers as MS, rememberApproved } from "../src/approvals.js";
import { fakeMailHost } from "../src/fakes.js";
import { mailReadHandlers as R } from "../src/mail-read.js";
import { ALREADY_SENT, DRAFT_UNSURE, readSendLog, reconcileSends, recordSend, sentInLastHour, UNSURE } from "../src/mail-send.js";
import { runSync } from "../src/mail-sync.js";
import { makeCtx, openSample, sampleCopy } from "./helpers.js";
import { approvalDigest } from "../src/read.js";
import { openWorkspace } from "../src/workspace.js";
import { ACME, connectMail, gmailKey, GOOD_PASSWORD, storeRaw } from "./mail-helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

afterEach(() => vi.restoreAllMocks());

const RESUME = `companies/${ACME[0]}/jobs/${ACME[1]}/application/resume.pdf`;
const input = (over = {}) => ({ to: `Acme Talent <${TALENT}>`, cc: "", subject: "Application for AI Engineer", body: "Hi,\n\nPlease find my resume attached.\n\nRegards,\nAlex", attach: [RESUME], in_reply_to: "", references: [], purpose: "apply" as const, ...over });

function setup() {
  const mail = fakeMailHost({ goodPassword: GOOD_PASSWORD });
  const x = openSample({ mail });
  connectMail(x.ctx, x.root);
  const file = path.join(x.root, ...RESUME.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "%PDF-1.4 Alex Example resume");
  const propose = (over = {}) => {
    const d = R["mail.drafts.save"](x.ctx, ...ACME, "", input(over));
    return { draftId: d.view.draft_id, approval: R["mail.drafts.propose"](x.ctx, ...ACME, d.view.draft_id) };
  };
  return { ...x, mail, file, propose };
}

/** Send again with the digest the confirm dialog would show. */
const again = (ctx: ServiceContext, id: string, ok: boolean) => MS["mail.send.again"](ctx, id, approvalDigest(readApproval(ctx.requireRoot(), id)), ok);

/** Approves with the digest the card would show (develop's approvals.approve needs it). */
const approve = (ctx: ServiceContext, id: string) => AP["approvals.approve"](ctx, id, approvalDigest(readApproval(ctx.requireRoot(), id)));

describe("approving an email send", () => {
  it("sends exactly the proposed message once, saves the sent copy and moves the draft", async () => {
    const { ctx, root, mail, propose } = setup();
    const { draftId, approval } = propose();
    const before = readRecord("job", layout(root).jobFile(...ACME));
    const done = await approve(ctx, approval.id);
    expect(done).toMatchObject({ status: "done", result_note: "Sent to 1 recipient" });
    expect(mail.fake.sent).toHaveLength(1);
    const sent = mail.fake.sent[0]!;
    expect(sent.envelope).toEqual({ from: ALEX, to: [TALENT] });
    const head = sent.raw.toString("latin1").split("\r\n\r\n")[0]!;
    expect(head).toContain(`Message-ID: ${String(approval.payload.message_id)}`);
    expect(head).not.toMatch(/^bcc:/im);
    expect(sent.raw.toString("latin1")).toContain('filename=resume.pdf');
    const out = R["mail.list"](ctx, { company_slug: ACME[0], id: ACME[1], direction: "out" }).rows;
    expect(out.map((r) => [r.subject, r.matched_by])).toEqual([["Application for AI Engineer", "user"]]);
    expect(R["mail.get"](ctx, out[0]!.ref).message_id).toBe(approval.payload.message_id);
    expect(readRecord("job", layout(root).jobFile(...ACME)).timeline.at(-1)).toMatchObject({ event: "Email sent", note: "Application for AI Engineer" });
    // Sending never moves the job's status by itself (the sample job is already Applied).
    const after = readRecord("job", layout(root).jobFile(...ACME));
    expect(after.status).toBe(before.status);
    expect(after.timeline.filter((e) => e.event.startsWith("Status:"))).toEqual(before.timeline.filter((e) => e.event.startsWith("Status:")));
    expect(R["mail.drafts.list"](ctx, ...ACME).find((v) => v.draft_id === draftId)?.status).toBe("sent");
  });

  it("sends once when approved twice at the same moment", async () => {
    const { ctx, mail, propose } = setup();
    const { approval } = propose();
    const results = await Promise.allSettled([approve(ctx, approval.id), approve(ctx, approval.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(mail.fake.sent).toHaveLength(1);
    await expect(approve(ctx, approval.id)).rejects.toThrow(/can't become approved/);
    expect(mail.fake.sent).toHaveLength(1);
  });

  it("fails, and sends nothing, when the draft or the signature changed after the proposal", async () => {
    const { ctx, root, mail, propose } = setup();
    const a = propose();
    writeDraft(root, ...ACME, { to: [{ name: "Acme Talent", address: TALENT }], cc: [], subject: "Application for AI Engineer", attach: [RESUME], in_reply_to: "", references: [], purpose: "apply", body: "Hi,\n\nSomething else." }, a.draftId);
    expect(await approve(ctx, a.approval.id)).toMatchObject({ status: "failed", result_note: "The draft changed. Review it again." });
    const b = propose({ subject: "Second try" });
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.signature = "Alex Example\nSenior AI Engineer"; });
    expect(await approve(ctx, b.approval.id)).toMatchObject({ status: "failed", result_note: "The draft changed. Review it again." });
    const c = propose({ subject: "Third try" });
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.display_name = "A. Example"; });
    expect(await approve(ctx, c.approval.id)).toMatchObject({ status: "failed", result_note: "The draft changed. Review it again." });
    expect(mail.fake.sent).toEqual([]);
  });

  it("fails, sends nothing and keeps the draft when an attachment was replaced or deleted after the proposal", async () => {
    const { ctx, mail, file, propose } = setup();
    const a = propose();
    fs.writeFileSync(file, "%PDF-1.4 a different file with the same name");
    expect(await approve(ctx, a.approval.id)).toMatchObject({ status: "failed", result_note: "The draft changed. Review it again." });
    const b = propose({ subject: "Second try" });
    fs.rmSync(file);
    expect(await approve(ctx, b.approval.id)).toMatchObject({ status: "failed", result_note: `"${RESUME}" can't be found. It may have been moved or deleted.` });
    expect(mail.fake.sent).toEqual([]);
    expect(R["mail.drafts.list"](ctx, ...ACME).map((v) => v.status).sort()).toEqual(["failed", "failed"]);
  });

  it("refuses an attachment that became a link after the proposal", async () => {
    const { ctx, root, mail, file, propose } = setup();
    const a = propose();
    const elsewhere = path.join(root, "notes-copy.pdf");
    fs.writeFileSync(elsewhere, "%PDF-1.4 Alex Example resume");
    fs.rmSync(file);
    fs.symlinkSync(elsewhere, file);
    expect(await approve(ctx, a.approval.id)).toMatchObject({ status: "failed", result_note: `"${RESUME}" isn't a regular file.` });
    expect(mail.fake.sent).toEqual([]);
  });

  it("never sends a file from me/, even when the folder is allowed once (only the job's own folder)", async () => {
    const { ctx, root, mail } = setup();
    fs.writeFileSync(path.join(root, "me", "identity", "visa-letter.pdf"), "fictional");
    allowAccessRequest(root, requestAccess(root, { folder: "me/identity", why: "Attach it" }, ctx.clock()).id, 15, ctx.clock());
    expect(() => R["mail.drafts.save"](ctx, ...ACME, "", input({ attach: ["me/identity/visa-letter.pdf"] }))).toThrow(ME_NOT_ATTACHABLE);
    expect(mail.fake.sent).toEqual([]);
  });

  it("stops at the hourly limit", async () => {
    const { ctx, root, mail, propose } = setup();
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.send_limit_per_hour = 1; });
    await approve(ctx, propose().approval.id);
    const second = propose({ subject: "Second" });
    expect(await approve(ctx, second.approval.id)).toMatchObject({
      status: "failed", result_note: `${brand.name} has sent 1 email in the last hour, the most your settings allow. Try again later or raise the limit in Settings > Email.`,
    });
    expect(mail.fake.sent).toHaveLength(1);
  });

  it("keeps the hourly limit across a restart, from what is on disk, and frees it after an hour", async () => {
    const { ctx, root, mail, propose } = setup();
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.send_limit_per_hour = 1; });
    await approve(ctx, propose().approval.id);
    const second = propose({ subject: "Second" });
    // A new window (a fresh context with no memory of the first) reads the same send log.
    const restarted = makeCtx({ mail });
    openWorkspace(restarted.ctx, root);
    restarted.ctx.host.secrets.set(gmailKey(root), GOOD_PASSWORD);
    expect((await approve(restarted.ctx, second.approval.id)).result_note).toMatch(new RegExp(String.raw`^${brand.name} has sent 1 email in the last hour`));
    expect(mail.fake.sent).toHaveLength(1);
    restarted.setNow(new Date(ctx.now().getTime() + 61 * 60_000));
    expect(sentInLastHour(root, restarted.ctx.now())).toBe(0);
    const d = R["mail.drafts.save"](restarted.ctx, ...ACME, "", input({ subject: "Next hour" }));
    const third = R["mail.drafts.propose"](restarted.ctx, ...ACME, d.view.draft_id);
    expect((await approve(restarted.ctx, third.id)).result_note).toBe("Sent to 1 recipient");
    expect(mail.fake.sent).toHaveLength(2);
  });

  it("fails cleanly when Gmail refuses or the account changed", async () => {
    const { ctx, root, mail, propose } = setup();
    const a = propose();
    mail.fake.rejectSendWith = 550;
    const r = await approve(ctx, a.approval.id);
    expect(r.status).toBe("failed");
    expect(r.result_note).toMatch(/^Gmail returned an error: 550/);
    mail.fake.rejectSendWith = null;
    const b = propose({ subject: "Second" });
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.address = "other" + "@" + "example.com"; });
    expect(await approve(ctx, b.approval.id)).toMatchObject({ status: "failed", result_note: "This email was prepared for another Gmail account. Propose it again." });
    expect(mail.fake.sent).toEqual([]);
    expect(R["mail.list"](ctx, { direction: "out" }).total).toBe(0);
    expect(listApprovals(root).filter((x) => x.status === "failed")).toHaveLength(2);
    // A definite refusal doesn't count against the hourly limit, and the draft can be proposed and sent again.
    expect(sentInLastHour(root, ctx.now())).toBe(0);
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.address = ALEX; });
    const again = R["mail.drafts.propose"](ctx, ...ACME, a.draftId);
    expect(await approve(ctx, again.id)).toMatchObject({ status: "done", result_note: "Sent to 1 recipient" });
    expect(mail.fake.sent).toHaveLength(1);
  });

  it("keeps the password and the address out of a Gmail error", async () => {
    const { ctx, mail, propose } = setup();
    const a = propose();
    const send = mail.fake.send.bind(mail.fake);
    mail.fake.send = async () => { throw Object.assign(new Error(`550 rejected for ${ALEX} using ${GOOD_PASSWORD}`), { responseCode: 550, command: "RCPT TO" }); };
    const r = await approve(ctx, a.approval.id);
    mail.fake.send = send;
    expect(r.status).toBe("failed");
    expect(r.result_note).not.toContain(ALEX);
    expect(r.result_note).not.toContain(GOOD_PASSWORD);
    expect(r.result_note).toMatch(/^Gmail returned an error/);
    expect(mail.logs.join("\n")).not.toContain(ALEX);
    expect(mail.logs.join("\n")).not.toContain(GOOD_PASSWORD);
  });

  it("records the send before it leaves, and never sends that draft again after a crash with the outcome unknown", async () => {
    const { ctx, root, mail, propose } = setup();
    const { draftId, approval } = propose();
    // As if the app died after Gmail accepted the message but before anything was recorded:
    // the approval was claimed, the intent written, the message left; nothing after that ran.
    setApprovalStatus(root, approval.id, "approved", "", ctx.clock());
    recordSend(root, { approval: approval.id, draft_id: draftId, company_slug: ACME[0], id: ACME[1], message_id: String(approval.payload.message_id), state: "started" }, ctx.clock());
    // The same approval can't run again.
    await expect(approve(ctx, approval.id)).rejects.toThrow(/can't become approved/);
    // A fresh proposal of the same draft is refused before anything leaves.
    const again = R["mail.drafts.propose"](ctx, ...ACME, draftId);
    expect(await approve(ctx, again.id)).toMatchObject({ status: "failed", result_note: DRAFT_UNSURE });
    expect(mail.fake.sent).toEqual([]);
    // It still counts against the hourly limit.
    expect(sentInLastHour(root, ctx.now())).toBe(1);
  });

  it("writes the intent before the message leaves and the outcome after", async () => {
    const { ctx, root, mail, propose } = setup();
    const { approval } = propose();
    const send = mail.fake.send.bind(mail.fake);
    let atSend: string[] = [];
    mail.fake.send = async (env, raw) => { atSend = readSendLog(root).map((e) => e.state); return send(env, raw); };
    await approve(ctx, approval.id);
    expect(atSend).toEqual(["started"]);
    expect(readSendLog(root).filter((e) => e.approval === approval.id).map((e) => e.state)).toEqual(["started", "sent"]);
    expect(readActivity(root).filter((e) => e.event === "Email sent")).toHaveLength(1);
  });

  it("adds one Email sent event, keyed by Message-ID, even after sync sees the same message in Sent", async () => {
    const { ctx, root, mail, propose } = setup();
    const { approval } = propose();
    await approve(ctx, approval.id);
    const job = () => readRecord("job", layout(root).jobFile(...ACME));
    expect(job().timeline.filter((e) => e.event === "Email sent")).toEqual([expect.objectContaining({ message_id: approval.payload.message_id })]);
    // Gmail files its own copy in Sent; the next sync must neither store it again nor repeat the event.
    mail.fake.add("sent", mail.fake.sent[0]!.raw, ctx.now().toISOString());
    const r = await runSync(ctx);
    expect(r?.duplicates).toBe(1);
    expect(job().timeline.filter((e) => e.event === "Email sent")).toHaveLength(1);
    expect(R["mail.list"](ctx, { direction: "out" }).total).toBe(1);
  });
  it("refuses a draft that was already sent, in plain words", async () => {
    const { ctx, root, propose } = setup();
    const { draftId, approval } = propose();
    const d = readDraft(root, ...ACME, draftId);
    await approve(ctx, approval.id);
    // The move to sent/ didn't happen (say the folder was busy): the draft is still there.
    fs.rmSync(path.join(path.dirname(path.join(root, ...String(approval.payload.draft).split("/"))), "sent", `${draftId}.md`));
    writeDraft(root, ...ACME, d, draftId);
    const again = R["mail.drafts.propose"](ctx, ...ACME, draftId);
    expect(await approve(ctx, again.id)).toMatchObject({ status: "failed", result_note: ALREADY_SENT });
    expect(ALREADY_SENT).toBe("This draft was already sent. To send it again, make a new draft.");
  });
});

describe("a send that may or may not have gone (fix round 0)", () => {
  async function unsure() {
    const x = setup();
    const p = x.propose();
    x.mail.fake.failWith = "network"; // a reset with no final reply
    const r = await approve(x.ctx, p.approval.id);
    x.mail.fake.failWith = null;
    return { ...x, ...p, r };
  }

  it("keeps the approval open as not sure, blocks the draft, and counts it against the limit", async () => {
    const { ctx, root, mail, draftId, approval, r } = await unsure();
    expect(r).toMatchObject({ status: "approved", result_note: UNSURE, unsure: true });
    expect(UNSURE).toBe("Not sure it sent. Check Gmail's Sent folder.");
    expect(AP["approvals.list"](ctx).find((v) => v.id === approval.id)).toMatchObject({ unsure: true, result_note: UNSURE });
    expect(R["mail.drafts.list"](ctx, ...ACME).find((v) => v.draft_id === draftId)).toMatchObject({ status: "unsure", note: UNSURE });
    expect(readSendLog(root).map((e) => e.state)).toEqual(["started", "unknown"]);
    expect(sentInLastHour(root, ctx.now())).toBe(1);
    const again = R["mail.drafts.propose"](ctx, ...ACME, draftId);
    expect(await approve(ctx, again.id)).toMatchObject({ status: "failed", result_note: DRAFT_UNSURE });
    expect(mail.fake.sent).toEqual([]);
  });

  it("Mark as sent finishes it without sending, with one timeline event keyed by Message-ID", async () => {
    const { ctx, root, mail, draftId, approval } = await unsure();
    expect(await MS["mail.send.markSent"](ctx, approval.id)).toMatchObject({ status: "done", result_note: "Marked as sent" });
    expect(mail.fake.sent).toEqual([]);
    const events = readRecord("job", layout(root).jobFile(...ACME)).timeline.filter((e) => e.event === "Email sent");
    expect(events).toEqual([expect.objectContaining({ message_id: approval.payload.message_id })]);
    expect(R["mail.drafts.list"](ctx, ...ACME).find((v) => v.draft_id === draftId)?.status).toBe("sent");
    await expect(MS["mail.send.markSent"](ctx, approval.id)).rejects.toThrow("This email isn't waiting for a check.");
  });

  it("Send again needs an explicit confirm, then sends the same message once", async () => {
    const { ctx, mail, approval } = await unsure();
    await expect(again(ctx, approval.id, false)).rejects.toThrow("Confirm that you want to send this email again.");
    expect(mail.fake.sent).toEqual([]);
    expect(await again(ctx, approval.id, true)).toMatchObject({ status: "done", result_note: "Sent to 1 recipient" });
    expect(mail.fake.sent).toHaveLength(1);
    expect(mail.fake.sent[0]!.raw.toString("latin1")).toContain(`Message-ID: ${String(approval.payload.message_id)}`);
    await expect(again(ctx, approval.id, true)).rejects.toThrow("This email isn't waiting for a check.");
    expect(mail.fake.sent).toHaveLength(1);
  });

  it("shows the exact message again for the Send again dialog", async () => {
    const { ctx, approval } = await unsure();
    const v = AP["approvals.list"](ctx).find((x) => x.id === approval.id)!;
    expect(v).toMatchObject({ unsure: true, status: "approved" });
    expect(v.email?.subject).toBe("Application for AI Engineer");
  });

  it("Send again refuses an approval whose record changed after the person approved it, and sends nothing", async () => {
    const { ctx, root, mail, approval, propose } = await unsure();
    // Someone with write access to the workspace points the approved record at another draft (and its digest).
    const other = propose({ subject: "Something they never reviewed" }).approval;
    const file = path.join(root, ".careeros", "approvals", `${approval.id}.json`);
    const rec = JSON.parse(fs.readFileSync(file, "utf8")) as { payload: Record<string, unknown> };
    rec.payload = { ...rec.payload, draft_id: other.payload.draft_id, draft: other.payload.draft, sha256: other.payload.sha256 };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    await expect(again(ctx, approval.id, true)).rejects.toThrow(CHANGED_SINCE_APPROVED);
    expect(CHANGED_SINCE_APPROVED).toBe("This email changed since you approved it. Review and approve it again.");
    expect(mail.fake.sent).toEqual([]);
  });

  it("Send again refuses an approval the person never approved (forged as approved with an unknown send)", async () => {
    const { ctx, root, mail, propose } = setup();
    const { draftId, approval } = propose();
    setApprovalStatus(root, approval.id, "approved", "", ctx.clock());
    recordSend(root, { approval: approval.id, draft_id: draftId, company_slug: ACME[0], id: ACME[1], message_id: String(approval.payload.message_id), state: "unknown" }, ctx.clock());
    expect(AP["approvals.list"](ctx).find((v) => v.id === approval.id)?.unsure).toBe(true);
    await expect(again(ctx, approval.id, true)).rejects.toThrow(CHANGED_SINCE_APPROVED);
    expect(mail.fake.sent).toEqual([]);
  });

  it("Send again refuses when the dialog showed a different version than the one on disk now", async () => {
    const { ctx, mail, approval } = await unsure();
    await expect(MS["mail.send.again"](ctx, approval.id, "0".repeat(64), true)).rejects.toThrow(CHANGED_SINCE_APPROVED);
    expect(mail.fake.sent).toEqual([]);
  });

  it("Send again that Gmail definitely refuses fails the approval and frees the draft", async () => {
    const { ctx, mail, draftId, approval } = await unsure();
    mail.fake.rejectSendWith = 550;
    expect(await again(ctx, approval.id, true)).toMatchObject({ status: "failed" });
    mail.fake.rejectSendWith = null;
    const next = R["mail.drafts.propose"](ctx, ...ACME, draftId);
    expect(await approve(ctx, next.id)).toMatchObject({ status: "done" });
    expect(mail.fake.sent).toHaveLength(1);
  });

  it("Send again that can't start (the draft changed) leaves it open as not sure", async () => {
    const { ctx, root, mail, draftId, approval } = await unsure();
    const d = readDraft(root, ...ACME, draftId);
    writeDraft(root, ...ACME, { ...d, body: "Hi,\n\nSomething else." }, draftId);
    await expect(again(ctx, approval.id, true)).rejects.toThrow("The draft changed. Review it again.");
    expect(readApproval(root, approval.id)).toMatchObject({ status: "approved", result_note: UNSURE });
    expect(mail.fake.sent).toEqual([]);
  });

  it("after a crash, the next sync finds the message in Sent and marks it sent, with no duplicate", async () => {
    const { ctx, root, mail, propose } = setup();
    const { draftId, approval } = propose();
    const stamp = { message_id: String(approval.payload.message_id), date: String(approval.payload.date) };
    setApprovalStatus(root, approval.id, "approved", "", ctx.clock());
    recordSend(root, { approval: approval.id, draft_id: draftId, company_slug: ACME[0], id: ACME[1], message_id: stamp.message_id, state: "started" }, ctx.clock());
    // The message did leave: Gmail has it in Sent.
    const built = buildDraftMessage(root, ...ACME, draftId, stamp, ctx.clock());
    mail.fake.add("sent", await buildMime(built.message, built.contents), ctx.now().toISOString());
    const first = await runSync(ctx);
    expect(first!.stored + first!.triaged).toBe(1);
    expect(readApproval(root, approval.id)).toMatchObject({ status: "done", result_note: "Sent. Found in Gmail's Sent folder." });
    expect(readSendLog(root).map((e) => e.state)).toEqual(["started", "sent"]);
    expect(readRecord("job", layout(root).jobFile(...ACME)).timeline.filter((e) => e.event === "Email sent")).toEqual([expect.objectContaining({ message_id: stamp.message_id })]);
    expect(R["mail.drafts.list"](ctx, ...ACME).find((v) => v.draft_id === draftId)?.status).toBe("sent");
    // Another sync changes nothing.
    expect((await runSync(ctx))!.stored).toBe(0);
    expect(readSendLog(root)).toHaveLength(2);
    expect(readRecord("job", layout(root).jobFile(...ACME)).timeline.filter((e) => e.event === "Email sent")).toHaveLength(1);
    expect(mail.fake.sent).toEqual([]);
  });

  it("after a crash, opening the workspace shows it as not sure, and a sync that doesn't find it keeps it that way", async () => {
    const { ctx, root, mail, propose } = setup();
    const { draftId, approval } = propose();
    // A crash between Approve and the send: approve() had recorded the approved digest in app state, which survives.
    rememberApproved(ctx, root, approval.id, approvalDigest(readApproval(root, approval.id)));
    setApprovalStatus(root, approval.id, "approved", "", ctx.clock());
    recordSend(root, { approval: approval.id, draft_id: draftId, company_slug: ACME[0], id: ACME[1], message_id: String(approval.payload.message_id), state: "started" }, ctx.clock());
    const restarted = makeCtx({ mail });
    restarted.ctx.host.state.write(ctx.host.state.read());
    restarted.ctx.host.secrets.set(gmailKey(root), GOOD_PASSWORD);
    openWorkspace(restarted.ctx, root);
    expect(readApproval(root, approval.id)).toMatchObject({ status: "approved", result_note: UNSURE });
    expect(AP["approvals.list"](restarted.ctx).find((v) => v.id === approval.id)?.unsure).toBe(true);
    restarted.setNow(new Date(ctx.now().getTime() + 30 * 60_000));
    await runSync(restarted.ctx);
    expect(readApproval(root, approval.id)).toMatchObject({ status: "approved", result_note: UNSURE });
    expect(readSendLog(root).map((e) => e.state)).toEqual(["started", "unknown"]);
    // Both actions are still there.
    expect(await again(restarted.ctx, approval.id, true)).toMatchObject({ status: "done" });
    expect(mail.fake.sent).toHaveLength(1);
  });

  it("never marks a send that is still in flight as not sure", async () => {
    const { ctx, root, mail, propose } = setup();
    const { approval } = propose();
    const send = mail.fake.send.bind(mail.fake);
    let during: string[] = [];
    mail.fake.send = async (env, raw) => { reconcileSends(root, ctx.now()); during = readSendLog(root).map((e) => e.state); return send(env, raw); };
    expect(await approve(ctx, approval.id)).toMatchObject({ status: "done" });
    expect(during).toEqual(["started"]);
  });
});

describe("the hourly limit under concurrent sends (fix round 0)", () => {
  it("sends exactly one of two approvals at the limit minus one", async () => {
    const { ctx, root, mail, propose } = setup();
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.send_limit_per_hour = 2; });
    await approve(ctx, propose().approval.id);
    const a = propose({ subject: "Second" }).approval;
    const b = propose({ subject: "Third" }).approval;
    const results = await Promise.all([approve(ctx, a.id), approve(ctx, b.id)]);
    expect(results.map((r) => r.status).sort()).toEqual(["done", "failed"]);
    expect(mail.fake.sent).toHaveLength(2);
  });

  it("lets exactly one of two processes claim the last send of the hour", async () => {
    const { ctx, root } = setup();
    const now = ctx.now();
    recordSend(root, { approval: "earlier", draft_id: "d0", company_slug: ACME[0], id: ACME[1], message_id: "<earlier@example.com>", state: "started" }, ctx.clock());
    recordSend(root, { approval: "earlier", draft_id: "d0", company_slug: ACME[0], id: ACME[1], message_id: "<earlier@example.com>", state: "sent" }, ctx.clock());
    const src = path.resolve(import.meta.dirname, "../src");
    const child = (n: number) => new Promise<string>((resolve) => {
      const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(src, "mail-send.ts")).href)});
        // Hold the critical section open so the two processes overlap inside it.
        m._sendHooks.afterCheck = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
        try { m.claimSend(${JSON.stringify(root)}, { approval: "p${n}", draft_id: "d${n}", company_slug: "${ACME[0]}", id: "${ACME[1]}", message_id: "<p${n}@example.com>" }, { limit: 2, now: new Date(${JSON.stringify(now.toISOString())}), again: false }, { now: new Date(${JSON.stringify(now.toISOString())}) }); process.stdout.write("claimed"); }
        catch (e) { process.stdout.write("refused: " + e.message); }`;
      execFile(process.execPath, ["--no-warnings", "--import", "tsx", "--input-type=module", "-e", code], { cwd: src, encoding: "utf8", timeout: 60_000 }, (_e, out) => resolve(String(out)));
    });
    const outs = await Promise.all([child(1), child(2)]);
    expect(outs.filter((o) => o === "claimed")).toHaveLength(1);
    expect(outs.find((o) => o !== "claimed")).toMatch(new RegExp(String.raw`^refused: ${brand.name} has sent 2 emails in the last hour`));
    expect(readSendLog(root).filter((e) => e.state === "started")).toHaveLength(2);
  }, 60_000);
});

describe("fix round 1", () => {
  it("fsyncs the approval claim and the journal's started line before the message goes to Gmail", async () => {
    const { ctx, root, mail, propose } = setup();
    const { approval } = propose();
    const names = new Map<number, string>();
    const events: string[] = [];
    const open = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => { const fd = (open as (...a: unknown[]) => number)(p, ...rest); names.set(fd, String(p)); return fd; }) as typeof fs.openSync);
    const fsync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => { events.push(`fsync ${path.relative(root, names.get(fd) ?? "?").split(path.sep).join("/")}`); fsync(fd); });
    const send = mail.fake.send.bind(mail.fake);
    mail.fake.send = async (env, raw) => {
      events.push(`journal ${readSendLog(root).map((e) => e.state).join(",")}`);
      events.push("send");
      return send(env, raw);
    };
    expect(await approve(ctx, approval.id)).toMatchObject({ status: "done" });
    const before = events.slice(0, events.indexOf("send"));
    // The claim: the approval file's new content, then its folder (the rename).
    expect(before.some((e) => /^fsync \.careeros\/approvals\/.*\.tmp$/.test(e))).toBe(true);
    expect(before).toContain("fsync .careeros/approvals");
    // The intent: the journal line, and .careeros itself since the journal was just created.
    expect(before).toContain("fsync .careeros/mail-sends.jsonl");
    expect(before).toContain("fsync .careeros");
    expect(before).toContain("journal started");
    // The claim is made durable before the intent is written.
    expect(before.indexOf("fsync .careeros/approvals")).toBeLessThan(before.indexOf("fsync .careeros/mail-sends.jsonl"));
  });

  it("doesn't take an incoming message with the same Message-ID as proof that a send went", async () => {
    const { ctx, root, propose } = setup();
    const { draftId, approval } = propose();
    const messageId = String(approval.payload.message_id);
    setApprovalStatus(root, approval.id, "approved", "", ctx.clock());
    recordSend(root, { approval: approval.id, draft_id: draftId, company_slug: ACME[0], id: ACME[1], message_id: messageId, state: "started" }, ctx.clock());
    // Someone else's message (or a planted one) carrying the same Message-ID, stored as incoming.
    await storeRaw(root, { company_slug: ACME[0], job_id: ACME[1] }, rawMessage({ from: TALENT, id: null, extraHeaders: [`Message-ID: ${messageId}`] }));
    reconcileSends(root, ctx.now(), ctx.clock());
    expect(readApproval(root, approval.id)).toMatchObject({ status: "approved", result_note: UNSURE });
    expect(readSendLog(root).map((e) => e.state)).toEqual(["started", "unknown"]);
  });

  it("Send again looks in the synced Sent mail first, and marks it sent instead of sending twice", async () => {
    const { ctx, root, mail, propose } = setup();
    const { draftId, approval } = propose();
    mail.fake.failWith = "network";
    await approve(ctx, approval.id);
    mail.fake.failWith = null;
    // A background sync stored Gmail's Sent copy but its reconcile pass didn't run.
    const stamp = { message_id: String(approval.payload.message_id), date: String(approval.payload.date) };
    const built = buildDraftMessage(root, ...ACME, draftId, stamp, ctx.clock());
    await storeRaw(root, { company_slug: ACME[0], job_id: ACME[1] }, await buildMime(built.message, built.contents), { direction: "out" });
    expect(await again(ctx, approval.id, true)).toMatchObject({ status: "done", result_note: "Already in Gmail's Sent folder, so it wasn't sent again." });
    expect(mail.fake.sent).toEqual([]);
    expect(readSendLog(root).map((e) => e.state)).toEqual(["started", "unknown", "sent"]);
    expect(readRecord("job", layout(root).jobFile(...ACME)).timeline.filter((e) => e.event === "Email sent")).toHaveLength(1);
  });
});

describe("a send in flight when the person switches workspace", () => {
  it("finishes, and its result is recorded in the workspace it started in", async () => {
    const { ctx, root: a, mail, propose } = setup();
    const b = sampleCopy();
    const { draftId, approval } = propose();
    const real = mail.fake.send.bind(mail.fake);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inSend = new Promise<void>((r) => { entered = r; });
    vi.spyOn(mail.fake, "send").mockImplementation(async (env, raw) => { entered(); await held; return real(env, raw); });
    const bBefore = { approvals: listApprovals(b).length, log: readSendLog(b).length, activity: readActivity(b).length, job: readRecord("job", layout(b).jobFile(...ACME)).timeline.length };

    const done = approve(ctx, approval.id);
    await inSend;
    openWorkspace(ctx, b);
    release();
    expect(await done).toMatchObject({ status: "done", result_note: "Sent to 1 recipient" });

    expect(mail.fake.sent).toHaveLength(1);
    expect(ctx.requireRoot()).toBe(b);
    expect(readApproval(a, approval.id)).toMatchObject({ status: "done", result_note: "Sent to 1 recipient" });
    expect(readSendLog(a).at(-1)).toMatchObject({ approval: approval.id, state: "sent" });
    expect(readRecord("job", layout(a).jobFile(...ACME)).timeline.at(-1)).toMatchObject({ event: "Email sent" });
    expect(readActivity(a).map((e) => e.event)).toEqual(expect.arrayContaining(["Email sent", "Approved"]));
    expect(fs.existsSync(path.join(path.dirname(path.join(a, ...String(approval.payload.draft).split("/"))), "sent", `${draftId}.md`))).toBe(true);
    // Nothing leaked into the workspace that was opened meanwhile.
    expect({ approvals: listApprovals(b).length, log: readSendLog(b).length, activity: readActivity(b).length, job: readRecord("job", layout(b).jobFile(...ACME)).timeline.length }).toEqual(bBefore);
  });
});
