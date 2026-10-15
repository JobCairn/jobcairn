import fs from "node:fs";
import path from "node:path";
import { layout, readRecord, updateRecord } from "@careeros/core";
import { addr, listTriage, rawMessage, readMailState, RECHECK_VERSION, updateStored, writeMailState } from "@careeros/mail";
import { describe, expect, it } from "vitest";
import { fakeMailHost } from "../src/fakes.js";
import { mailReadHandlers as R } from "../src/mail-read.js";
import { recheckApply, recheckDismiss, recheckPreview } from "../src/mail-recheck.js";
import { syncInfo } from "../src/mail-account.js";
import { openSample } from "./helpers.js";
import { ACME, connectMail, storeRaw } from "./mail-helpers.js";

async function seeded() {
  const x = openSample({ mail: fakeMailHost() });
  connectMail(x.ctx, x.root);
  updateRecord("company", layout(x.root).companyFile(ACME[0]), (c) => { c.website = "https://acme.example.com"; });
  const at = { company_slug: ACME[0], job_id: ACME[1] };
  // What the old rules filed under Acme by its domain: the platform's own account notice, and a job board's welcome.
  const notice = await storeRaw(x.root, at, rawMessage({ id: "n1", from: addr("noreply-accounts", "acme.example.com"), subject: "Review your Acme Account settings" }), { uid: 11 });
  const welcome = await storeRaw(x.root, at, rawMessage({ id: "w1", from: addr("noreply", "seek.com.au"), subject: "Welcome to SEEK, your application starts here" }), { uid: 12 });
  // Still right: a person at Acme. And one you moved yourself, which is never touched.
  const person = await storeRaw(x.root, at, rawMessage({ id: "p1", from: addr("jordan.lee", "acme.example.com"), subject: "Next steps" }), { uid: 13 });
  const mine = await storeRaw(x.root, at, rawMessage({ id: "u1", from: addr("noreply", "acme.example.com"), subject: "Your Acme Account" }), { uid: 14 });
  updateStored(x.root, mine, (e) => { e.matched_by = "user"; });
  for (const ref of [notice, welcome, person]) updateStored(x.root, ref, (e) => { e.matched_by = "domain"; });
  const noticeId = R["mail.get"](x.ctx, notice).message_id;
  updateRecord("job", layout(x.root).jobFile(ACME[0], ACME[1]), (j) => { j.timeline.push({ at: "2026-01-14T09:00:00.000Z", event: "Email received", note: "Review your Acme Account settings", message_id: noticeId }); });
  return { ...x, notice, welcome, person, mine, noticeId };
}

describe("Re-check filed mail", () => {
  it("previews what today's rules would move, without changing anything", async () => {
    const { ctx, notice, welcome } = await seeded();
    const p = recheckPreview(ctx);
    expect(p).toMatchObject({ due: true, sort: 1, unfile: 1 });
    expect(p.token).toMatch(/^[0-9a-f]{64}$/);
    expect(p.items.map((i) => [i.ref, i.outcome, i.company_name, i.job_title])).toEqual(expect.arrayContaining([
      [notice, "unfile", "Acme Corp", "AI Engineer"], [welcome, "sort", "Acme Corp", "AI Engineer"],
    ]));
    expect(p.items).toHaveLength(2);
    expect(R["mail.get"](ctx, notice).company_slug).toBe(ACME[0]);
  });

  it("applies exactly the previewed list: to Mail to sort, unfiled, job timeline cleaned, offered once", async () => {
    const { ctx, root, notice, welcome, person, mine, noticeId } = await seeded();
    const p = recheckPreview(ctx);
    expect(recheckApply(ctx, p.token)).toEqual({ sorted: 1, unfiled: 1 });
    const refs = R["mail.list"](ctx, {}).rows.map((r) => r.ref);
    expect(refs).toEqual(expect.arrayContaining([person, mine]));
    expect(refs).not.toContain(notice);
    expect(refs).not.toContain(welcome);
    const sorted = listTriage(root).filter((t) => t.email.subject.startsWith("Welcome to SEEK"));
    expect(sorted).toHaveLength(1);
    expect(sorted[0]!.email.matched_by).toBe("none");
    expect(fs.existsSync(path.join(root, notice))).toBe(false);
    expect(readRecord("job", layout(root).jobFile(ACME[0], ACME[1])).timeline.some((e) => e.message_id === noticeId)).toBe(false);
    expect(readMailState(root).recheck).toBe(RECHECK_VERSION);
    expect(recheckPreview(ctx)).toMatchObject({ due: false, sort: 0, unfile: 0, items: [] });
  });

  it("refuses a stale preview, and while a sync runs", async () => {
    const { ctx, root, person } = await seeded();
    const p = recheckPreview(ctx);
    updateStored(root, person, (e) => { e.from = { name: "", address: addr("notifications", "acme.example.com") }; });
    expect(() => recheckApply(ctx, p.token)).toThrow("The filed mail changed since you looked. Check the list again, then confirm.");
    const fresh = recheckPreview(ctx);
    syncInfo(ctx, root).syncing = true;
    expect(() => recheckApply(ctx, fresh.token)).toThrow("A mail sync is running. Try again when it finishes.");
    syncInfo(ctx, root).syncing = false;
    expect(recheckApply(ctx, fresh.token)).toEqual({ sorted: 1, unfiled: 2 });
  });

  it("marks the automatic offer seen without moving anything, and keeps it across a sync's state write", async () => {
    const { ctx, root } = await seeded();
    recheckDismiss(ctx);
    expect(recheckPreview(ctx)).toMatchObject({ due: false, sort: 1, unfile: 1 });
    writeMailState(root, { ...readMailState(root), last_run: "2026-01-16T09:00:00.000Z" });
    expect(readMailState(root).recheck).toBe(RECHECK_VERSION);
  });
});
