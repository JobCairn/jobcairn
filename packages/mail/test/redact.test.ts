import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

const addr = (u: string, d: string) => u + "@" + d;
const PASSWORD = "abcd" + "efgh" + "ijkl" + "mnop";

describe("redact", () => {
  it("removes addresses and the password, spaced or not", () => {
    const line = `login failed for ${addr("alex", "example.com")} with ${PASSWORD} (also "abcd efgh ijkl mnop")`;
    const out = redact(line, ["abcd efgh ijkl mnop"]);
    expect(out).not.toContain(addr("alex", "example.com"));
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain("abcd efgh ijkl mnop");
    expect(out).toContain("[address]");
    expect(out).toContain("[secret]");
  });
  it("removes IMAP and SMTP auth tokens", () => {
    expect(redact("C: A1 AUTHENTICATE PLAIN AGFsZXgAc2VjcmV0")).toBe("C: A1 AUTHENTICATE PLAIN [secret]");
    expect(redact(`C: A1 LOGIN "${addr("alex", "example.com")}" "hunter2-fictional"`)).toBe("C: A1 LOGIN [address] [secret]");
    expect(redact("AUTH PLAIN AGFsZXgAc2VjcmV0")).toBe("AUTH PLAIN [secret]");
  });
  it("keeps one short line and leaves counts alone", () => {
    expect(redact("stored=2 triaged=1\nskipped=5")).toBe("stored=2 triaged=1 skipped=5");
    expect(redact("x".repeat(900))).toHaveLength(500);
  });

  it("redacts very long lines without quadratic blowup (no '@', then many '@'s)", () => {
    const noAt = "a".repeat(200_000);
    const t0 = Date.now();
    redact(noAt);
    expect(Date.now() - t0).toBeLessThan(200);

    const manyAt = "a@".repeat(100_000);
    const t1 = Date.now();
    redact(manyAt);
    expect(Date.now() - t1).toBeLessThan(200);
  });

  it("handles long AUTH/LOGIN-shaped input without quadratic blowup", () => {
    const big = `C: A1 LOGIN ${"a".repeat(200_000)}`;
    const t0 = Date.now();
    redact(big);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("redacts base64 (standard and URL-safe, padded and unpadded) and percent-encoded forms of a secret", () => {
    const secret = "s3cr3t/value+token";
    const b64 = Buffer.from(secret, "utf8").toString("base64");
    const b64NoPad = b64.replace(/=+$/, "");
    const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_");
    const b64urlNoPad = b64url.replace(/=+$/, "");
    const enc = encodeURIComponent(secret);
    const line = `seen: ${b64} | ${b64NoPad} | ${b64url} | ${b64urlNoPad} | ${enc}`;
    const out = redact(line, [secret]);
    for (const v of [b64, b64NoPad, b64url, b64urlNoPad, enc]) expect(out).not.toContain(v);
    expect(out).toContain("[secret]");
  });

  it("redacts unicode email addresses and keeps punycode addresses working", () => {
    const unicodeAddr = addr("müller", "münchen.de"); // müller@münchen.de
    const out = redact(`contact ${unicodeAddr} for details`);
    expect(out).not.toContain(unicodeAddr);
    expect(out).toContain("[address]");

    const punycode = addr("alex", "xn--mnchen-3ya.de");
    const out2 = redact(`contact ${punycode} for details`);
    expect(out2).not.toContain(punycode);
    expect(out2).toContain("[address]");
  });

  it("redacts bare long base64 tokens (SASL continuation lines with no keyword)", () => {
    const address = addr("alex", "example.com");
    const encodedAddress = Buffer.from(address, "utf8").toString("base64");
    const out1 = redact("C: " + encodedAddress);
    expect(out1).not.toContain(address);
    expect(out1).not.toContain(encodedAddress);
    expect(out1).toContain("[token]");

    const xoauth2 = `user=${address}\x01auth=Bearer ${PASSWORD}\x01\x01`;
    const encodedXoauth2 = Buffer.from(xoauth2, "utf8").toString("base64");
    const out2 = redact("C: " + encodedXoauth2);
    expect(out2).not.toContain(encodedXoauth2);
    expect(out2).toContain("[token]");
  });

  it("collapses exotic line-separator characters so one input can't fake two log lines", () => {
    const withSeparators = "line-one\u2028line-two\u2029line-three\u0085line-four\fline-five\vline-six";
    expect(redact(withSeparators)).toBe("line-one line-two line-three line-four line-five line-six");
  });

  it("strips stray C0/C1 control characters", () => {
    const withControls = "a\u0000b\u0007c\u001Bd\u009Ee";
    expect(redact(withControls)).toBe("abcde");
  });

  it("strips invisible format characters so they can't hide an address", () => {
    const zwspBeforeAt = "alex" + "\u200B" + "@example.com";
    const out1 = redact(`contact ${zwspBeforeAt} now`);
    expect(out1).not.toContain("alex");
    expect(out1).not.toContain("example.com");
    expect(out1).toContain("[address]");

    const zwspInDomain = "alex@exa" + "\u200B" + "mple.com";
    const out2 = redact(`contact ${zwspInDomain} now`);
    expect(out2).not.toContain("alex");
    expect(out2).not.toContain("example.com");
    expect(out2).toContain("[address]");

    const zwnjInLocal = "al" + "\u200C" + "ex@example.com";
    const out3 = redact(`contact ${zwnjInLocal} now`);
    expect(out3).not.toContain("alex");
    expect(out3).not.toContain("example.com");
    expect(out3).toContain("[address]");

    const bidiOverride = "alex@exa" + "\u202E" + "mple.com";
    const out4 = redact(`contact ${bidiOverride} now`);
    expect(out4).not.toContain("alex");
    expect(out4).not.toContain("example.com");
    expect(out4).toContain("[address]");
  });

  it("strips a soft hyphen from a secret before matching", () => {
    const secret = "sec" + "\u00AD" + "ret-value-1";
    const line = `token: ${secret}`;
    const out = redact(line, [secret]);
    expect(out).not.toContain("secret-value-1");
    expect(out).not.toContain("sec\u00ADret-value-1");
    expect(out).toContain("[secret]");
  });

  it("stripping invisible characters doesn't introduce quadratic blowup", () => {
    const withInvisibles = ("a\u200B".repeat(100_000));
    const t0 = Date.now();
    redact(withInvisibles);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("strips U+034F (combining grapheme joiner, category Mn not Cf) so it can't hide an address", () => {
    const cgjBeforeAt = "alex" + "\u034F" + "@example.com";
    const out = redact(`contact ${cgjBeforeAt} now`);
    expect(out).not.toContain("alex");
    expect(out).not.toContain("example.com");
    expect(out).toContain("[address]");
  });

  it("strips a tag character (U+E0001, outside the BMP) inside the domain", () => {
    const tagInDomain = "alex@exa" + "\u{E0001}" + "mple.com";
    const out = redact(`contact ${tagInDomain} now`);
    expect(out).not.toContain("alex");
    expect(out).not.toContain("example.com");
    expect(out).toContain("[address]");
  });

  it("keeps a decomposed combining accent as part of the local part instead of splitting the address", () => {
    const decomposedLocal = "jose" + "\u0301"; // "jos\u00E9" as "jose" + combining acute accent
    const withAccent = addr(decomposedLocal, "example.com");
    const out = redact(`contact ${withAccent} now`);
    expect(out).not.toContain("jose");
    expect(out).not.toContain("example.com");
    expect(out).toContain("[address]");
  });
});

describe("fix round 1: case, separator and base64-prefix variants of a secret", () => {
  const PW = "abcd" + "efgh" + "ijkl" + "mnop";
  it("redacts the secret in any case, with spaces or hyphens between any characters", () => {
    for (const v of [PW.toUpperCase(), "AbCd" + "eFgH" + "iJkL" + "mNoP", "ABCD EFGH IJKL MNOP", "abcd-efgh-ijkl-mnop", "ABCD-EFGH-IJKL-MNOP", "a b-c d\tefghijklmnop"]) {
      const out = redact(`pass=${v} end`, [PW]);
      expect(out, v).toBe("pass=[secret] end");
    }
    // A stored secret with spaces still matches its compact form in any case.
    expect(redact("x " + PW.toUpperCase(), ["abcd efgh ijkl mnop"])).toBe("x [secret]");
  });
  it("redacts a 12+ character prefix of the secret's base64 form, but leaves base64 case-sensitive", () => {
    const b64 = Buffer.from(PW).toString("base64");
    expect(redact(`t=${b64.slice(0, 12)};`, [PW])).toBe("t=[secret];");
    expect(redact(`t=${b64.slice(0, 11)};`, [PW])).toBe(`t=${b64.slice(0, 11)};`);
    expect(redact(`t=${b64.toLowerCase()};`, [PW])).not.toContain("[secret]");
  });
  it("stays linear on a long run of separators and near-misses", () => {
    const line = ("abcd-efgh-ijkl-mno- ").repeat(5000);
    const start = performance.now();
    redact(line, [PW]);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("Task 10 carry-over: wider separators, lone surrogates, cached patterns", () => {
  const PW = "abcd" + "efgh" + "ijkl" + "mnop";
  it("redacts the secret split by en-dashes, dots, underscores, plus signs or %20", () => {
    for (const v of ["abcd–efgh–ijkl–mnop", "abcd‐efgh―ijkl‒mnop", "abcd.efgh.ijkl.mnop", "abcd_efgh_ijkl_mnop", "abcd+efgh+ijkl+mnop", "abcd%20efgh%20ijkl%20mnop", "ABCD. _+%20-efgh ijkl—mnop"]) {
      expect(redact(`pass=${v} end`, [PW]), v).toBe("pass=[secret] end");
    }
  });
  it("still redacts a secret that itself contains separator characters", () => {
    const s = "s3cr3t.value+tok_en";
    expect(redact(`x ${s} y`, [s])).toBe("x [secret] y");
    expect(redact(`x ${"S3CR3T value tok en"} y`, [s])).toBe("x [secret] y");
  });
  it("stays linear on long runs of the new separators and %20", () => {
    for (const line of [("abcd.efgh_ijkl+mno%20 ").repeat(5000), "%20".repeat(60_000) + "x", ("%2%20%" + "2").repeat(10_000)]) {
      const start = performance.now();
      redact(line, [PW, "%2" + "0%2" + "0%2" + "0x", "%2%2%2%2%2"]);
      expect(performance.now() - start, line.slice(0, 20)).toBeLessThan(2000);
    }
  });
  it("never throws on a secret with a lone surrogate", () => {
    const lone = "abcd" + "\uD800" + "efgh";
    expect(() => redact("x abcdefgh y", [lone])).not.toThrow();
    expect(redact(`x ${lone} y`, [lone])).toBe("x [secret] y");
    expect(() => redact("x", ["\uDC00\uDC00\uDC00\uDC00"])).not.toThrow();
  });
  it("gives the same answer when the same secrets array is reused, and notices a changed array", () => {
    const secrets = [PW];
    expect(redact(`a ${PW}`, secrets)).toBe("a [secret]");
    expect(redact(`b ${PW}`, secrets)).toBe("b [secret]");
    secrets[0] = "zyxw" + "vuts";
    expect(redact(`c ${PW}`, secrets)).toBe(`c ${PW}`);
    expect(redact("c zyxwvuts", secrets)).toBe("c [secret]");
  });
});
