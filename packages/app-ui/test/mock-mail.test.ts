import { METHODS } from "@careeros/contract";
import { describe, expect, it } from "vitest";
import { MOCK_GOOD_PASSWORD } from "../src/mock/mail-mock";
import { MockBridge } from "../src/mock/MockBridge";

const ADDRESS = "alex" + "@" + "example.com";
const ACME = ["acme-corp", "2026-01-12-ai-engineer"] as const;
const reply = { to: "talent" + "@" + "example.org", cc: "", subject: "Re: Interview", body: "Friday works.", attach: [], in_reply_to: "", references: [], purpose: "" as const };

describe("MockBridge mail", () => {
  it("implements every contract method", () => {
    const b = new MockBridge() as unknown as Record<string, unknown>;
    // chrome is optional in the bridge (previews and older shells); the mock doesn't offer it.
    for (const m of Object.keys(METHODS).filter((x) => !x.startsWith("chrome."))) {
      const fn = m.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], b);
      expect(typeof fn, m).toBe("function");
    }
  });
  it("connects only after a passing test and never records the password", async () => {
    const b = new MockBridge({ mailConnected: false });
    expect((await b.mail.status()).connected).toBe(false);
    expect((await b.mail.testConnection(ADDRESS, "Alex Example", "zzzz yyyy xxxx wwww")).ok).toBe(false);
    await expect(b.mail.saveAccount(ADDRESS, "Alex Example")).rejects.toThrow(/Test the connection first/);
    expect((await b.mail.testConnection(ADDRESS, "Alex Example", MOCK_GOOD_PASSWORD)).ok).toBe(true);
    expect(await b.mail.saveAccount(ADDRESS, "Alex Example")).toMatchObject({ connected: true, address: ADDRESS });
    expect(JSON.stringify(b.calls)).not.toContain(MOCK_GOOD_PASSWORD);
    expect(JSON.stringify(await b.mail.status())).not.toContain(MOCK_GOOD_PASSWORD);
  });
  it("checks the real password against the contract, even though it records it redacted", async () => {
    const b = new MockBridge({ mailConnected: false });
    await expect(b.mail.testConnection(ADDRESS, "Alex Example", "")).rejects.toThrow(/is required/);
    expect(JSON.stringify(b.calls)).toContain("<redacted>");
  });
  it("lists mail, marks it read and keeps images blocked until asked", async () => {
    const b = new MockBridge();
    const list = await b.mail.list({});
    expect(list.total).toBe(3);
    const first = list.rows[0]!;
    expect(first.opened).toBe(false);
    const v = await b.mail.get(first.ref);
    expect(v.images_allowed).toBe(false);
    expect((await b.mail.loadImages(first.ref)).images_allowed).toBe(true);
    expect((await b.mail.list({ unread: true })).rows.map((r) => r.ref)).not.toContain(first.ref);
    expect(b.mailUrl(first.ref)).toMatch(/^careeros-mail:\/\/msg\//);
  });
  it("refuses a path that isn't a stored email", async () => {
    await expect(new MockBridge().mail.get("settings/profile.json")).rejects.toThrow(/invalid format/);
  });
  it("sends a proposed draft only on approve", async () => {
    const b = new MockBridge();
    const d = await b.mail.drafts.save(...ACME, "", reply);
    expect(d.preview?.text).toBe("Friday works.\n\nAlex Example\nAI Engineer\n");
    const a = await b.mail.drafts.propose(...ACME, d.view.draft_id);
    expect(a.from_app).toBe(true);
    expect((await b.approvals.list()).find((x) => x.id === a.id)?.email?.subject).toBe("Re: Interview");
    expect((await b.mail.list({ direction: "out" })).total).toBe(1);
    expect(await b.approvals.approve(a.id, a.digest)).toMatchObject({ status: "done", result_note: "Sent to 1 recipient" });
    expect((await b.mail.list({ direction: "out" })).total).toBe(2);
    expect((await b.mail.drafts.list(...ACME)).find((x) => x.draft_id === d.view.draft_id)?.status).toBe("sent");
    expect((await b.jobs.get(...ACME)).job.timeline.at(-1)?.event).toBe("Email sent");
  });
  it("frees the draft when the send is declined", async () => {
    const b = new MockBridge();
    const d = await b.mail.drafts.save(...ACME, "", reply);
    const a = await b.mail.drafts.propose(...ACME, d.view.draft_id);
    await b.approvals.decline(a.id, "Not now");
    expect((await b.mail.drafts.list(...ACME)).find((x) => x.draft_id === d.view.draft_id)?.status).toBe("draft");
  });
  it("offers Mark as sent and Send again (with a confirm) when a send ends not sure", async () => {
    const b = new MockBridge({ mailSendUnsure: true });
    const d = await b.mail.drafts.save(...ACME, "", reply);
    const a = await b.mail.drafts.propose(...ACME, d.view.draft_id);
    expect(await b.approvals.approve(a.id, a.digest)).toMatchObject({ status: "approved", unsure: true });
    expect((await b.approvals.list()).find((x) => x.id === a.id)).toMatchObject({ unsure: true, email: { subject: "Re: Interview" } });
    await expect(b.mail.send.again(a.id, a.digest, false)).rejects.toThrow(/Confirm/);
    expect(await b.mail.send.again(a.id, a.digest, true)).toMatchObject({ status: "done", result_note: "Sent to 1 recipient" });
    await expect(b.mail.send.markSent(a.id)).rejects.toThrow(/isn't waiting/);

    const d2 = await b.mail.drafts.save(...ACME, "", { ...reply, subject: "Re: Interview (2)" });
    const a2 = await b.mail.drafts.propose(...ACME, d2.view.draft_id);
    await b.approvals.approve(a2.id, a2.digest);
    expect(await b.mail.send.markSent(a2.id)).toMatchObject({ status: "done", result_note: "Marked as sent" });
    expect((await b.mail.drafts.list(...ACME)).find((x) => x.draft_id === d2.view.draft_id)?.status).toBe("sent");
  });
  it("sorts mail: assign with always-match, and ignore", async () => {
    const b = new MockBridge();
    const [first, second] = await b.mail.triage.list();
    expect(first!.suggestion?.company_slug).toBe("example-labs");
    const left = await b.mail.triage.assign(first!.id, { company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" }, true);
    expect(left.map((i) => i.id)).toEqual([second!.id]);
    expect(await b.mail.triage.ignore(second!.id, "domain")).toEqual([]);
  });
  it("refuses a background interval outside 15 minutes to 24 hours", async () => {
    const b = new MockBridge();
    await expect(b.mail.background.set(true, 5)).rejects.toThrow(/15 to 1440/);
    expect(await b.mail.background.set(true, 120)).toMatchObject({ on: true, minutes: 120 });
  });
  it("counts unread mail on Home", async () => {
    const b = new MockBridge();
    expect((await b.home.summary()).unreadMail).toBe(2);
  });
});

describe("MockBridge mail per workspace", () => {
  it("keeps each workspace's account and mail apart across a switch, like the services", async () => {
    const b = new MockBridge();
    expect((await b.mail.status()).connected).toBe(true);
    expect((await b.mail.list({})).total).toBeGreaterThan(0);
    const sam = (await b.workspace.recent()).find((w) => !w.current)!;
    await b.workspace.switchTo(sam.key);
    expect(await b.mail.status()).toMatchObject({ connected: false, address: "" });
    expect((await b.mail.list({})).total).toBe(0);
    expect((await b.home.summary()).unreadMail).toBe(0);
    const alex = (await b.workspace.recent()).find((w) => !w.current)!;
    await b.workspace.switchTo(alex.key);
    expect((await b.mail.status()).connected).toBe(true);
  });
});

