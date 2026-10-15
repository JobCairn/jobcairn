import { describe, expect, it, vi } from "vitest";
import { loadFixture, MockBridge } from "../src/mock/MockBridge";

describe("MockBridge", () => {
  it("lists jobs with sponsorship pinned and ineligible ads hidden", async () => {
    const b = new MockBridge();
    const list = await b.jobs.list({});
    expect(list.rows[0]).toMatchObject({ company_name: "Acme Corp", pinned: true, wr_label: "sponsorship_offered" });
    expect(list.rows.map((r) => r.title)).not.toContain("AI Developer");
    expect(list.hiddenIneligible).toBe(1);
    expect((await b.jobs.list({ showIneligible: true })).rows.map((r) => r.title)).toContain("AI Developer");
  });
  it("recomputes eligibility when the profile's work rights change", async () => {
    const b = new MockBridge();
    await b.settings.save("profile", [{ path: "work_rights.status", value: "citizen" }]);
    expect((await b.jobs.list({})).hiddenIneligible).toBe(0);
  });
  it("refuses a __proto__.x settings change and never pollutes Object.prototype", async () => {
    const b = new MockBridge();
    await expect(b.settings.save("profile", [{ path: "__proto__.x", value: 1 }])).rejects.toThrow();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it("executes an approval only on approve, and only once", async () => {
    const b = new MockBridge();
    const [a] = await b.approvals.list();
    const slug = a!.payload.company_slug as string;
    const id = a!.payload.id as string;
    expect((await b.jobs.get(slug, id)).job.status).toBe("Found");
    const done = await b.approvals.approve(a!.id, a!.digest);
    expect(done.status).toBe("done");
    expect((await b.jobs.get(slug, id)).job.status).toBe("Interview");
    await expect(b.approvals.approve(a!.id, a!.digest)).rejects.toThrow(/is done; it can't become approved/);
  });
  it("declining changes nothing", async () => {
    const b = new MockBridge();
    const [a] = await b.approvals.list();
    await b.approvals.decline(a!.id, "Not yet");
    expect((await b.jobs.get(a!.payload.company_slug as string, a!.payload.id as string)).job.status).toBe("Found");
  });
  it("files inbox items and tells listeners", async () => {
    const b = new MockBridge();
    const seen = vi.fn();
    b.onChange(seen);
    const items = await b.inbox.list();
    expect(items.find((i) => i.name === "Visa_Grant_Notice.pdf")?.suggestion.target).toEqual({ kind: "me", dir: "identity", sub: "visa" });
    await b.inbox.file("Visa_Grant_Notice.pdf", { kind: "me", dir: "identity", sub: "visa" }, "");
    expect((await b.inbox.list()).map((i) => i.name)).toEqual(["acme-corp-cover-letter.pdf"]);
    expect(seen).toHaveBeenCalledWith({ areas: ["inbox", "home"] });
  });
  it("allows locked folders once, with an expiry, and refuses to read them otherwise", async () => {
    const b = new MockBridge();
    await expect(b.files.readText("me/identity/visa/grant.md")).rejects.toThrow(/locked/);
    const p = await b.privacy.get();
    const req = p.requests.find((r) => r.status === "pending")!;
    const after = await b.privacy.allow(req.id, 15);
    expect(after.grants).toEqual([{ folder: "me/identity", until: "2026-01-15T09:15:00.000Z", request_id: req.id }]);
    expect(after.activity[0]?.event).toBe("Allowed once");
  });
  it("never opens or claims an apply_handoff url that fails the same safe-link rule services uses, but still reveals the files", async () => {
    const f = loadFixture();
    const trick = "https://" + "ok.example.com" + "@evil.example/1";
    f.approvals.push({ ...f.approvals[0]!, id: "20260113t090000-mockbad", action: "apply_handoff", status: "pending", payload: { company_slug: f.approvals[0]!.payload.company_slug, id: f.approvals[0]!.payload.id, url: trick, files: ["application/resume.md"] } });
    const b = new MockBridge({ fixture: f });
    const bad = (await b.approvals.list()).find((a) => a.id === "20260113t090000-mockbad")!;
    const done = await b.approvals.approve(bad.id, bad.digest);
    expect(done.status).toBe("done");
    expect(done.result_note).toBe("Opened the files");
    expect(b.opened).toEqual([]);
    expect(b.revealed.length).toBeGreaterThan(0);
  });
  it("opens only https links", async () => {
    const b = new MockBridge();
    // The real transport validates every call's arguments with the shared `validateArgs`
    // table before it ever reaches the handler (Task 14 fix round: links.open requires
    // https). MockBridge runs the same validation, so a non-https URL rejects instead of
    // quietly returning false.
    await expect(b.links.open("http://jobs.example.com")).rejects.toThrow(/https/);
    expect(await b.links.open("https://jobs.example.com/acme/1")).toBe(true);
    expect(b.opened).toEqual(["https://jobs.example.com/acme/1"]);
  });
});
