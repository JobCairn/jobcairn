import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildDraftMessage, checkDraft, initWorkspace, layout, newJob, parseAddressList, updateRecord,
  writeDraft, type CanonicalMessage,
} from "@careeros/core";
import { buildMime, envelopeFor } from "../src/mime.js";
import { parseMessage } from "../src/parse.js";
import { addr, ALEX, TALENT } from "../src/testing.js";

const mid = (s: string) => "<" + s + "@" + "example.com>";
const base = (over: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  draft_id: "20260115t093000-abc123", message_id: mid("d1.abc"), date: "2026-01-15T09:30:00.000Z",
  from: { name: "Alex Example", address: ALEX }, to: [{ name: "Acme Talent", address: TALENT }], cc: [{ name: "", address: addr("hr", "example.net") }],
  subject: "Re: Interview für Alex ✓", in_reply_to: "<m1" + "@" + "example.org>", references: ["<m1" + "@" + "example.org>"],
  text: "Hi,\n\nFriday works.\n\nRegards,\nAlex\n\nAlex Example\nAI Engineer\n",
  attachments: [{ rel: "companies/acme-corp/jobs/x/application/resume.md", name: "resume.md", size: 16, sha256: "0".repeat(64), type: "text/markdown", locked: null }],
  purpose: "",
  ...over,
});
const CONTENT = [Buffer.from("# Alex Example\n\n")];

describe("buildMime", () => {
  it("gives identical bytes for identical inputs", async () => {
    const a = await buildMime(base(), CONTENT);
    const b = await buildMime(base(), CONTENT);
    expect(a.equals(b)).toBe(true);
    expect(a.toString("latin1")).toContain("careeros-20260115t093000-abc123");
    expect((await buildMime(base({ text: "Changed\n" }), CONTENT)).equals(a)).toBe(false);
  });

  it("carries every field the preview shows, and nothing else", async () => {
    const raw = await buildMime(base(), CONTENT);
    const p = await parseMessage(raw);
    expect(p).toMatchObject({
      message_id: mid("d1.abc"), date: "2026-01-15T09:30:00.000Z", subject: "Re: Interview für Alex ✓",
      from: { name: "Alex Example", address: ALEX }, to: [{ name: "Acme Talent", address: TALENT }], cc: [{ name: "", address: addr("hr", "example.net") }],
      in_reply_to: "<m1" + "@" + "example.org>", references: ["<m1" + "@" + "example.org>"],
    });
    expect(p.text.replace(/\r\n/g, "\n")).toBe(base().text);
    expect(p.attachments.map((a) => [a.name, a.content.toString()])).toEqual([["resume.md", "# Alex Example\n\n"]]);
    expect(raw.toString("latin1")).not.toMatch(/^bcc:/im);
    expect(envelopeFor(base())).toEqual({ from: ALEX, to: [TALENT, addr("hr", "example.net")] });
  });

  it("cannot be tricked into extra headers by a subject or name", async () => {
    const raw = await buildMime(base({ subject: "Hi\r\nBcc: " + addr("x", "example.net"), from: { name: "Alex\r\nBcc: y", address: ALEX } }), CONTENT);
    const head = raw.toString("latin1").split("\r\n\r\n")[0]!;
    expect(head).not.toMatch(/^bcc:/im);
    expect(head.split("\r\n").filter((l) => /^subject:/i.test(l))).toHaveLength(1);
  });

  it("builds the same message the core digest describes", async () => {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-mime-")), "ws");
    initWorkspace(root);
    const j = newJob(root, { company: "Acme Corp", title: "AI Engineer" });
    updateRecord("integrations", layout(root).integrations, (i) => { i.mail.address = ALEX; i.mail.display_name = "Alex Example"; i.mail.signature = "Alex Example"; });
    const { draft_id } = writeDraft(root, j.company_slug, j.id, { to: [{ name: "", address: TALENT }], cc: [], subject: "Hello", attach: [], in_reply_to: "", references: [], purpose: "", body: "Hi" });
    const stamp = { message_id: mid(`${draft_id}.aaaaaaaaaaaa`), date: "2026-01-15T09:30:00.000Z" };
    const x = buildDraftMessage(root, j.company_slug, j.id, draft_id, stamp);
    const y = buildDraftMessage(root, j.company_slug, j.id, draft_id, stamp);
    expect(x.digest).toBe(y.digest);
    expect((await buildMime(x.message, x.contents)).equals(await buildMime(y.message, y.contents))).toBe(true);
  });

  // --- Task 8 additions ------------------------------------------------------------------

  describe("a literal RFC 2047 encoded-word is never handed to a decoder unescaped", () => {
    // encodeWords (the nodemailer helper that decides whether a header value needs mime-word
    // encoding) only encodes when the text already contains a quote character or a non-ASCII
    // byte. A subject or display name that is otherwise plain ASCII, but merely *contains* the
    // literal text "=?utf-8?q?FAKE?=", doesn't trip that check -- so without this test, that
    // text would reach the wire unescaped, and a decoding client (parseMessage included) would
    // treat it as a genuine encoded word and silently substitute "FAKE" for what was actually
    // typed. This is the carried requirement from Task 3's review.
    const fake = "=?utf-8?q?FAKE?=";

    it("in the subject", async () => {
      const subject = "Interview re " + fake;
      const raw = await buildMime(base({ subject }), CONTENT);
      expect(raw.toString("latin1")).not.toContain("Subject: " + subject);
      const p = await parseMessage(raw);
      expect(p.subject).toBe(subject);
    });

    it("in a display name", async () => {
      const name = "Alex " + fake;
      const raw = await buildMime(base({ from: { name, address: ALEX } }), CONTENT);
      const p = await parseMessage(raw);
      expect(p.from.name).toBe(name);
      expect(p.from.address).toBe(ALEX);
    });

    it("in a cc display name too", async () => {
      const name = "HR " + fake;
      const raw = await buildMime(base({ cc: [{ name, address: addr("hr", "example.net") }] }), CONTENT);
      const p = await parseMessage(raw);
      expect(p.cc[0]!.name).toBe(name);
    });

    it("in an attachment filename: refused upstream, not silently re-encoded", async () => {
      // Fix round 2 ruling: "what the recruiter sees wins". An earlier version of this fix tried
      // to wrap such a filename so it would still round-trip correctly on the wire (RFC 2231
      // filename*= carrying an inner RFC 2047 encoded word) -- but that leaves CareerOS's own
      // preview and approval digest showing the literal "=?utf-8?q?FAKE?=.pdf" text while a
      // standards-compliant recipient client would (correctly, per the encoding) show something
      // else, a mismatch between what was approved and what's effectively seen. So this is now
      // refused outright instead: upstream in core's checkDraft/writeDraft and resolveAttachment (see
      // packages/core/test/drafts.test.ts's own test for that), and here, in buildMime itself, as
      // defense in depth for a CanonicalMessage built directly (bypassing core), as this test does.
      const name = "resume " + fake + ".pdf";
      const content = Buffer.from("# Alex Example\n");
      await expect(
        buildMime(
          base({ attachments: [{ rel: "companies/acme-corp/jobs/x/application/resume.pdf", name, size: content.length, sha256: "0".repeat(64), type: "application/pdf", locked: null }] }),
          [content],
        ),
      ).rejects.toThrow(/An attachment name can't contain "=\?"/);
    });

    it("an attachment name can't reach buildMime at all through the real app flow: core refuses it first", () => {
      const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-mime-attach-")), "ws");
      initWorkspace(root);
      const j = newJob(root, { company: "Acme Corp", title: "AI Engineer" });
      updateRecord("integrations", layout(root).integrations, (i) => { i.mail.address = ALEX; i.mail.display_name = "Alex Example"; i.mail.signature = "Alex Example"; });
      const appDir = path.join(root, "companies", j.company_slug, "jobs", j.id, "application");
      fs.mkdirSync(appDir, { recursive: true });
      const hostileName = "resume " + fake + ".pdf";
      fs.writeFileSync(path.join(appDir, hostileName), "# Alex Example\n");
      const rel = `companies/${j.company_slug}/jobs/${j.id}/application/${hostileName}`;
      // Task 9 (Task 8 review item a): saving the draft is refused now, not only building it.
      const d = { to: [{ name: "", address: TALENT }], cc: [], subject: "Hello", attach: [rel], in_reply_to: "", references: [], purpose: "" as const, body: "Hi" };
      expect(() => writeDraft(root, j.company_slug, j.id, d)).toThrow(/An attachment name can't contain "=\?"/);
      // A draft file written by hand, bypassing writeDraft, is still refused when it is built.
      const draft_id = "20260115t093000-abc123";
      const draftsDir = layout(root).draftsDir(j.company_slug, j.id);
      fs.mkdirSync(draftsDir, { recursive: true });
      fs.writeFileSync(path.join(draftsDir, `${draft_id}.md`), `To: ${TALENT}\nSubject: Hello\nAttach: ${rel}\n\nHi\n`);
      const stamp = { message_id: mid(`${draft_id}.aaaaaaaaaaaa`), date: "2026-01-15T09:30:00.000Z" };
      expect(() => buildDraftMessage(root, j.company_slug, j.id, draft_id, stamp)).toThrow(/An attachment name can't contain "=\?"/);
    });
  });

  describe("ordinary non-ASCII attachment names are unaffected", () => {
    // Regression coverage for removing attachmentOptions'/rfc2231PercentEncode's custom wrap path
    // (fix round 2): a name with no "=?" in it was never the problem, and must keep going through
    // nodemailer's own standard RFC 2231 filename*=/RFC 2047 name= encoding exactly as before.
    it("a short non-ASCII name produces a standard filename*= parameter", async () => {
      const name = "Résumé.pdf";
      const content = Buffer.from("hello");
      const raw = await buildMime(
        base({ attachments: [{ rel: "companies/acme-corp/jobs/x/application/resume.pdf", name, size: content.length, sha256: "0".repeat(64), type: "application/pdf", locked: null }] }),
        [content],
      );
      const text = raw.toString("latin1");
      expect(text).toMatch(/filename\*0?\*=UTF-8''/i);
      expect(text).toMatch(/name="?=\?UTF-8\?[QB]\?/i);
      const p = await parseMessage(raw);
      expect(p.attachments[0]!.name).toBe(name);
      expect(p.attachments[0]!.content.equals(content)).toBe(true);
    });

    it("a 90-character non-ASCII name still produces standard filename*=/name= output and round-trips", async () => {
      const name = "é".repeat(86) + ".pdf";
      expect(name).toHaveLength(90);
      const content = Buffer.from("hello");
      const raw = await buildMime(
        base({ attachments: [{ rel: "companies/acme-corp/jobs/x/application/long.pdf", name, size: content.length, sha256: "0".repeat(64), type: "application/pdf", locked: null }] }),
        [content],
      );
      const text = raw.toString("latin1");
      expect(text).toMatch(/filename\*\d+\*=/i);
      expect(text).toMatch(/name="?=\?UTF-8\?[QB]\?/i);
      const p = await parseMessage(raw);
      expect(p.attachments[0]!.name).toBe(name);
      expect(p.attachments[0]!.content.equals(content)).toBe(true);
    });
  });

  describe("long \"=?\"-containing text is split into several bounded encoded words (fix round 2)", () => {
    // The original fix forced a single "=?UTF-8?B?...?=" word of unbounded length. RFC 2047 caps
    // one encoded word at 75 characters, and RFC 5322 caps a header line at 998. A long subject or
    // display name containing a literal "=?" needs to split across several encoded words, each
    // under the 75-character cap, joined by plain spaces -- a standards-compliant decoder discards
    // whitespace *between* adjacent encoded words when reconstructing the text (RFC 2047 section
    // 6.2), so splitting only ever changes the wire bytes, never the decoded result, as long as no
    // split lands inside a multi-byte UTF-8 sequence.
    const LINE_LIMIT = 998;
    const WORD_LIMIT = 75;

    function assertWordsAndLinesBounded(raw: Buffer): void {
      const text = raw.toString("latin1");
      for (const line of text.split("\r\n")) expect(line.length).toBeLessThanOrEqual(LINE_LIMIT);
      const words = text.match(/=\?[^?\s]+\?[QBqb]\?[^?]*\?=/g) ?? [];
      expect(words.length).toBeGreaterThan(0);
      for (const w of words) expect(w.length).toBeLessThanOrEqual(WORD_LIMIT);
    }

    it("a 300-character subject: \"Interview =?\" followed by repeated \"✓\"", async () => {
      const prefix = "Interview =?";
      const subject = prefix + "✓".repeat(300 - prefix.length);
      expect(subject).toHaveLength(300);
      const raw = await buildMime(base({ subject }), CONTENT);
      assertWordsAndLinesBounded(raw);
      const p = await parseMessage(raw);
      expect(p.subject).toBe(subject);
    });

    it("a 300-character all-ASCII subject containing a literal \"=?\"", async () => {
      const subject = "A".repeat(149) + "=?" + "A".repeat(149);
      expect(subject).toHaveLength(300);
      const raw = await buildMime(base({ subject }), CONTENT);
      assertWordsAndLinesBounded(raw);
      const p = await parseMessage(raw);
      expect(p.subject).toBe(subject);
    });

    it("applies the same splitting to a long display name containing a literal \"=?\"", async () => {
      const prefix = "Alex =?";
      const name = prefix + "✓".repeat(300 - prefix.length);
      expect(name).toHaveLength(300);
      const raw = await buildMime(base({ from: { name, address: ALEX } }), CONTENT);
      assertWordsAndLinesBounded(raw);
      const p = await parseMessage(raw);
      expect(p.from.name).toBe(name);
      expect(p.from.address).toBe(ALEX);
    });

    it("applies the same splitting to a long all-ASCII display name containing a literal \"=?\"", async () => {
      const name = "B".repeat(149) + "=?" + "B".repeat(149);
      expect(name).toHaveLength(300);
      const raw = await buildMime(base({ cc: [{ name, address: addr("hr", "example.net") }] }), CONTENT);
      assertWordsAndLinesBounded(raw);
      const p = await parseMessage(raw);
      expect(p.cc[0]!.name).toBe(name);
    });
  });

  describe("header injection", () => {
    it("CR/LF/NUL in a subject, name, address or attachment filename never produce a new header line or MIME part", async () => {
      const hostile = "x\r\nBcc: evil" + "@" + "example.net";
      const nul = "x\u0000y";
      const raw = await buildMime(
        base({
          subject: hostile,
          from: { name: hostile, address: ALEX },
          to: [{ name: nul, address: TALENT }],
          cc: [{ name: hostile, address: addr("hr", "example.net") }],
          attachments: [{ rel: "companies/acme-corp/jobs/x/application/resume.md", name: "resume" + hostile + ".md", size: 16, sha256: "0".repeat(64), type: "text/markdown", locked: null }],
        }),
        CONTENT,
      );
      const text = raw.toString("latin1");
      const headEnd = text.indexOf("\r\n\r\n");
      expect(headEnd).toBeGreaterThan(0);
      // Exactly one body boundary structure: the header block ends cleanly and nothing beyond
      // it starts a second top-level header block (which a smuggled blank-line-plus-headers
      // body would produce).
      expect(text.split("\r\n\r\n").length).toBeGreaterThanOrEqual(2);
      expect(text).not.toMatch(/^bcc:/im);
      // Exactly the two MIME parts we attached (text + one attachment): a successful header/part
      // injection via the filename would add a third boundary-delimited part.
      const boundaryLine = text.match(/boundary="?([^";\r\n]+)"?/i)?.[1];
      expect(boundaryLine).toBeTruthy();
      const partCount = text.split("--" + boundaryLine + "\r\n").length - 1;
      expect(partCount).toBe(2);
      const p = await parseMessage(raw);
      expect(p.attachments).toHaveLength(1);
    });

    it("core's own CanonicalMessage pipeline already refuses CR/LF/NUL before buildMime ever sees it", () => {
      // checkDraft (called by writeDraft/buildDraftMessage before a CanonicalMessage is built)
      // rejects a hostile subject outright, and parseAddressList rejects a hostile name --
      // so in the real app flow (not a directly hand-built CanonicalMessage, as the test
      // above constructs for defense-in-depth), buildMime is never handed this input at all.
      expect(() => checkDraft({ to: [], cc: [], subject: "x\r\nBcc: y", attach: [], in_reply_to: "", references: [], purpose: "", body: "hi" }, false)).toThrow();
      expect(() => parseAddressList(`"Alex\r\nBcc: y" <${ALEX}>`)).toThrow();
      expect(() => checkDraft({ to: [{ name: "x\u0000y", address: ALEX }], cc: [], subject: "ok", attach: [], in_reply_to: "", references: [], purpose: "", body: "hi" }, false)).toThrow();
    });
  });

  describe("address local part", () => {
    // Core's `isEmailAddress` (RFC 5322 atext) permits both '=' and '?' in a local part, so
    // `fake=?utf-8?q?FAKE?=@example.com` is a structurally valid `EmailAddress` that buildMime
    // could otherwise be handed directly. Unlike a display name, an addr-spec is never supposed
    // to carry RFC 2047 encoded words at all (RFC 2047 section 5), and relying on a decoding
    // library's own defense against that (the installed mailparser version happens to
    // blank/reject such an address) isn't something this module controls or should depend on.
    // buildMime refuses outright instead, with a plain, readable error.
    const hostile = "fake=?utf-8?q?FAKE?=" + "@" + "example.com";

    it("refuses when the from address's local part contains \"=?\"", async () => {
      await expect(buildMime(base({ from: { name: "Alex", address: hostile } }), CONTENT)).rejects.toThrow();
    });

    it("refuses when a to address's local part contains \"=?\"", async () => {
      await expect(buildMime(base({ to: [{ name: "", address: hostile }] }), CONTENT)).rejects.toThrow();
    });

    it("refuses when a cc address's local part contains \"=?\"", async () => {
      await expect(buildMime(base({ cc: [{ name: "", address: hostile }] }), CONTENT)).rejects.toThrow();
    });

    it("does not refuse an ordinary address", async () => {
      await expect(buildMime(base(), CONTENT)).resolves.toBeInstanceOf(Buffer);
    });
  });

  describe("Bcc", () => {
    it("never appears in the built message or the envelope, because CanonicalMessage has no bcc field", async () => {
      const raw = await buildMime(base(), CONTENT);
      expect(raw.toString("latin1")).not.toMatch(/^bcc:/im);
      const env = envelopeFor(base());
      expect(env).toEqual({ from: ALEX, to: [TALENT, addr("hr", "example.net")] });
      expect(JSON.stringify(env).toLowerCase()).not.toContain("bcc");
    });
  });

  describe("determinism", () => {
    it("the same message built twice is byte-identical", async () => {
      const a = await buildMime(base(), CONTENT);
      const b = await buildMime(base(), CONTENT);
      expect(a.equals(b)).toBe(true);
    });

    it("does not depend on how many other messages were built first", async () => {
      const before = await buildMime(base(), CONTENT);
      for (let i = 0; i < 25; i++) await buildMime(base({ draft_id: `20260101t000000-warmup${i}` }), CONTENT);
      const after = await buildMime(base(), CONTENT);
      expect(after.equals(before)).toBe(true);
    });

    it("does not depend on the process timezone", async () => {
      const original = process.env.TZ;
      try {
        process.env.TZ = "UTC";
        const utc = await buildMime(base(), CONTENT);
        process.env.TZ = "Australia/Brisbane";
        const brisbane = await buildMime(base(), CONTENT);
        expect(brisbane.equals(utc)).toBe(true);
      } finally {
        if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
      }
    });

    it("does not depend on the host name", async () => {
      const spy = vi.spyOn(os, "hostname").mockReturnValue("some-other-host.invalid");
      try {
        const spied = await buildMime(base(), CONTENT);
        spy.mockRestore();
        const plain = await buildMime(base(), CONTENT);
        expect(spied.equals(plain)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("does not depend on Math.random", async () => {
      const spy = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("buildMime must not call Math.random"); });
      try {
        await expect(buildMime(base(), CONTENT)).resolves.toBeInstanceOf(Buffer);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("boundary collision", () => {
    // The multipart boundary is derived from the draft id (`careeros-<draft id>`). If the body
    // or an attachment's bytes happened to contain that exact string, a naive multipart reader
    // could be confused into treating attacker- or user-supplied content as a new MIME part
    // boundary. buildMime refuses to build rather than emit a message where that's possible.
    it("refuses when the body contains the boundary string", async () => {
      await expect(buildMime(base({ text: "hi\ncareeros-20260115t093000-abc123\nbye" }), CONTENT)).rejects.toThrow();
    });

    it("refuses when an attachment's content contains the boundary string", async () => {
      await expect(buildMime(base(), [Buffer.from("careeros-20260115t093000-abc123")])).rejects.toThrow();
    });

    it("does not refuse ordinary content that merely contains the draft id's digits", async () => {
      await expect(buildMime(base({ text: "Interview on 20260115 works, ref abc123." }), CONTENT)).resolves.toBeInstanceOf(Buffer);
    });
  });

  describe("round trip", () => {
    it("preserves non-ASCII names, long subjects (folding), and binary attachment bytes", async () => {
      const longSubject = "Re: ".repeat(40) + "Interview für Alex ✓ — опыт работы";
      const binary = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
      const m = base({
        subject: longSubject,
        from: { name: "Алекс Экзампл", address: ALEX },
        to: [{ name: "田中 太郎", address: TALENT }],
        attachments: [{ rel: "companies/acme-corp/jobs/x/application/photo.png", name: "履歴書.png", size: binary.length, sha256: "0".repeat(64), type: "image/png", locked: null }],
      });
      const raw = await buildMime(m, [binary]);
      const p = await parseMessage(raw);
      expect(p.subject).toBe(longSubject);
      expect(p.from).toEqual({ name: "Алекс Экзампл", address: ALEX });
      expect(p.to).toEqual([{ name: "田中 太郎", address: TALENT }]);
      expect(p.attachments).toHaveLength(1);
      expect(p.attachments[0]!.name).toBe("履歴書.png");
      expect(p.attachments[0]!.content.equals(binary)).toBe(true);
    });
  });
});
