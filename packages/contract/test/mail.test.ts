import { describe, expect, it } from "vitest";
import { baseNameFor, MAIL_REF, sanitizeEmailHtml } from "@careeros/mail";
import {
  buildNextUp, CHANGE_AREAS, homeSummary, MAIL_REF_PATTERN, mailRefToken, mailTokenToRef, mailUrlFor, mailViewUrl, parseMailUrl, type DraftView, type MailRow,
} from "../src/index.js";

const REF = "companies/acme-corp/jobs/2026-01-12-ai-engineer/emails/2026-01-14-interview-for-ai-engineer-a1b2c3.json";
const TRIAGE = ".careeros/mail-triage/2026-01-14-new-jobs-for-you-d4e5f6.json";

describe("mail refs and URLs", () => {
  it("accepts only stored-message refs", () => {
    for (const r of [REF, TRIAGE, "companies/acme-corp/emails/2026-01-14-hello-aaaaaa.json"]) expect(MAIL_REF_PATTERN.test(r), r).toBe(true);
    for (const r of ["companies/acme-corp/emails/../../workspace.json", "settings/profile.json", "companies/acme-corp/emails/x.eml", ".careeros/approvals/x.json", "/etc/passwd", "companies/Acme/emails/x.json"]) {
      expect(MAIL_REF_PATTERN.test(r), r).toBe(false);
    }
  });
  it("round-trips refs through URL-safe tokens", () => {
    const t = mailRefToken(REF);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mailTokenToRef(t)).toBe(REF);
    expect(mailTokenToRef(mailRefToken("../../settings/.env"))).toBeNull();
    expect(mailTokenToRef("%%%")).toBeNull();
    expect(mailUrlFor(TRIAGE)).toBe(`careeros-mail://msg/${mailRefToken(TRIAGE)}`);
  });
  it("parses the four careeros-mail URL forms and nothing else", () => {
    const t = mailRefToken(REF);
    expect(parseMailUrl(`careeros-mail://msg/${t}`)).toEqual({ kind: "msg", ref: REF, arg: "" });
    expect(parseMailUrl(`careeros-mail://cid/${t}/logo%40acme`)).toEqual({ kind: "cid", ref: REF, arg: "logo@acme" });
    expect(parseMailUrl(`careeros-mail://img/${t}/2`)).toEqual({ kind: "img", ref: REF, arg: "2" });
    expect(parseMailUrl(`careeros-mail://link/${t}/0`)).toEqual({ kind: "link", ref: REF, arg: "0" });
    for (const u of [`careeros-mail://img/${t}/x`, `careeros-mail://file/${t}`, `careeros-mail://msg/${t}/extra`, `careeros-file://ws/${t}`, "careeros-mail://msg/", "not a url", `careeros-mail://cid/${t}/%E0%A4%A`]) {
      expect(parseMailUrl(u), u).toBeNull();
    }
  });
  it("parses the plain-text view of a message and its own numbered links, and nothing looser", () => {
    const t = mailRefToken(REF);
    expect(mailViewUrl(mailUrlFor(REF), "text")).toBe(`careeros-mail://msg/${t}/text`);
    expect(mailViewUrl(mailUrlFor(REF), "original")).toBe(mailUrlFor(REF));
    expect(parseMailUrl(`careeros-mail://msg/${t}/text`)).toEqual({ kind: "msg", ref: REF, arg: "text" });
    expect(parseMailUrl(`careeros-mail://link/${t}/t3`)).toEqual({ kind: "link", ref: REF, arg: "t3" });
    for (const u of [`careeros-mail://msg/${t}/TEXT`, `careeros-mail://msg/${t}/text/0`, `careeros-mail://msg/${t}/text%2F..`, `careeros-mail://link/${t}/tt3`,
      `careeros-mail://link/${t}/t`, `careeros-mail://link/${t}/3t`, `careeros-mail://img/${t}/t3`, `careeros-mail://link/${t}/t12345`]) {
      expect(parseMailUrl(u), u).toBeNull();
    }
  });
  it("adds the mail change area", () => {
    expect(CHANGE_AREAS).toContain("mail");
    expect(CHANGE_AREAS).toHaveLength(17);
    expect(CHANGE_AREAS).toContain("setup");
  });
});

describe("agreement with the message store (packages/mail/src/store.ts)", () => {
  it("MAIL_REF_PATTERN and store.ts's MAIL_REF accept and reject exactly the same refs", () => {
    // A battery of refs, good and bad, covering every branch of the pattern: both company- and
    // job-scoped emails folders, triage, wrong case, path traversal, wrong extension, wrong
    // location, empty/overlong segments, and a base right at the 100-byte length cap.
    const cases = [
      REF,
      TRIAGE,
      "companies/acme-corp/emails/2026-01-14-hello-aaaaaa.json",
      "companies/acme-corp/emails/../../workspace.json",
      "settings/profile.json",
      "companies/acme-corp/emails/x.eml",
      ".careeros/approvals/x.json",
      "/etc/passwd",
      "companies/Acme/emails/x.json",
      "companies/acme/jobs/j/x.json",
      "companies/acme/jobs//emails/x.json",
      "companies//emails/x.json",
      "companies/acme/emails/.json",
      "companies/acme-/emails/x.json",
      "companies/-acme/emails/x.json",
      `companies/acme/emails/${"a".repeat(100)}.json`,
      `companies/acme/emails/${"a".repeat(101)}.json`,
      "companies/acme/jobs/job-1/emails/2026-01-01-a-1.json",
      ".careeros/mail-triage/x.json",
      ".careeros/mail-triage/X.json",
    ];
    for (const r of cases) expect(MAIL_REF_PATTERN.test(r), r).toBe(MAIL_REF.test(r));
  });
  it("accepts refs built the same way storeMessage names a message (baseNameFor)", () => {
    const bases = [
      baseNameFor("2026-01-14T09:00:00.000Z", "Interview for AI Engineer", "<local-msg-abc123>"),
      baseNameFor("2026-02-01T00:00:00.000Z", "", "<>"),
      baseNameFor("2026-03-03T03:03:03.000Z", "Re: your application — Ünïcôde 日本語 subject!!", "<local-msg-xyz>"),
    ];
    const refs = [
      ...bases.map((b) => `companies/acme-corp/emails/${b}.json`),
      ...bases.map((b) => `companies/acme-corp/jobs/2026-01-12-ai-engineer/emails/${b}.json`),
      ...bases.map((b) => `.careeros/mail-triage/${b}.json`),
    ];
    for (const r of refs) {
      expect(MAIL_REF.test(r), r).toBe(true);
      expect(MAIL_REF_PATTERN.test(r), r).toBe(true);
    }
  });
});

describe("parseMailUrl as a security boundary", () => {
  const t = mailRefToken(REF);

  it("rejects the wrong scheme", () => {
    for (const u of [`careeros-file://msg/${t}`, `https://msg/${t}`, `careeros-mail:msg/${t}`]) expect(parseMailUrl(u), u).toBeNull();
  });
  it("rejects the wrong host (asset kind)", () => {
    for (const u of [`careeros-mail://file/${t}`, `careeros-mail://MSG/${t}`, `careeros-mail:///${t}`, "careeros-mail://"]) expect(parseMailUrl(u), u).toBeNull();
  });
  it("rejects a bad base64url token", () => {
    // "A" alone is not a valid base64 string length; "!!!" and "+/=" aren't in the base64url alphabet; empty is too short.
    for (const u of [`careeros-mail://msg/A`, `careeros-mail://msg/!!!`, `careeros-mail://msg/${t}+/=`, "careeros-mail://msg/"]) expect(parseMailUrl(u), u).toBeNull();
  });
  it("rejects a token that decodes to a ref MAIL_REF_PATTERN refuses", () => {
    for (const bad of ["../../settings/.env", "settings/profile.json", "companies/Acme/emails/x.json", "/etc/passwd"]) {
      const bt = mailRefToken(bad);
      expect(parseMailUrl(`careeros-mail://msg/${bt}`), bad).toBeNull();
    }
  });
  it("rejects path traversal in arg (img/link only accept a plain small integer)", () => {
    // "1/../2" is deliberately not tested here: the URL parser's own dot-segment removal
    // collapses it to "/2" before this code ever sees it, which is still a safe digit-only arg.
    for (const arg of ["../1", "..%2f1", "%2e%2e%2f1", "0x1", "1.0", "-1", ""]) {
      expect(parseMailUrl(`careeros-mail://img/${t}/${arg}`), `img/${arg}`).toBeNull();
      expect(parseMailUrl(`careeros-mail://link/${t}/${arg}`), `link/${arg}`).toBeNull();
    }
  });
  it("rejects an oversized token or an oversized cid arg", () => {
    expect(parseMailUrl(`careeros-mail://msg/${"A".repeat(601)}`)).toBeNull();
    expect(parseMailUrl(`careeros-mail://cid/${t}/${"x".repeat(257)}`)).toBeNull();
    // A valid token at the very edge still round-trips.
    expect(parseMailUrl(`careeros-mail://cid/${t}/${"x".repeat(256)}`)).toEqual({ kind: "cid", ref: REF, arg: "x".repeat(256) });
  });
  // Fix round 1: sanitize.ts documents that every "." in a cid is percent-encoded specifically so
  // `cid:..` "can never turn into a `..` path segment wherever the viewer resolves this URL" — but
  // that only protects a consumer reading the raw, still-encoded URL text. parseMailUrl's own job
  // is to decode it, which fully reverses the trick. These tests prove the cid branch itself now
  // closes that gap, independent of whatever sanitize.ts does upstream.
  it("rejects a hostile 'cid:../../etc/passwd' image even after it round-trips through sanitize.ts's own encoding", () => {
    const { html } = sanitizeEmailHtml('<img src="cid:../../etc/passwd">', { token: t, imagesAllowed: false });
    const m = /src="(careeros-mail:\/\/cid\/[^"]+)"/.exec(html);
    expect(m, html).not.toBeNull();
    // sanitize.ts's dot-encoding is visible in the raw URL text...
    expect(m![1]).toContain("%2E%2E%2F");
    // ...but parseMailUrl decodes it back to "../../etc/passwd" and must still refuse it.
    expect(parseMailUrl(m![1]!), m![1]).toBeNull();
  });
  it("rejects every percent-encoded or literal traversal shape in a cid arg", () => {
    const bad = [
      "../../etc/passwd", "..%2f1", "%2e%2e%2f1", "%2E%2E%2F1", "a%2fb", "a/b",
      "..%5c1", "%2e%2e%5c1", "a%5cb", "a\\b",
      "..", "...", "a..b", ".hidden", "%2e",
      "%00", "a%00b", "a%0ab", "a%0db", "a%7fb", "%01",
    ];
    for (const arg of bad) expect(parseMailUrl(`careeros-mail://cid/${t}/${arg}`), arg).toBeNull();
  });
  it("still accepts a plain, opaque cid like a real Content-ID", () => {
    expect(parseMailUrl(`careeros-mail://cid/${t}/logo%40acme`)).toEqual({ kind: "cid", ref: REF, arg: "logo@acme" });
    expect(parseMailUrl(`careeros-mail://cid/${t}/image001.png%40ACME-MAIL-01`)).toEqual({ kind: "cid", ref: REF, arg: "image001.png@ACME-MAIL-01" });
  });
  it("rejects unicode tricks: homoglyph hosts, non-ASCII tokens, and invisible characters", () => {
    // A Cyrillic "м" (U+043C) made to look like "msg": the WHATWG URL parser percent-encodes it
    // rather than normalizing it to ASCII, so the host can never literally equal "msg".
    expect(parseMailUrl(`careeros-mail://мsg/${t}`)).toBeNull();
    // A fullwidth "ｍ" (U+FF4D) in the same position.
    expect(parseMailUrl(`careeros-mail://ｍsg/${t}`)).toBeNull();
    // A non-ASCII token gets percent-encoded by the URL parser into characters outside the
    // base64url alphabet, so it fails mailTokenToRef's charset check.
    expect(parseMailUrl(`careeros-mail://msg/токен`)).toBeNull();
    // A zero-width space appended to an otherwise valid token.
    expect(parseMailUrl(`careeros-mail://msg/${t}​`)).toBeNull();
    // A right-to-left override trying to disguise the path (still just an opaque extra segment on "msg").
    expect(parseMailUrl(`careeros-mail://msg/${t}/‮1`)).toBeNull();
  });
  it("decodes a byte sequence that is not valid UTF-8 to null rather than throwing", () => {
    // base64url for the single invalid continuation byte 0x80.
    expect(mailTokenToRef("gA")).toBeNull();
    expect(parseMailUrl("careeros-mail://msg/gA")).toBeNull();
  });
});

const row = (over: Partial<MailRow>): MailRow => ({
  ref: REF, company_slug: "acme-corp", company_name: "Acme Corp", job_id: "2026-01-12-ai-engineer", job_title: "AI Engineer", direction: "in",
  date: "2026-01-14T09:00:00.000Z", subject: "Interview for AI Engineer", from: { name: "Acme Talent", address: "talent" + "@" + "example.org" },
  thread_key: "t", attachments: 0, opened: false, matched_by: "recruiter", ...over,
});
const draft = (over: Partial<DraftView>): DraftView => ({
  draft_id: "20260115t090000-aaaaaa", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm", company_name: "Example Labs", job_title: "Backend Engineer (LLM)",
  rel: "x", subject: "Following up", to: "", status: "draft", updated: "", approval_id: "", note: "", ...over,
});

describe("next-up with mail", () => {
  it("lists unread job replies after requests and unsent drafts after interviews", () => {
    const items = buildNextUp({
      rows: [], approvals: [], inbox: [],
      requests: [{ id: "r1", folder: "me/identity", field: "", why: "visa", who: "claude", minutes: 15, created_at: "", status: "pending", decided_at: "", expires_at: "" }],
      mail: { unread: [row({}), row({ job_id: "", job_title: "", subject: "Company news" })], unreadCount: 2, drafts: [draft({}), draft({ draft_id: "b", status: "waiting" })] },
    });
    expect(items.map((i) => i.kind)).toEqual(["request", "reply", "draft"]);
    expect(items[1]).toMatchObject({ title: "Interview for AI Engineer", subtitle: "Acme Talent · AI Engineer", company_slug: "acme-corp", id: "2026-01-12-ai-engineer", mailRef: REF });
    expect(items[2]).toMatchObject({ title: "Following up", subtitle: "Draft for Backend Engineer (LLM)", draftId: "20260115t090000-aaaaaa" });
  });
  it("counts unread mail on Home", () => {
    const h = homeSummary({ name: "Alex Example", rows: [], events: [], visaExpiry: "", approvals: [], requests: [], inbox: [], now: new Date("2026-01-15T09:00:00.000Z"), mail: { unread: [row({})], unreadCount: 7, drafts: [] } });
    expect(h.unreadMail).toBe(7);
    expect(homeSummary({ name: "", rows: [], events: [], visaExpiry: "", approvals: [], requests: [], inbox: [], now: new Date() }).unreadMail).toBe(0);
  });
});
