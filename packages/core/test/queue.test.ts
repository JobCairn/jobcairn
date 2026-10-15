import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { buildDraftMessage, writeDraft } from "../src/drafts.js";
import { newJob } from "../src/jobs.js";
import { layout } from "../src/paths.js";
import {
  decideAccessRequest, listAccessRequests, listApprovals, logActivity, newQueueId, proposeApproval,
  readActivity, readApproval, requestAccess, setApprovalStatus,
} from "../src/queue.js";
import { updateRecord } from "../src/store.js";
import { validateWorkspace } from "../src/validate.js";
import { FIXED, tmpDir } from "./helpers.js";
// Compared against core's own apply_handoff url check (duplicated, not imported, for the
// reasons in queue.ts): a test-only import is fine since it never ships in core's dist.
import { isSafeHttpsUrl } from "../../contract/src/index.js";

const at = (min: number) => ({ now: new Date(FIXED.getTime() + min * 60_000) });
function ws() {
  const root = path.join(tmpDir(), "ws");
  initWorkspace(root, { now: FIXED });
  const job = newJob(root, { company: "Example Labs", title: "Backend Engineer (LLM)" }, { now: FIXED });
  return { root, job };
}

describe("approvals queue", () => {
  it("makes stable ids from the time and content", () => {
    expect(newQueueId("abc", { now: FIXED })).toMatch(/^20260115t093000-[0-9a-f]{6}$/);
    expect(newQueueId("abc", { now: FIXED })).toBe(newQueueId("abc", { now: FIXED }));
  });
  it("proposes, lists and approves a status change exactly once", () => {
    const { root, job } = ws();
    const a = proposeApproval(root, { action: "status_change", title: "Move to Interview", steps: ["Set the job status to Interview"], payload: { company_slug: job.company_slug, id: job.id, status: "Interview" }, created_by: "claude" }, at(0));
    expect(fs.existsSync(path.join(root, ".careeros", "approvals", `${a.id}.json`))).toBe(true);
    expect(listApprovals(root, { status: "pending" }).map((x) => x.id)).toEqual([a.id]);
    expect(setApprovalStatus(root, a.id, "approved", "", at(1)).decided_at).toBe(at(1).now.toISOString());
    expect(() => setApprovalStatus(root, a.id, "approved")).toThrow(/is approved; it can't become approved/);
    expect(setApprovalStatus(root, a.id, "done", "Status set").result_note).toBe("Status set");
    expect(readApproval(root, a.id).status).toBe("done");
  });
  it("gives two identical proposals different ids", () => {
    const { root, job } = ws();
    const input = { action: "status_change" as const, title: "T", payload: { company_slug: job.company_slug, id: job.id, status: "Saved" } };
    expect(proposeApproval(root, input, at(0)).id).not.toBe(proposeApproval(root, input, at(0)).id);
  });
  it("refuses unknown jobs, statuses and non-https hand-off links", () => {
    const { root, job } = ws();
    expect(() => proposeApproval(root, { action: "status_change", title: "T", payload: { company_slug: "nope", id: "x", status: "Saved" } })).toThrow(/no job/);
    expect(() => proposeApproval(root, { action: "status_change", title: "T", payload: { company_slug: job.company_slug, id: job.id, status: "Ghosted" } })).toThrow(/unknown status/);
    expect(() => proposeApproval(root, { action: "apply_handoff", title: "T", payload: { company_slug: job.company_slug, id: job.id, url: "http://jobs.example.com/1" } })).toThrow(/https/);
  });
  it("refuses an apply_handoff proposal with no url at all", () => {
    const { root, job } = ws();
    expect(() => proposeApproval(root, { action: "apply_handoff", title: "T", payload: { company_slug: job.company_slug, id: job.id } })).toThrow(/url/);
  });
  // A userinfo prefix lets a link read as going to one host while the browser actually
  // navigates to another; refusing it at proposal time means no approval ever carries
  // one, regardless of what later re-checks it.
  it("refuses an apply_handoff url with a userinfo prefix, even though it starts with https://", () => {
    const { root, job } = ws();
    const trick = "https://" + "ok.example.com" + "@evil.example/1";
    expect(() => proposeApproval(root, { action: "apply_handoff", title: "T", payload: { company_slug: job.company_slug, id: job.id, url: trick } })).toThrow(/https/);
  });
  // Regression: String(["https://a.example/x"]) coerces a one-element array into a
  // URL-shaped string, so a naive `new URL(String(p.url))` would have parsed it as a safe
  // https link. isSafeHttpsUrl rejects non-strings outright; core must too.
  it("refuses an apply_handoff url that's an array, even though String() would coerce it into a valid-looking https URL", () => {
    const { root, job } = ws();
    expect(String(["https://a.example/x"])).toBe("https://a.example/x"); // the coercion that made this a trap
    expect(() => proposeApproval(root, { action: "apply_handoff", title: "T", payload: { company_slug: job.company_slug, id: job.id, url: ["https://a.example/x"] } })).toThrow(/https/);
  });
  // Parity: core duplicates isSafeHttpsUrl's rule rather than importing it (see the comment
  // in queue.ts). This proves the duplicate hasn't drifted, case by case, including the
  // normalisations the WHATWG URL parser itself applies (case-folding, whitespace trimming)
  // and shapes that aren't a safe https link but also aren't an obviously-malformed string.
  it("agrees with @careeros/contract's isSafeHttpsUrl on every case in the shared table", () => {
    const { root, job } = ws();
    const cases: unknown[] = [
      "http://jobs.example.com/1",
      "javascript:alert(1)",
      "not a url",
      "https://" + "ok.example.com" + "@evil.example/1",
      "https://ok.example.com/x",
      "",
      ["https://ok.example.com/x"],
      42,
      "HTTPS://Jobs.Example.com/a",
      "   https://ok.example.com/x   ",
      "https://[::1]:8443/x",
      "https://ok.example.com:9443/x",
    ];
    for (const url of cases) {
      const expected = isSafeHttpsUrl(url);
      let accepted = true;
      try {
        proposeApproval(root, { action: "apply_handoff", title: "T", payload: { company_slug: job.company_slug, id: job.id, url } });
      } catch {
        accepted = false;
      }
      expect(accepted, JSON.stringify(url)).toBe(expected);
    }
  });
  it("creates records exclusively: a colliding id is retried, not overwritten", () => {
    const { root, job } = ws();
    const input = { action: "status_change" as const, title: "T", payload: { company_slug: job.company_slug, id: job.id, status: "Saved" } };
    const collidingId = newQueueId(JSON.stringify(input), at(0));
    const dir = path.join(root, ".careeros", "approvals");
    fs.mkdirSync(dir, { recursive: true });
    const sentinel = '{"sentinel":true}';
    fs.writeFileSync(path.join(dir, `${collidingId}.json`), sentinel);
    const a = proposeApproval(root, input, at(0));
    expect(a.id).not.toBe(collidingId);
    expect(fs.readFileSync(path.join(dir, `${collidingId}.json`), "utf8")).toBe(sentinel);
  });
  it("reports a broken queue file in validate and skips it in lists", () => {
    const { root } = ws();
    fs.mkdirSync(path.join(root, ".careeros", "approvals"), { recursive: true });
    fs.writeFileSync(path.join(root, ".careeros", "approvals", "bad.json"), "{");
    const skipped: { file: string; problems: string[] }[] = [];
    expect(listApprovals(root, { skipped })).toEqual([]);
    expect(skipped[0]?.file).toBe(path.join(".careeros", "approvals", "bad.json"));
    expect(validateWorkspace(root).some((i) => i.file === path.join(".careeros", "approvals", "bad.json"))).toBe(true);
  });
  it("refuses a symlinked .careeros folder", () => {
    const { root, job } = ws();
    fs.symlinkSync(tmpDir("careeros-outside-"), path.join(root, ".careeros"), "dir");
    expect(() => proposeApproval(root, { action: "status_change", title: "T", payload: { company_slug: job.company_slug, id: job.id, status: "Saved" } })).toThrow(/not a real folder/);
  });
});

describe("email_send proposals never trust a caller-supplied digest (R-C)", () => {
  function mailJob() {
    const { root, job } = ws();
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.address = "alex" + "@" + "example.com"; });
    const { draft_id } = writeDraft(root, job.company_slug, job.id, {
      to: [{ name: "", address: "talent" + "@" + "example.org" }], cc: [], subject: "Hi", attach: [],
      in_reply_to: "", references: [], purpose: "", body: "Hi,\n\nRegards,\nAlex",
    });
    return { root, job, draft_id };
  }
  it("accepts a payload whose digest matches a fresh rebuild of the real draft", () => {
    const { root, job, draft_id } = mailJob();
    const stamp = { message_id: `<${draft_id}.abc@example.com>`, date: at(0).now.toISOString() };
    const built = buildDraftMessage(root, job.company_slug, job.id, draft_id, stamp);
    const a = proposeApproval(root, {
      action: "email_send", title: "Send",
      payload: { company_slug: job.company_slug, id: job.id, draft_id, sha256: built.digest, message_id: stamp.message_id, date: stamp.date },
    }, at(0));
    expect(a.status).toBe("pending");
  });
  it("ignores a forged payload's draft/account/purpose/title/summary/steps and sets them from the rebuilt message instead", () => {
    const { root, job, draft_id } = mailJob();
    const stamp = { message_id: `<${draft_id}.abc@example.com>`, date: at(0).now.toISOString() };
    const built = buildDraftMessage(root, job.company_slug, job.id, draft_id, stamp);
    const a = proposeApproval(root, {
      action: "email_send", title: "Forged title pretending to send somewhere else",
      summary: "To someone-else" + "@" + "attacker.example",
      steps: ["Do something the reviewer never agreed to"],
      payload: {
        company_slug: job.company_slug, id: job.id, draft_id, sha256: built.digest, message_id: stamp.message_id, date: stamp.date,
        draft: "companies/other-corp/jobs/other-job/emails/drafts/forged.md", account: "attacker" + "@" + "example.net", purpose: "apply",
      },
    }, at(0));
    expect(a.title).toBe('Send "Hi"');
    expect(a.summary).toBe(`To ${"talent" + "@" + "example.org"}`);
    expect(a.payload.account).toBe("alex" + "@" + "example.com");
    expect(a.payload.purpose).toBe("");
    expect(a.payload.draft).toBe(`companies/${job.company_slug}/jobs/${job.id}/emails/drafts/${draft_id}.md`);
    expect(a.steps).toEqual([
      `Send one email from ${"alex" + "@" + "example.com"} to 1 recipient(s)`,
      "Save the sent copy in the job's emails folder",
      'Add "Email sent" to the job timeline',
    ]);
  });
  it("never mutates the caller's own payload object", () => {
    const { root, job, draft_id } = mailJob();
    const stamp = { message_id: `<${draft_id}.abc@example.com>`, date: at(0).now.toISOString() };
    const built = buildDraftMessage(root, job.company_slug, job.id, draft_id, stamp);
    const payload = { company_slug: job.company_slug, id: job.id, draft_id, sha256: built.digest, message_id: stamp.message_id, date: stamp.date };
    const before = JSON.stringify(payload);
    proposeApproval(root, { action: "email_send", title: "Send", payload }, at(0));
    expect(JSON.stringify(payload)).toBe(before);
    expect(payload).not.toHaveProperty("draft");
    expect(payload).not.toHaveProperty("account");
    expect(payload).not.toHaveProperty("purpose");
  });
  it("refuses an email_send proposal whose draft doesn't exist", () => {
    const { root, job } = ws();
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.address = "alex" + "@" + "example.com"; });
    expect(() => proposeApproval(root, {
      action: "email_send", title: "Send", payload: { company_slug: job.company_slug, id: job.id, draft_id: "d1", sha256: "0".repeat(64) },
    }, at(0))).toThrow(/draft that can be read/);
  });
  it("refuses an email_send proposal whose digest doesn't match a rebuild of the real draft", () => {
    const { root, job, draft_id } = mailJob();
    expect(() => proposeApproval(root, {
      action: "email_send", title: "Send", payload: { company_slug: job.company_slug, id: job.id, draft_id, sha256: "0".repeat(64) },
    }, at(0))).toThrow(/has changed since this digest/);
  });
});

describe("access requests and activity", () => {
  it("records a request, allows it with an expiry, then expires it", () => {
    const { root } = ws();
    const r = requestAccess(root, { folder: "me/identity", why: "Need the visa expiry date", field: "visa_expiry" }, at(0));
    expect(r).toMatchObject({ status: "pending", minutes: 15, who: "claude" });
    const ok = decideAccessRequest(root, r.id, "allowed", { minutes: 30 }, at(2));
    expect(ok.expires_at).toBe(at(32).now.toISOString());
    expect(decideAccessRequest(root, r.id, "expired", {}, at(33)).status).toBe("expired");
    expect(() => decideAccessRequest(root, r.id, "allowed")).toThrow(/is expired/);
    expect(listAccessRequests(root, { status: "pending" })).toEqual([]);
  });
  it("only accepts lockable folders", () => {
    expect(() => requestAccess(ws().root, { folder: "me/history", why: "x" })).toThrow(/not a lockable folder/);
  });
  it("logs activity on one line per event, newest first", () => {
    const { root } = ws();
    logActivity(root, "Allowed once", "me/identity for 15 minutes", at(0));
    logActivity(root, "Re-locked", "me/identity\nforged line", at(15));
    const a = readActivity(root);
    expect(a.map((x) => x.event)).toEqual(["Re-locked", "Allowed once"]);
    expect(a[0]?.detail).toBe("me/identity forged line");
  });
});
