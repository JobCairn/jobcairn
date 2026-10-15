import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authResult, cleanAddress, cleanAttachmentName, finishAttachmentName, MailParseError, normalizeSubject, parseMessage, syntheticMessageId,
} from "../src/parse.js";
import { addr, ALEX, rawMessage, TALENT } from "../src/testing.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const mid = (s: string) => "<" + s + "@" + "example.org>";

describe("parseMessage", () => {
  it("reads the header fields and the text", async () => {
    const p = await parseMessage(rawMessage({ fromName: "Acme Talent", cc: addr("hr", "example.net"), replyTo: addr("jobs", "example.org") }));
    expect(p).toMatchObject({
      message_id: mid("m1"), synthetic_id: false, subject: "Interview for AI Engineer", date: "2026-01-14T09:00:00.000Z",
      from: { name: "Acme Talent", address: TALENT }, to: [{ name: "", address: ALEX }], cc: [{ name: "", address: addr("hr", "example.net") }],
      reply_to: [{ name: "", address: addr("jobs", "example.org") }], auth: "none", attachments: [], html: "",
    });
    expect(p.text).toContain("Could you talk on Friday?");
    expect(p.thread_key).toBe(mid("m1"));
  });
  it("threads replies on the first reference, then In-Reply-To", async () => {
    const p = await parseMessage(rawMessage({ id: "m3", inReplyTo: mid("m2"), references: `${mid("m1")} ${mid("m2")}` }));
    expect(p).toMatchObject({ in_reply_to: mid("m2"), references: [mid("m1"), mid("m2")], thread_key: mid("m1") });
    expect((await parseMessage(rawMessage({ id: "m4", inReplyTo: mid("m2") }))).thread_key).toBe(mid("m2"));
  });
  it("lists attachments with stable part numbers and inline cid images", async () => {
    const p = await parseMessage(rawMessage({
      html: '<p>Hi <img src="cid:logo@acme"></p>',
      attachments: [{ name: "logo.png", type: "image/png", content: PNG, cid: "logo@acme" }, { name: "Interview details.pdf", type: "application/pdf", content: Buffer.from("%PDF-1.4 fictional") }],
    }));
    expect(p.attachments.map(({ content: _c, ...a }) => a)).toEqual([
      { part: "1", name: "logo.png", size: PNG.length, type: "image/png", cid: "logo@acme", inline: true },
      { part: "2", name: "Interview details.pdf", size: 18, type: "application/pdf", cid: "", inline: false },
    ]);
    expect(p.html).toContain('src="cid:logo@acme"');
  });
  // Fix round 1, ruling 6: the brief's own 300-char-cap / untruncated-244-char test is replaced --
  // a byte cap of 200 means this long, multibyte (404-byte) name must now come back truncated.
  it("caps a long, non-ASCII attachment name in UTF-8 bytes, not characters (ruling 6)", async () => {
    const long = `${"Résumé – 面接 ".repeat(20)}.pdf`;
    expect(Buffer.byteLength(long, "utf8")).toBe(404); // sanity check on the fixture itself
    const p = await parseMessage(rawMessage({
      attachments: [{ name: long, type: "application/pdf", content: Buffer.from("%PDF-1.4") }],
    }));
    const name = p.attachments[0]!.name;
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(200);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(name.length).toBeLessThan(long.length);
  });
  it("makes up a stable id and leaves the date empty when the headers are missing (Review Focus 3)", async () => {
    const raw = rawMessage({ id: null, date: null });
    const a = await parseMessage(raw);
    const b = await parseMessage(Buffer.from(raw));
    expect(a.synthetic_id).toBe(true);
    expect(a.message_id).toBe(syntheticMessageId(raw));
    expect(a.message_id).toMatch(/^<[0-9a-f]{32}\.synthetic@localhost>$/);
    expect(b.message_id).toBe(a.message_id);
    expect(a.date).toBeNull();
    expect(a.thread_key).toBe(a.message_id);
  });
  it("decodes encoded subjects in other scripts and strips control characters", async () => {
    const subject = "Entrevista ✓ 面接 für Alex";
    const p = await parseMessage(rawMessage({ subject: `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=` }));
    expect(p.subject).toBe(subject);
  });
  it("reads Gmail's authentication result", async () => {
    const fail = "mx.google.com; dkim=none; spf=fail smtp.mailfrom=example.org; dmarc=fail (p=REJECT) header.from=example.org";
    expect((await parseMessage(rawMessage({ auth: fail }))).auth).toBe("fail");
    expect((await parseMessage(rawMessage({ auth: "mx.google.com; dkim=pass; spf=pass; dmarc=pass header.from=example.org" }))).auth).toBe("pass");
  });

  // --- additional coverage for the rulings beyond the brief's own tests ---

  it("refuses a message over the raw size limit with a plain Error", async () => {
    const huge = Buffer.concat([rawMessage(), Buffer.alloc(25 * 1024 * 1024)]);
    await expect(parseMessage(huge)).rejects.toThrow(/limit/i);
  });

  it("never substitutes mailparser's silent 'now' fallback for an unparsable Date header (ruling 6)", async () => {
    const p = await parseMessage(rawMessage({ date: "not a real date at all" }));
    expect(p.date).toBeNull();
  });

  it("keeps a far-future or pre-1970 Date as valid ISO instead of rejecting it (ruling 6)", async () => {
    const future = await parseMessage(rawMessage({ date: "Fri, 01 Jan 2999 00:00:00 +0000" }));
    expect(future.date).toBe("2999-01-01T00:00:00.000Z");
    const past = await parseMessage(rawMessage({ date: "Tue, 01 Jan 1935 00:00:00 +0000" }));
    expect(past.date).toBe("1935-01-01T00:00:00.000Z");
  });

  it("treats a Message-ID with no sane <local@domain> shape as missing (ruling 2)", async () => {
    const p = await parseMessage(rawMessage({ extraHeaders: ["Message-ID: not-an-id-at-all"] }));
    expect(p.synthetic_id).toBe(true);
    expect(p.message_id).not.toContain("not-an-id-at-all");
  });

  it("drops a reference with no sane <local@domain> shape instead of keeping it (ruling 2)", async () => {
    const p = await parseMessage(rawMessage({ references: `${mid("m1")} not-an-id-either` }));
    expect(p.references).toEqual([mid("m1")]);
  });

  it("sanitizes a hostile attachment name: path separators, '..', control characters and bidi overrides (ruling 3)", async () => {
    const p = await parseMessage(rawMessage({
      attachments: [
        { name: "../../etc/passwd", type: "text/plain", content: Buffer.from("x") },
        { name: "evil\r\nX-Injected: 1.txt", type: "text/plain", content: Buffer.from("x") },
        { name: "invoice‮fdp.exe", type: "application/pdf", content: Buffer.from("x") },
        { name: "​​", type: "text/plain", content: Buffer.from("x") },
      ],
    }));
    const names = p.attachments.map((a) => a.name);
    expect(names[0]).not.toMatch(/\.\.|\/|\\/);
    expect(names[1]).not.toMatch(/[\r\n]/);
    expect(names[1]).not.toContain("X-Injected");
    expect(names[2]).not.toContain("‮");
    expect(names[3]).toBe("attachment-4");
  });

  it("caps the attachment count, keeping the first N in mailparser's list order (ruling 1)", async () => {
    const attachments = Array.from({ length: 220 }, (_, i) => ({ name: `f${i}.txt`, type: "text/plain", content: Buffer.from(String(i)) }));
    const p = await parseMessage(rawMessage({ attachments }));
    expect(p.attachments.length).toBe(200);
    expect(p.attachments[0]!.name).toBe("f0.txt");
    expect(p.attachments[199]!.name).toBe("f199.txt");
  });

  it("caps an address list, keeping the first N (ruling 1)", async () => {
    const list = Array.from({ length: 600 }, (_, i) => `<u${i}@example.com>`).join(", ");
    const raw = Buffer.from(
      ["From: <a@example.org>", `To: ${list}`, "Subject: many recipients", "Date: Wed, 14 Jan 2026 09:00:00 +0000",
        "Message-ID: <many@example.org>", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "hi", ""].join("\r\n"),
    );
    const p = await parseMessage(raw);
    expect(p.to.length).toBe(500);
    expect(p.to[0]!.address).toBe("u0@example.com");
  });

  it("caps the references list, keeping the first N (ruling 1)", async () => {
    const refs = Array.from({ length: 150 }, (_, i) => mid(`r${i}`)).join(" ");
    const p = await parseMessage(rawMessage({ references: refs }));
    expect(p.references.length).toBe(100);
    expect(p.references[0]).toBe(mid("r0"));
  });

  it("trusts a top header saying fail over a forged lower header saying pass, end to end (ruling 4)", async () => {
    const p = await parseMessage(rawMessage({
      auth: "mx.google.com; dkim=pass; spf=pass; dmarc=fail (p=REJECT) header.from=example.org",
      extraHeaders: ["Authentication-Results: mx.google.com; dkim=pass; spf=pass; dmarc=pass header.from=example.org"],
    }));
    expect(p.auth).toBe("fail");
  });

  it("gives none when a top forged header has no matching authserv-id, end to end (ruling 4)", async () => {
    const p = await parseMessage(rawMessage({ auth: "evil.example; dmarc=pass" }));
    expect(p.auth).toBe("none");
  });

  // --- fix round 1 ---------------------------------------------------------------------------

  describe("R1: message_id / thread_key are path-safe", () => {
    const badIds = ["<../../etc@x>", "<a/b@c>", "<..@..>", "<.@.>", "<a\\b@c>"];
    it.each(badIds)("treats %s as missing rather than a usable path-unsafe id", async (bad) => {
      const p = await parseMessage(rawMessage({ extraHeaders: [`Message-ID: ${bad}`] }));
      expect(p.synthetic_id).toBe(true);
      expect(p.message_id).not.toContain(bad.replace(/[<>]/g, ""));
    });

    it("accepts a local-part at exactly 200 chars, rejects one over", async () => {
      const at = `<${"a".repeat(200)}@b.com>`;
      const over = `<${"a".repeat(201)}@b.com>`;
      const pAt = await parseMessage(rawMessage({ extraHeaders: [`Message-ID: ${at}`] }));
      expect(pAt.synthetic_id).toBe(false);
      expect(pAt.message_id).toBe(at);
      const pOver = await parseMessage(rawMessage({ extraHeaders: [`Message-ID: ${over}`] }));
      expect(pOver.synthetic_id).toBe(true);
    });

    it("accepts a domain-part at exactly 253 chars, rejects one over", async () => {
      const at = `<a@${"b".repeat(253)}>`;
      const over = `<a@${"b".repeat(254)}>`;
      const pAt = await parseMessage(rawMessage({ extraHeaders: [`Message-ID: ${at}`] }));
      expect(pAt.synthetic_id).toBe(false);
      expect(pAt.message_id).toBe(at);
      const pOver = await parseMessage(rawMessage({ extraHeaders: [`Message-ID: ${over}`] }));
      expect(pOver.synthetic_id).toBe(true);
    });
  });

  describe("R2: spoofed addresses are dropped, never shown cleaned-up", () => {
    it("drops a From address containing a bidi override (RLO)", async () => {
      const p = await parseMessage(rawMessage({ from: `ev‮il${"@"}example.com` }));
      expect(p.from).toEqual({ name: "", address: "unknown" });
    });
    it("drops a To address containing a zero-width space", async () => {
      const p = await parseMessage(rawMessage({ to: `al​ex${"@"}example.com` }));
      expect(p.to).toEqual([]);
    });
    it("cleanAddress drops an address containing a NUL byte (unit test: mailparser already strips NUL from real headers before this function ever sees it, so this proves this module's own defense independently of that)", () => {
      expect(cleanAddress(`a\u0000lex${"@"}example.net`)).toBe("");
      expect(cleanAddress(`alex${"@"}example.net`)).toBe(`alex${"@"}example.net`);
    });
  });

  describe("R3: strict RFC 5322 date parsing, TZ-independent", () => {
    for (const TZ of ["UTC", "Australia/Brisbane"]) {
      describe(`with process.env.TZ=${TZ}`, () => {
        let original: string | undefined;
        beforeAll(() => {
          original = process.env.TZ;
          process.env.TZ = TZ;
        });
        afterAll(() => {
          if (original === undefined) delete process.env.TZ;
          else process.env.TZ = original;
        });

        const invalid = ["1", "0", "-1", "Mon 2", "1 Jan 0001", "31 Feb 2026", "1 Jan 10000"];
        it.each(invalid)("gives null for %s", async (bad) => {
          const p = await parseMessage(rawMessage({ date: bad }));
          expect(p.date).toBeNull();
        });

        it("gives null for a zone offset over 14 hours (+9959)", async () => {
          const p = await parseMessage(rawMessage({ date: "Wed, 14 Jan 2026 09:00:00 +9959" }));
          expect(p.date).toBeNull();
        });

        it("never rolls an impossible day into the next month (31 Feb, fully-formed)", async () => {
          const p = await parseMessage(rawMessage({ date: "Sat, 31 Feb 2026 09:00:00 +0000" }));
          expect(p.date).toBeNull();
        });

        it("rejects a 4-digit year below 1900, fully-formed", async () => {
          const p = await parseMessage(rawMessage({ date: "Mon, 01 Jan 0001 09:00:00 +0000" }));
          expect(p.date).toBeNull();
        });

        it("rejects a 5-digit year, fully-formed", async () => {
          const p = await parseMessage(rawMessage({ date: "Thu, 01 Jan 10000 09:00:00 +0000" }));
          expect(p.date).toBeNull();
        });

        it("parses a valid obsolete named zone (EST) to the correct UTC instant", async () => {
          const p = await parseMessage(rawMessage({ date: "Wed, 14 Jan 2026 09:00:00 EST" }));
          expect(p.date).toBe("2026-01-14T14:00:00.000Z");
        });

        it("parses a valid 2-digit obsolete year per RFC 5322 section 4.3", async () => {
          const p = await parseMessage(rawMessage({ date: "Wed, 14 Jan 26 09:00:00 +0000" }));
          expect(p.date).toBe("2026-01-14T09:00:00.000Z");
        });
      });
    }
  });

  describe("R4: authResult reads dmarc only from a real resinfo segment", () => {
    it("gives none for the reviewer's forged-dmarc-inside-an-spf-comment-and-mailfrom spoof", async () => {
      const forged = addr("dmarc=pass", "evil.com");
      const spoof = `mx.google.com; spf=pass (google.com: domain of ${forged} designates 1.2.3.4) smtp.mailfrom=${forged}`;
      const p = await parseMessage(rawMessage({ auth: spoof }));
      expect(p.auth).toBe("none");
    });
    it("gives none for a forged dmarc inside an arc resinfo's comment", async () => {
      const spoof = "mx.google.com; arc=pass (i=1 spf=pass dmarc=pass fromdomain=x.com)";
      const p = await parseMessage(rawMessage({ auth: spoof }));
      expect(p.auth).toBe("none");
    });
    it("gives none when the header has no ';' at all, end to end", async () => {
      const p = await parseMessage(rawMessage({ auth: "mx.google.com dmarc=pass" }));
      expect(p.auth).toBe("none");
    });
  });

  describe("R5: big or hostile MIME", () => {
    it("parses a 2.1 MB HTML-only message, retrying with an empty text rather than rejecting", async () => {
      // Built by hand rather than via rawMessage({ html }): that helper always adds a text/plain
      // alternative alongside the html part, and mailparser only attempts (and can fail) the
      // html-to-text conversion that triggers "HTML too long for parsing" when the HTML is the
      // root part with no separate text/plain part at all -- confirmed experimentally.
      const html = `<p>${"x".repeat(2_100_000)}</p>`;
      const raw = Buffer.from(
        ["From: <a@example.org>", "To: <b@example.org>", "Subject: big html", "Date: Wed, 14 Jan 2026 09:00:00 +0000",
          "Message-ID: <bightml@example.org>", "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: 8bit", "", html, ""].join("\r\n"),
      );
      const p = await parseMessage(raw);
      expect(p.html.length).toBeGreaterThan(2_000_000);
      expect(p.text).toBe("");
    });

    it("rejects a message with over 1000 MIME parts with a typed MailParseError", async () => {
      const boundary = "toocomplex";
      const parts: string[] = [];
      for (let i = 0; i < 1005; i++) parts.push(`--${boundary}`, "Content-Type: text/plain", "", `part ${i}`);
      parts.push(`--${boundary}--`, "");
      const raw = Buffer.from(
        ["From: <a@example.org>", "To: <b@example.org>", "Subject: too complex", "Date: Wed, 14 Jan 2026 09:00:00 +0000",
          "Message-ID: <complex@example.org>", "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n"),
      );
      await expect(parseMessage(raw)).rejects.toMatchObject({ code: "too_complex" });
      await expect(parseMessage(raw)).rejects.toBeInstanceOf(MailParseError);
    });
  });

  describe("R6: attachment name hardening", () => {
    it("caps 299 CJK characters plus an extension at <= 200 bytes, keeping .pdf", async () => {
      const name = `${"面".repeat(299)}.pdf`;
      const p = await parseMessage(rawMessage({ attachments: [{ name, type: "application/pdf", content: Buffer.from("x") }] }));
      const out = p.attachments[0]!.name;
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
      expect(out.endsWith(".pdf")).toBe(true);
    });

    it("never leaves a lone surrogate when the byte cut lands inside an emoji", async () => {
      // "a" is 1 byte; pad so the 200-byte cut falls inside the 4-byte emoji that follows.
      const name = `${"a".repeat(198)}\u{1F600}${"b".repeat(20)}.png`;
      const p = await parseMessage(rawMessage({ attachments: [{ name, type: "image/png", content: Buffer.from("x") }] }));
      const out = p.attachments[0]!.name;
      // eslint-disable-next-line no-misleading-character-class
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
    });

    it("neutralises an RFC 2231-encoded traversal filename", async () => {
      const boundary = "b2231";
      const parts = [
        `--${boundary}`, "Content-Type: application/pdf",
        "Content-Disposition: attachment; filename*0*=UTF-8''..%2F..%2Fx",
        "Content-Transfer-Encoding: base64", "", Buffer.from("hi").toString("base64"),
        `--${boundary}--`, "",
      ];
      const raw = Buffer.from(
        ["From: <a@example.org>", "To: <b@example.org>", "Subject: t", "Date: Wed, 14 Jan 2026 09:00:00 +0000",
          "Message-ID: <m1@example.org>", "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n"),
      );
      const p = await parseMessage(raw);
      const name = p.attachments[0]!.name;
      expect(name).not.toMatch(/\.\.|\//);
    });

    it("falls back to attachment-<part> for a name of only dots and spaces", async () => {
      const p = await parseMessage(rawMessage({
        attachments: [
          { name: ".", type: "text/plain", content: Buffer.from("x") },
          { name: ". .", type: "text/plain", content: Buffer.from("x") },
        ],
      }));
      expect(p.attachments[0]!.name).toBe("attachment-1");
      expect(p.attachments[1]!.name).toBe("attachment-2");
    });

    it("keeps the extension dot when excess leading dots are collapsed (...pdf -> _.pdf)", async () => {
      const p = await parseMessage(rawMessage({ attachments: [{ name: "...pdf", type: "application/pdf", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe("_.pdf");
    });

    it("replaces Windows-reserved characters (delivered via RFC 2231 encoding, since a literal quote can't survive the test fixture's naive quoted-string header)", async () => {
      const boundary = "breserved";
      const encodedName = encodeURIComponent('a:b*c?d"e<f>g|h.txt');
      const parts = [
        `--${boundary}`, "Content-Type: text/plain",
        `Content-Disposition: attachment; filename*0*=UTF-8''${encodedName}`,
        "Content-Transfer-Encoding: base64", "", Buffer.from("x").toString("base64"),
        `--${boundary}--`, "",
      ];
      const raw = Buffer.from(
        ["From: <a@example.org>", "To: <b@example.org>", "Subject: t", "Date: Wed, 14 Jan 2026 09:00:00 +0000",
          "Message-ID: <m1@example.org>", "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n"),
      );
      const p = await parseMessage(raw);
      expect(p.attachments[0]!.name).not.toMatch(/[:*?"<>|]/);
    });

    it("replaces a leading '-' or '~'", async () => {
      const p1 = await parseMessage(rawMessage({ attachments: [{ name: "-rf.txt", type: "text/plain", content: Buffer.from("x") }] }));
      expect(p1.attachments[0]!.name.startsWith("-")).toBe(false);
      const p2 = await parseMessage(rawMessage({ attachments: [{ name: "~root.txt", type: "text/plain", content: Buffer.from("x") }] }));
      expect(p2.attachments[0]!.name.startsWith("~")).toBe(false);
    });
  });

  describe("R7: a whitespace-split References fragment is dropped, not kept as a made-up id", () => {
    it("drops both fragments of a reference containing an internal space", async () => {
      const raw = Buffer.from(
        ["From: <a@example.org>", "To: <b@example.org>", "Subject: t", "Date: Wed, 14 Jan 2026 09:00:00 +0000",
          "Message-ID: <m3@example.org>", `References: ${mid("m1")} <a b@c> ${mid("m2")}`,
          "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "hi", ""].join("\r\n"),
      );
      const p = await parseMessage(raw);
      expect(p.references).toEqual([mid("m1"), mid("m2")]);
      expect(p.references).not.toContain("<b@c>");
    });
  });

  describe("R8: duplicate headers and encoded-word stripping", () => {
    it("keeps the last header when From/Subject/Message-ID are duplicated", async () => {
      const p = await parseMessage(rawMessage({
        fromName: "First Name", from: addr("first", "example.org"), subject: "First subject",
        extraHeaders: [
          `From: "Second Name" <${addr("second", "example.org")}>`,
          "Subject: Second subject",
          "Message-ID: <second@example.org>",
        ],
      }));
      expect(p.from).toEqual({ name: "Second Name", address: addr("second", "example.org") });
      expect(p.subject).toBe("Second subject");
      expect(p.message_id).toBe("<second@example.org>");
    });

    it("Date good-then-garbage gives null", async () => {
      const p = await parseMessage(rawMessage({ extraHeaders: ["Date: not a real date"] }));
      expect(p.date).toBeNull();
    });

    it("Date garbage-then-good gives the valid date", async () => {
      const p = await parseMessage(rawMessage({
        date: "not a real date",
        extraHeaders: ["Date: Wed, 14 Jan 2026 09:00:00 +0000"],
      }));
      expect(p.date).toBe("2026-01-14T09:00:00.000Z");
    });

    it("removes CR/LF/NUL/RLO from an RFC 2047 encoded-word subject, not just decodes it", async () => {
      // The hostile bytes are decoded (not just left encoded -- that's the point: mailparser
      // decodes the encoded-word for us, so stripping must run on the *decoded* text), then each
      // one collapses to a single space; the surrounding literal text ("X-Evil: 1", "Reversed")
      // is otherwise harmless prose and is correctly left alone -- there's no actual newline left
      // for it to pretend to be a new header/log line.
      const hostile = "Entrevista\r\nX-Evil: 1\u0000‮Reversed";
      const encoded = `=?UTF-8?B?${Buffer.from(hostile, "utf8").toString("base64")}?=`;
      const p = await parseMessage(rawMessage({ subject: encoded }));
      expect(p.subject).not.toMatch(/[\r\n\u0000‮]/);
      expect(p.subject).toBe("Entrevista X-Evil: 1 Reversed");
    });

    it("removes CR/LF/NUL/RLO from an RFC 2047 encoded-word display name, not just decodes it", async () => {
      const hostile = "Acme\r\nX-Evil: 1\u0000‮Reversed";
      const encoded = `=?UTF-8?B?${Buffer.from(hostile, "utf8").toString("base64")}?=`;
      const raw = Buffer.from(
        [`From: ${encoded} <${TALENT}>`, `To: <${ALEX}>`, "Subject: t", "Date: Wed, 14 Jan 2026 09:00:00 +0000",
          "Message-ID: <m1@example.org>", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "hi", ""].join("\r\n"),
      );
      const p = await parseMessage(raw);
      expect(p.from.name).not.toMatch(/[\r\n\u0000‮]/);
      expect(p.from.name).toBe("Acme X-Evil: 1 Reversed");
    });
  });

  // --- fix round 2 ---------------------------------------------------------------------------

  describe("R9: ReDoS timing guards for attachment-name cleaning (ruling 1)", () => {
    // The old `TRAILING_DOTS_BEFORE_EXT` regex measured over 11s locally for 80k dots + "!"
    // (quadratic backtracking); a linear implementation handles even these hostile names, end to
    // end through parseMessage, in a few milliseconds. 500ms leaves generous headroom for a slow
    // CI box while still failing hard if quadratic behaviour is ever reintroduced (which would
    // push these well past a second, not a few hundred milliseconds).
    const BUDGET_MS = 500;

    async function timeParse(name: string, type = "text/plain"): Promise<number> {
      const start = performance.now();
      await parseMessage(rawMessage({ attachments: [{ name, type, content: Buffer.from("x") }] }));
      return performance.now() - start;
    }

    it("cleans a name of 100,000 dots followed by '!' well under budget", async () => {
      expect(await timeParse(`${".".repeat(100_000)}!`)).toBeLessThan(BUDGET_MS);
    });

    it("cleans a name of 100,000 dots followed by 'pdf' well under budget", async () => {
      expect(await timeParse(`${".".repeat(100_000)}pdf`, "application/pdf")).toBeLessThan(BUDGET_MS);
    });

    // Fix round 3, ruling 3: the end-to-end "1,000,000 'a'" variant of this test (through
    // parseMessage) measured at 50-85% of its budget, mostly inside mailparser/mailsplit itself,
    // not this module's own name-cleaning -- and it passed even against the pre-round-2 (buggy,
    // quadratic) code, since `rawMessage`'s double name-embedding trips mailsplit's own 1 MB
    // header-size guard well before a name that long ever reaches `cleanAttachmentName`. Removed
    // in favour of calling `cleanAttachmentName` directly (an @internal export, like
    // `cleanAddress`): this isolates the function's own linearity from mailparser/mailsplit's
    // unrelated overhead and limits, and a budget this tight (well under what even a single parse
    // of a small message takes) only passes if the function really is linear.
    it("cleans a name of 1,000,000 '.' characters followed by '!' well under budget, called directly", () => {
      // Build the input before starting the timer (fix round 4, task 7 review carry-over): the
      // previous version of this test built the 1,000,000-character name *inside* the timed span,
      // as an argument expression to the call under test, so the timing included this test's own
      // input construction, not just `cleanAttachmentName`'s own work. Only the call under test is
      // timed now; building the hostile input is unmeasured setup, the same way every other timing
      // guard in this describe block (and in match.test.ts) builds its input first.
      const name = `${".".repeat(1_000_000)}!`;
      const start = performance.now();
      const cleaned = cleanAttachmentName(name, "1");
      expect(performance.now() - start).toBeLessThan(200);
      expect(cleaned.length).toBeLessThan(1_000_000);
    });
  });

  describe("R10: dmarc verdict is quote-aware and collects every real dmarc resinfo (ruling 2)", () => {
    it("gives fail when a forged dmarc is smuggled inside a quoted mailfrom value, with a real dmarc=fail later", async () => {
      const spoof =
        `mx.google.com; spf=pass smtp.mailfrom="x; dmarc=pass y"${"@"}evil.com; ` +
        "dmarc=fail (p=REJECT) header.from=bank.com";
      const p = await parseMessage(rawMessage({ auth: spoof }));
      expect(p.auth).toBe("fail");
    });

    it("gives fail when the same trick hides inside the SPF comment, with a real dmarc=fail later", async () => {
      const spoof =
        `mx.google.com; spf=pass (google.com: domain of "x) ; dmarc=pass ; ("${"@"}evil.com designates 1.2.3.4) ` +
        "smtp.mailfrom=evil.com; dmarc=fail (p=REJECT) header.from=bank.com";
      const p = await parseMessage(rawMessage({ auth: spoof }));
      expect(p.auth).toBe("fail");
    });

    it("gives fail when two real dmarc resinfo segments disagree and one of them is fail", async () => {
      const p = await parseMessage(rawMessage({ auth: "mx.google.com; dmarc=pass; dmarc=fail" }));
      expect(p.auth).toBe("fail");
    });

    it("stays linear for a 1,000,000-character line of quotes and parens", () => {
      // Tested directly against `authResult`, not end to end through `parseMessage`: a single
      // header value this long would bump into mailsplit's own 1 MB total-header-size guard
      // (a separate, already-tested defense -- see "R5: big or hostile MIME"), which is not what
      // this test is checking. This isolates `splitResinfoSegments`/`dmarcVerdict`'s own linearity.
      const hostile = `mx.google.com; dmarc=fail ${'"('.repeat(500_000)}`;
      const start = performance.now();
      const result = authResult([hostile]);
      expect(performance.now() - start).toBeLessThan(500);
      expect(result).toBe("fail");
    });
  });

  describe("R11: date range checked on the final UTC instant; UTC zone name accepted (ruling 4)", () => {
    it("accepts 29 Feb 2024 (divisible by 4, not a century -- a real leap day)", async () => {
      const p = await parseMessage(rawMessage({ date: "Thu, 29 Feb 2024 09:00:00 +0000" }));
      expect(p.date).toBe("2024-02-29T09:00:00.000Z");
    });

    it("rejects 29 Feb 2100 (divisible by 100 but not 400 -- not a leap year)", async () => {
      const p = await parseMessage(rawMessage({ date: "Mon, 29 Feb 2100 09:00:00 +0000" }));
      expect(p.date).toBeNull();
    });

    it("accepts 29 Feb 2000 (divisible by 400 -- a real leap day)", async () => {
      const p = await parseMessage(rawMessage({ date: "Tue, 29 Feb 2000 09:00:00 +0000" }));
      expect(p.date).toBe("2000-02-29T09:00:00.000Z");
    });

    it("accepts the modern 'UTC' zone name, not just the obsolete 'UT'/'GMT'", async () => {
      const p = await parseMessage(rawMessage({ date: "Wed, 14 Jan 2026 09:00:00 UTC" }));
      expect(p.date).toBe("2026-01-14T09:00:00.000Z");
    });

    it("accepts a trailing CFWS comment after the date", async () => {
      const p = await parseMessage(rawMessage({ date: "Wed, 14 Jan 2026 09:00:00 +0000 (UTC)" }));
      expect(p.date).toBe("2026-01-14T09:00:00.000Z");
    });

    it("accepts a Date header folded across a continuation line", async () => {
      // rawMessage has no built-in support for header folding, so this message is built by hand:
      // a real folded header is one logical value split across physical lines, the second
      // starting with required whitespace (RFC 5322 CFWS), joined here with a literal CRLF + a
      // leading space baked directly into this one header line.
      const raw = Buffer.from(
        [
          `From: <${TALENT}>`, `To: <${ALEX}>`, "Subject: t", "Date: Wed, 14 Jan 2026\r\n 09:00:00 +0000",
          "Message-ID: <folded@example.org>", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "hi", "",
        ].join("\r\n"),
      );
      const p = await parseMessage(raw);
      expect(p.date).toBe("2026-01-14T09:00:00.000Z");
    });

    it("still rejects a 4-digit year below 1900 and a 5-digit year above 9999 (unchanged by ruling 4)", async () => {
      expect((await parseMessage(rawMessage({ date: "Mon, 01 Jan 0001 09:00:00 +0000" }))).date).toBeNull();
      expect((await parseMessage(rawMessage({ date: "Thu, 01 Jan 10000 09:00:00 +0000" }))).date).toBeNull();
    });
  });

  describe("R12: In-Reply-To keeps the first <...> span (ruling 6)", () => {
    it("keeps '<a@b>' from '<a@b> (comment)', the same shape extractReferences already tolerates", async () => {
      const p = await parseMessage(rawMessage({ inReplyTo: `${mid("m2")} (was: re-scheduling)` }));
      expect(p.in_reply_to).toBe(mid("m2"));
    });

    it("still keeps a plain, unadorned In-Reply-To (no regression)", async () => {
      const p = await parseMessage(rawMessage({ inReplyTo: mid("m2") }));
      expect(p.in_reply_to).toBe(mid("m2"));
    });

    it("keeps the last In-Reply-To header when duplicated, mirroring Date/Subject/Message-ID", async () => {
      const p = await parseMessage(rawMessage({
        inReplyTo: mid("m1"),
        extraHeaders: [`In-Reply-To: ${mid("m2")} (comment)`],
      }));
      expect(p.in_reply_to).toBe(mid("m2"));
    });
  });

  describe("R13: attachment name hardening, round 2 (ruling 5)", () => {
    it("strips U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR", async () => {
      // Delivered via RFC 2231 encoding, like the "Windows-reserved characters" test above: a raw,
      // un-encoded U+2028/U+2029 byte sequence inside a naive `filename="..."` quoted string isn't
      // reliably parsed back out by mailparser at all (confirmed experimentally -- it drops the
      // parameter rather than handing back a value containing them), so RFC 2231's percent-encoding
      // is the realistic way a sender's MUA would actually get these code points into a.filename.
      const boundary = "blinesep";
      const encodedName = encodeURIComponent("line break name.txt");
      const parts = [
        `--${boundary}`, "Content-Type: text/plain",
        `Content-Disposition: attachment; filename*0*=UTF-8''${encodedName}`,
        "Content-Transfer-Encoding: base64", "", Buffer.from("x").toString("base64"),
        `--${boundary}--`, "",
      ];
      const raw = Buffer.from(
        ["From: <a@example.org>", "To: <b@example.org>", "Subject: t", "Date: Wed, 14 Jan 2026 09:00:00 +0000",
          "Message-ID: <m1@example.org>", "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n"),
      );
      const p = await parseMessage(raw);
      expect(p.attachments[0]!.name).toBe("linebreakname.txt");
    });

    it("trims trailing dots and spaces that Windows silently strips", async () => {
      const p = await parseMessage(rawMessage({
        attachments: [{ name: "report.txt. . .", type: "text/plain", content: Buffer.from("x") }],
      }));
      expect(p.attachments[0]!.name).toBe("report.txt");
    });

    it.each(["CON", "con", "PRN", "AUX", "NUL", "COM1", "lpt9", "com0", "lpt0", "CONIN$", "CONOUT$"])(
      "prefixes the Windows-reserved device name '%s' with an underscore",
      async (reserved) => {
        const p = await parseMessage(rawMessage({ attachments: [{ name: reserved, type: "text/plain", content: Buffer.from("x") }] }));
        expect(p.attachments[0]!.name).toBe(`_${reserved}`);
      },
    );

    it("prefixes a Windows-reserved device name that also has an extension", async () => {
      const p = await parseMessage(rawMessage({ attachments: [{ name: "con.txt", type: "text/plain", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe("_con.txt");
    });

    it("prefixes 'COM0.txt' (device name with an extension)", async () => {
      const p = await parseMessage(rawMessage({ attachments: [{ name: "COM0.txt", type: "text/plain", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe("_COM0.txt");
    });

    // Fix round 3, ruling 2: the superscript digits COM1-9/LPT1-9 can also be written with
    // Unicode superscript glyphs (COM¹ == "COM" + superscript "1", etc.) -- Windows treats
    // these the same as the plain-digit forms when resolving a device name.
    it.each(["COM¹", "LPT²", "COM³"])("prefixes the superscript-digit device name '%s'", async (reserved) => {
      const p = await parseMessage(rawMessage({ attachments: [{ name: reserved, type: "text/plain", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe(`_${reserved}`);
    });

    it("prefixes a superscript-digit device name that also has an extension", async () => {
      const p = await parseMessage(rawMessage({ attachments: [{ name: "COM¹.txt", type: "text/plain", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe("_COM¹.txt");
    });

    it("prefixes a device name followed by trailing spaces then an extension ('CON .txt')", async () => {
      const p = await parseMessage(rawMessage({ attachments: [{ name: "CON .txt", type: "text/plain", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe("_CON .txt");
    });

    it("does not treat a reserved-looking word as reserved when it's a longer real word", async () => {
      const p = await parseMessage(rawMessage({ attachments: [{ name: "console.log", type: "text/plain", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe("console.log");
    });

    it("replaces a leading dot so no hidden file is created", async () => {
      const p = await parseMessage(rawMessage({ attachments: [{ name: ".bashrc", type: "text/plain", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe("_bashrc");
    });
  });

  describe("R14: cleanAddress is not part of the package's public API (ruling 7)", () => {
    it("is not reachable from the package entry point, only from the internal parse module", async () => {
      const index = await import("../src/index.js");
      expect("cleanAddress" in index).toBe(false);
      // sanity: the entry point still re-exports the real public API
      expect(typeof index.parseMessage).toBe("function");
      expect(typeof index.authResult).toBe("function");
    });
  });

  // --- fix round 3 ---------------------------------------------------------------------------

  describe("R15: a trailing dot or space surviving the byte cap is re-trimmed (ruling 1)", () => {
    // capAttachmentNameBytes truncates the base (pre-extension) part purely on a byte budget; if
    // that cut happens to land exactly on a '.' or ' ', the result ends with one even though the
    // earlier `.trim().replace(/[.\s]+$/, "")` pass (which ran *before* the byte cap) already
    // removed every trailing dot/space that existed at that point. Neither of these fixtures has a
    // recognizable short extension (the "b"s run 50 deep, past `capAttachmentNameBytes`'s own
    // 11-character extension allowance), so the whole 250-character name is truncated as one run,
    // landing the 200-byte cut exactly on the dot/space at index 199.
    it("re-trims a trailing space left behind by the byte cap", async () => {
      const name = `${"a".repeat(199)} ${"b".repeat(50)}`;
      const p = await parseMessage(rawMessage({ attachments: [{ name, type: "text/plain", content: Buffer.from("x") }] }));
      const out = p.attachments[0]!.name;
      expect(out).not.toMatch(/[.\s]$/);
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
    });

    it("re-trims a trailing dot left behind by the byte cap", async () => {
      const name = `${"a".repeat(199)}.${"b".repeat(50)}`;
      const p = await parseMessage(rawMessage({ attachments: [{ name, type: "text/plain", content: Buffer.from("x") }] }));
      const out = p.attachments[0]!.name;
      expect(out).not.toMatch(/[.\s]$/);
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
    });

    it("finishAttachmentName falls back to attachment-<part> when nothing survives the re-trim", () => {
      // Unit-tested directly against the new `finishAttachmentName` helper, the same way
      // `cleanAddress`'s NUL-byte test unit-tests a defense `parseMessage` can't itself exercise:
      // `cleanAttachmentName`'s own `LEADING_SPECIAL` step guarantees a real, non-dot/space
      // character always survives at the very start of whatever reaches the byte cap through the
      // full pipeline, so an *all*-dot/space input can never actually reach this point through a
      // real mail message -- this proves the fallback itself is correct in isolation, as defence in
      // depth against a future change to that guarantee.
      expect(finishAttachmentName("   ", "7")).toBe("attachment-7");
      expect(finishAttachmentName("...", "7")).toBe("attachment-7");
      expect(finishAttachmentName("", "7")).toBe("attachment-7");
      expect(finishAttachmentName("report.txt", "7")).toBe("report.txt");
    });
  });

  describe("R16: splitResinfoSegments keeps quote-tracking at depth 0 only (ruling 4)", () => {
    it("gives fail: a bare '\"' inside an spf comment doesn't block the comment's real close", async () => {
      const spoof = 'mx.google.com; spf=pass (domain of "x designates); dmarc=fail';
      const p = await parseMessage(rawMessage({ auth: spoof }));
      expect(p.auth).toBe("fail");
    });

    it("gives fail: a '\" \"' pair inside a dkim comment doesn't block the comment's real close", async () => {
      const spoof = 'mx.google.com; dkim=pass (a " b) header.d=x; dmarc=fail';
      const p = await parseMessage(rawMessage({ auth: spoof }));
      expect(p.auth).toBe("fail");
    });

    it("gives none: a backslash-escaped ')' inside a comment doesn't close it early", async () => {
      const spoof = "mx.google.com; spf=pass (a \\) ; dmarc=pass ; b)";
      const p = await parseMessage(rawMessage({ auth: spoof }));
      expect(p.auth).toBe("none");
    });

    it("stays linear for a 1,000,000-character line of quotes and parens (no regression)", () => {
      const hostile = `mx.google.com; dmarc=fail ${'"('.repeat(500_000)}`;
      const start = performance.now();
      const result = authResult([hostile]);
      expect(performance.now() - start).toBeLessThan(500);
      expect(result).toBe("fail");
    });
  });

  describe("R17: In-Reply-To keeps the first <...> span that passes cleanId (ruling 5)", () => {
    it("skips a path-unsafe/space-containing span and keeps the next valid one", async () => {
      const p = await parseMessage(rawMessage({ inReplyTo: `<a b@c> ${mid("d")}` }));
      expect(p.in_reply_to).toBe(mid("d"));
    });

    it("leaves an unbracketed id as empty, not a fabricated id", async () => {
      const p = await parseMessage(rawMessage({ inReplyTo: addr("a", "b") }));
      expect(p.in_reply_to).toBe("");
    });
  });
});

describe("helpers", () => {
  it("trusts only the topmost Authentication-Results header, never a lower one", () => {
    // forged lower header says pass; the real (topmost) one says fail -- fail wins, and the
    // lower line is never even consulted.
    expect(authResult(["mx.google.com; dmarc=fail", "mx.google.com; dmarc=pass"])).toBe("fail");
  });
  it("gives none when the topmost header's authserv-id doesn't match (no real header present)", () => {
    expect(authResult(["evil.example; dmarc=pass"])).toBe("none");
  });
  it("gives pass for a matching topmost Gmail header", () => {
    expect(authResult(["mx.google.com; dmarc=pass"])).toBe("pass");
  });
  it("matches the authserv-id case-insensitively, with whitespace and a comment trimmed", () => {
    expect(authResult(["  MX.Google.Com   (Google Inc.)  ; dmarc=pass"])).toBe("pass");
    expect(authResult(["MX.GOOGLE.COM; dmarc=fail"])).toBe("fail");
  });
  it("accepts a different expected authserv-id for a non-Gmail receiving server", () => {
    expect(authResult(["mail.example.net; dmarc=pass"], "mail.example.net")).toBe("pass");
    expect(authResult(["mail.example.net; dmarc=pass"])).toBe("none"); // default id is still "mx.google.com"
  });
  it("gives none for no headers at all", () => {
    expect(authResult([])).toBe("none");
  });
  it("gives none when there's no ';' at all -- not the whole string as the id", () => {
    expect(authResult(["mx.google.com dmarc=pass"])).toBe("none");
  });
  it("reads dmarc only from a real resinfo segment, not a substring match anywhere in the line", () => {
    const forged = addr("dmarc=pass", "evil.com");
    const spoof = `mx.google.com; spf=pass (google.com: domain of ${forged} designates 1.2.3.4) smtp.mailfrom=${forged}`;
    expect(authResult([spoof])).toBe("none");
    const spoof2 = "mx.google.com; arc=pass (i=1 spf=pass dmarc=pass fromdomain=x.com)";
    expect(authResult([spoof2])).toBe("none");
  });
  it("normalises reply and forward prefixes", () => {
    expect(normalizeSubject("Re: RE: Fwd: AW: Interview")).toBe("Interview");
    expect(normalizeSubject("  Interview ")).toBe("Interview");
  });

  // --- fix round 4 (task 7 review carry-over) ------------------------------------------------

  describe("R17: the Windows-reserved-device-name check runs after the byte cap and re-trim", () => {
    // The device-name check used to run on `cleaned` before `capAttachmentNameBytes`/
    // `finishAttachmentName`. For a name like "CON" + 300 spaces + "x", the pre-cap string is
    // "con<spaces>x" -- WINDOWS_RESERVED requires the reserved word to be followed by only
    // whitespace then a dot-or-end, and here it's followed by "x", so the check doesn't fire.
    // The byte cap then truncates away the trailing "x" (and most of the spaces) because there's
    // no recognizable short extension, and the post-cap re-trim strips the now-trailing spaces,
    // leaving exactly "CON" -- the bare reserved name, never prefixed with "_". Moving the check
    // into `finishAttachmentName`, after that re-trim, catches this: the fix's expected ouput is
    // "_CON"/"_con"/"_LPT1" (prefixed), not the bare reserved name.
    it("prefixes 'CON' surviving the byte cap behind 300 trailing spaces and a letter", async () => {
      const name = `CON${" ".repeat(300)}x`;
      const p = await parseMessage(rawMessage({ attachments: [{ name, type: "text/plain", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe("_CON");
    });

    it("prefixes 'con' surviving the byte cap behind 300 trailing ideographic spaces and a letter", async () => {
      const name = `con${"　".repeat(300)}x`;
      const p = await parseMessage(rawMessage({ attachments: [{ name, type: "text/plain", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe("_con");
    });

    it("prefixes 'LPT1' surviving the byte cap behind 250 trailing spaces and letters", async () => {
      const name = `LPT1${" ".repeat(250)}zzz`;
      const p = await parseMessage(rawMessage({ attachments: [{ name, type: "text/plain", content: Buffer.from("x") }] }));
      expect(p.attachments[0]!.name).toBe("_LPT1");
    });
  });
});
