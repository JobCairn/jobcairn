import fs from "node:fs";
import path from "node:path";
import { careerosDir, layout, readRecord, updateRecord } from "@careeros/core";
import { addr, rawMessage, statusAdvice, type MailSignal } from "@careeros/mail";
import { JOB_STATUSES, MAIL_UPDATE_STATUSES, mailUpdateApplies } from "@careeros/contract";
import { describe, expect, it } from "vitest";
import { fakeMailHost } from "../src/fakes.js";
import { HANDLERS as handlers } from "../src/dispatch.js";
import { runSync } from "../src/mail-sync.js";
import {
  acceptMailUpdate, dismissMailUpdate, mailUpdates, readSuggestions, recordSuggestions,
} from "../src/mail-suggestions.js";
import { openSample, FIXED } from "./helpers.js";
import { ACME, connectMail, LABS, storeRaw } from "./mail-helpers.js";

const file = (root: string) => path.join(careerosDir(root), "mail-suggestions.json");

async function seeded() {
  const x = openSample({ mail: fakeMailHost() });
  const acme = { company_slug: ACME[0], job_id: ACME[1] };
  const labs = { company_slug: LABS[0], job_id: LABS[1] };
  const invite = await storeRaw(x.root, acme, rawMessage({ id: "i1", subject: "Interview invitation" }), { uid: 21 });
  const ack = await storeRaw(x.root, labs, rawMessage({ id: "a1", subject: "We received your application" }), { uid: 22 });
  const interview = { ...acme, to: "Interview", note: "The employer asked to talk or interview (email of 14 January 2026).", ref: invite };
  const applied = { ...labs, to: "Applied", note: "The employer acknowledged your application (email of 14 January 2026).", ref: ack };
  return { ...x, invite, ack, interview, applied };
}

describe("Updates from your mail: saving what sync suggests", () => {
  it("keeps each suggestion once, by job, status and email", async () => {
    const { root, interview, applied } = await seeded();
    expect(recordSuggestions(root, [interview, applied, interview], FIXED)).toBe(2);
    expect(recordSuggestions(root, [interview], FIXED)).toBe(0);
    const list = mailUpdates(root);
    expect(list.map((u) => [u.job_title, u.company_name, u.status, u.to])).toEqual([
      ["Backend Engineer (LLM)", "Example Labs", "Found", "Applied"], ["AI Engineer", "Acme Corp", "Applied", "Interview"],
    ]);
    expect(list[1]).toMatchObject({ note: interview.note, ref: interview.ref, at: FIXED.toISOString() });
  });

  it("never keeps one the job has already reached, or one that makes no sense for a closed job", async () => {
    const { root, interview, applied } = await seeded();
    updateRecord("job", layout(root).jobFile(...LABS), (j) => { j.status = "Applied"; });
    updateRecord("job", layout(root).jobFile(...ACME), (j) => { j.status = "Withdrawn"; });
    expect(recordSuggestions(root, [interview, applied], FIXED)).toBe(0);
    expect(mailUpdates(root)).toEqual([]);
  });

  it("keeps a no for a job marked No response", async () => {
    const { root, interview } = await seeded();
    updateRecord("job", layout(root).jobFile(...ACME), (j) => { j.status = "No response"; });
    expect(recordSuggestions(root, [{ ...interview, to: "Rejected", note: "The employer said no." }], FIXED)).toBe(1);
    expect(mailUpdates(root).map((u) => u.to)).toEqual(["Rejected"]);
  });

  it("drops one from the list when the job moves on by hand, or the email is moved away", async () => {
    const { root, interview, applied, ack } = await seeded();
    recordSuggestions(root, [interview, applied], FIXED);
    updateRecord("job", layout(root).jobFile(...ACME), (j) => { j.status = "Interview"; });
    fs.rmSync(path.join(root, ack));
    expect(mailUpdates(root)).toEqual([]);
    // The next sync tidies the file too.
    recordSuggestions(root, [], FIXED);
    expect(readSuggestions(root).pending).toEqual([]);
  });

  it("ignores suggestions that aren't a known status or job", async () => {
    const { root, interview } = await seeded();
    expect(recordSuggestions(root, [{ ...interview, to: "Withdrawn" }, { ...interview, job_id: "Not a slug" }, { ...interview, job_id: "2026-01-01-gone" }], FIXED)).toBe(0);
  });

  it("reads a missing or broken file as empty, and recovers on the next write", async () => {
    const { root, interview } = await seeded();
    expect(readSuggestions(root)).toEqual({ schema: 1, pending: [], dismissed: [] });
    fs.writeFileSync(file(root), "{ not json");
    expect(mailUpdates(root)).toEqual([]);
    fs.writeFileSync(file(root), JSON.stringify({ pending: [{ company_slug: "../x", job_id: 3 }, "junk", null], dismissed: "nope" }));
    expect(readSuggestions(root)).toEqual({ schema: 1, pending: [], dismissed: [] });
    expect(recordSuggestions(root, [interview], FIXED)).toBe(1);
    expect(JSON.parse(fs.readFileSync(file(root), "utf8")).pending).toHaveLength(1);
  });
});

describe("Updates from your mail: accept and dismiss", () => {
  it("Update sets the status the usual way, with a note that it came from an email", async () => {
    const { ctx, root, interview, applied } = await seeded();
    recordSuggestions(root, [interview, applied], FIXED);
    const left = acceptMailUpdate(ctx, ACME[0], ACME[1], "Interview", interview.ref);
    expect(left.map((u) => u.to)).toEqual(["Applied"]);
    const job = readRecord("job", layout(root).jobFile(...ACME));
    expect(job.status).toBe("Interview");
    expect(job.timeline.at(-1)).toMatchObject({ event: "Status: Interview", note: `From an email: ${interview.note}`, at: FIXED.toISOString() });
    // The index sees it straight away, like jobs.setStatus.
    expect((handlers["jobs.list"] as (c: typeof ctx, q: object) => { rows: { id: string; status: string }[] })(ctx, {}).rows.find((r) => r.id === ACME[1])?.status).toBe("Interview");
  });

  it("Update to Applied starts the follow-up clock, as setting Applied by hand does", async () => {
    const { ctx, root, applied } = await seeded();
    recordSuggestions(root, [applied], FIXED);
    acceptMailUpdate(ctx, LABS[0], LABS[1], "Applied", applied.ref);
    const job = readRecord("job", layout(root).jobFile(...LABS));
    expect(job.status).toBe("Applied");
    expect(job.custom.follow_up_on).toBeTruthy();
  });

  it("Update refuses, and forgets it, when the job has moved on since", async () => {
    const { ctx, root, interview } = await seeded();
    recordSuggestions(root, [interview], FIXED);
    updateRecord("job", layout(root).jobFile(...ACME), (j) => { j.status = "Offer"; });
    expect(() => acceptMailUpdate(ctx, ACME[0], ACME[1], "Interview", interview.ref)).toThrow("This job has already moved on, so its status wasn't changed.");
    expect(readRecord("job", layout(root).jobFile(...ACME)).status).toBe("Offer");
    expect(readSuggestions(root).pending).toEqual([]);
  });

  it("Update on one that isn't waiting changes nothing", async () => {
    const { ctx, root, interview } = await seeded();
    expect(() => acceptMailUpdate(ctx, ACME[0], ACME[1], "Interview", interview.ref)).toThrow("This update is no longer waiting.");
    expect(readRecord("job", layout(root).jobFile(...ACME)).status).toBe("Applied");
  });

  it("Dismiss forgets it for good: the same email never suggests it again", async () => {
    const { ctx, root, interview } = await seeded();
    recordSuggestions(root, [interview], FIXED);
    expect(dismissMailUpdate(ctx, ACME[0], ACME[1], "Interview", interview.ref)).toEqual([]);
    expect(readRecord("job", layout(root).jobFile(...ACME)).status).toBe("Applied");
    expect(recordSuggestions(root, [interview], FIXED)).toBe(0);
    expect(mailUpdates(root)).toEqual([]);
  });

  it("is on the bridge, with Home's count while Gmail is connected", async () => {
    const { ctx, root, interview } = await seeded();
    recordSuggestions(root, [interview], FIXED);
    expect(await handlers["mail.updates.list"](ctx)).toHaveLength(1);
    const home = () => (handlers["home.summary"] as (c: typeof ctx) => { mailUpdates?: number })(ctx).mailUpdates;
    expect(home()).toBe(0);
    connectMail(ctx, root);
    expect(home()).toBe(1);
  });
});

describe("Updates from your mail: the sync keeps what it suggests", () => {
  it("an interview invite for an applied job waits in the list after a sync", async () => {
    const mail = fakeMailHost({ goodPassword: "abcdefghijklmnop" });
    const x = openSample({ mail });
    connectMail(x.ctx, x.root);
    mail.fake.add("inbox", rawMessage({ id: "s9", from: addr("talent", "example.org"), subject: "Interview invitation: AI Engineer",
      text: "Hi Alex,\r\n\r\nWe'd like to invite you to an interview for the AI Engineer role.\r\n\r\nAcme Talent" }), "2026-01-14T09:00:00.000Z");
    updateRecord("company", layout(x.root).companyFile(ACME[0]), (c) => { c.recruiter.email = addr("talent", "example.org"); });
    const r = await runSync(x.ctx);
    expect(r?.suggestions.map((s) => s.to)).toEqual(["Interview"]);
    const list = mailUpdates(x.root);
    expect(list).toEqual([expect.objectContaining({ company_slug: ACME[0], job_id: ACME[1], to: "Interview", ref: r!.suggestions[0]!.ref })]);
    // Nothing changed without a click.
    expect(readRecord("job", layout(x.root).jobFile(...ACME)).status).toBe("Applied");
  });
});

describe("mailUpdateApplies matches the sync's own rules", () => {
  it("agrees with statusAdvice for every status and signal", () => {
    const signalOf: Record<string, MailSignal> = { Applied: "acknowledged", Interview: "interview", Rejected: "rejected", Offer: "offer" };
    for (const status of JOB_STATUSES) {
      for (const to of MAIL_UPDATE_STATUSES) {
        const a = statusAdvice(status, [signalOf[to]!]);
        // Whatever sync suggests still applies; Applying + acknowledged is a move sync makes itself.
        if (a.kind === "suggest") expect(mailUpdateApplies(status, a.to), `${status} -> ${to}`).toBe(true);
        if (a.kind === "none" || a.kind === "check") expect(mailUpdateApplies(status, to), `${status} -> ${to}`).toBe(false);
      }
    }
  });
});
