import fs from "node:fs";
import path from "node:path";
import { layout, readRecord, writeDraft, writeRecord } from "@careeros/core";
import { addr, rawMessage } from "@careeros/mail";
import { SUGGESTION_UNREADABLE } from "@careeros/contract";
import { describe, expect, it } from "vitest";
import { fakeMailHost } from "../src/fakes.js";
import { draftAssist, emailRequest, suggestionRel } from "../src/mail-ai.js";
import { mailReadHandlers as R } from "../src/mail-read.js";
import { claudeArgs, MAIL_READING_ACTIONS, runMode } from "../src/claude/args.js";
import { openSample } from "./helpers.js";
import { ACME, connectMail, storeRaw } from "./mail-helpers.js";

const JORDAN = addr("jordan.lee", "acme.example.com");
const T = { kind: "job" as const, company_slug: ACME[0], id: ACME[1] };
const draft = (over = {}) => ({ to: [], cc: [], subject: "Re: Interview", attach: [], in_reply_to: "", references: [], purpose: "" as const, body: "Hi,\n\nFriday works.\n\nRegards,\nAlex", ...over });

async function setup() {
  const x = openSample({ mail: fakeMailHost() });
  connectMail(x.ctx, x.root);
  const ref = await storeRaw(x.root, { company_slug: ACME[0], job_id: ACME[1] }, rawMessage({ id: "m1", subject: "Interview for AI Engineer" }));
  const msgId = R["mail.get"](x.ctx, ref).message_id;
  return { ...x, msgId };
}

describe("emailRequest (main's mapping of the composer's request)", () => {
  it("turns thread on only when the saved draft answers an email stored in this job", async () => {
    const { root, msgId } = await setup();
    const reply = writeDraft(root, ACME[0], ACME[1], draft({ in_reply_to: msgId }));
    expect(emailRequest(root, T, { options: { purpose: "reply", mode: "new", draft_id: reply.draft_id } }).options).toEqual({ purpose: "reply", mode: "new", draft_id: reply.draft_id, thread: true });
    const other = writeDraft(root, ACME[0], ACME[1], draft({ in_reply_to: "<not-here@example.org>" }));
    expect(emailRequest(root, T, { options: { purpose: "reply", mode: "new", draft_id: other.draft_id } }).options?.thread).toBeUndefined();
  });

  it("ignores a thread flag sent by the renderer", async () => {
    const { root } = await setup();
    const d = writeDraft(root, ACME[0], ACME[1], draft());
    expect(emailRequest(root, T, { options: { purpose: "custom", mode: "new", draft_id: d.draft_id, thread: true } }).options?.thread).toBeUndefined();
  });

  it("refuses a draft that isn't this job's, and a rework of nothing", async () => {
    const { root } = await setup();
    expect(() => emailRequest(root, T, { options: { mode: "new", draft_id: "q-nope" } })).toThrow(/Save the draft first/);
    expect(() => emailRequest(root, T, { options: { mode: "shorter" } })).toThrow(/Write something first/);
    const empty = writeDraft(root, ACME[0], ACME[1], draft({ body: "" }));
    expect(() => emailRequest(root, T, { options: { mode: "grammar", draft_id: empty.draft_id } })).toThrow(/Write something first/);
  });

  it("refuses a third follow-up on one application, and still reworks an existing draft", async () => {
    const { root } = await setup();
    const file = layout(root).jobFile(ACME[0], ACME[1]);
    expect(emailRequest(root, T, { options: { purpose: "follow_up", mode: "new" } }).options?.purpose).toBe("follow_up");
    const j = readRecord("job", file);
    j.timeline.push({ at: "2026-10-01T00:00:00.000Z", event: "Email sent", note: "Following up: AI Engineer application" },
      { at: "2026-10-09T00:00:00.000Z", event: "Email sent", note: "Following up: AI Engineer application" });
    writeRecord("job", file, j);
    expect(() => emailRequest(root, T, { options: { purpose: "follow_up", mode: "new" } })).toThrow(/followed up twice/);
    expect(emailRequest(root, T, { options: { purpose: "thank_you", mode: "new" } }).options?.purpose).toBe("thank_you");
  });
});

describe("draftAssist", () => {
  it("has no suggestion before Claude writes one, and offers the company's recruiter as the recipient", async () => {
    const { ctx, root } = await setup();
    const file = layout(root).companyFile(ACME[0]);
    const c = readRecord("company", file);
    writeRecord("company", file, { ...c, recruiter: { ...c.recruiter, name: "Jordan Lee", email: JORDAN } });
    const a = draftAssist(ctx, ACME[0], ACME[1]);
    expect(a.suggestion).toBeNull();
    expect(a.problem).toBe("");
    expect(a.recipient).toEqual({ name: "Jordan Lee", address: JORDAN });
  });

  it("reads Claude's suggestion, cleaned", async () => {
    const { ctx, root } = await setup();
    const abs = path.join(root, suggestionRel(ACME[0], ACME[1]));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify({ subject: "Following up — AI Engineer", body: "Hi,\n\nThanks.\n\nRegards,\nAlex" }));
    const a = draftAssist(ctx, ACME[0], ACME[1]);
    expect(a.suggestion).toMatchObject({ subject: "Following up, AI Engineer", body: "Hi,\n\nThanks.\n\nRegards,\nAlex" });
  });

  it("says when the file can't be read, and never follows a link", async () => {
    const { ctx, root } = await setup();
    const abs = path.join(root, suggestionRel(ACME[0], ACME[1]));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "not json");
    expect(draftAssist(ctx, ACME[0], ACME[1]).problem).toBe(SUGGESTION_UNREADABLE);
    fs.rmSync(abs);
    const outside = path.join(root, "..", "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ subject: "x", body: "y" }));
    fs.symlinkSync(outside, abs);
    expect(draftAssist(ctx, ACME[0], ACME[1]).suggestion).toBeNull();
  });

  it("writes the suggestion outside the drafts folder, so it is never listed as a draft or a message", async () => {
    expect(suggestionRel(ACME[0], ACME[1])).toBe(`companies/${ACME[0]}/jobs/${ACME[1]}/emails/suggested/draft.json`);
    const { ctx, root } = await setup();
    const abs = path.join(root, suggestionRel(ACME[0], ACME[1]));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify({ subject: "x", body: "y" }));
    expect(R["mail.drafts.list"](ctx, ACME[0], ACME[1])).toEqual([]);
    expect(R["mail.list"](ctx, { company_slug: ACME[0], id: ACME[1] }).total).toBe(1);
  });
});

describe("a run that reads mail", () => {
  it("never gets auto mode, so it can write only its own file", () => {
    expect(MAIL_READING_ACTIONS).toContain("draft_email");
    expect(runMode({ action: "draft_email", folder: "companies/a/jobs/b/emails/suggested", files: ["companies/a/jobs/b/emails/suggested/draft.json"], web: false, mcp: [] }, "auto")).toBe("dontAsk");
    const plan = { action: "draft_email" as const, folder: "companies/a/jobs/b/emails/suggested", files: ["companies/a/jobs/b/emails/suggested/draft.json"], web: false, mcp: [] };
    const args = claudeArgs(plan, ["identity", "employment"], { root: "/ws", pluginDir: "/plugin", mcp: { command: "node", args: [] }, mode: "auto" });
    expect(args).not.toContain("Edit(./**)");
    expect(args).toContain("Edit(./companies/a/jobs/b/emails/suggested/draft.json)");
    expect(args).not.toContain("WebFetch");
    expect(runMode({ action: "score_job", folder: "companies/a/jobs/b", files: ["companies/a/jobs/b/score.md"], web: false, mcp: [] }, "auto")).toBe("auto");
  });
});
