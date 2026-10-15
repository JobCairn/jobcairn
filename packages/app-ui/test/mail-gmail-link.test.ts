import { describe, expect, it } from "vitest";
import { gmailLink } from "../src/mail/gmail";

const at = (u: string, d: string) => u + "@" + d;

describe("gmailLink", () => {
  it("searches the connected account for the exact Message-ID", () => {
    expect(gmailLink(`<${at("m1", "example.org")}>`, at("alex", "example.com")))
      .toBe(`https://mail.google.com/mail/?authuser=alex%40example.com#search/rfc822msgid%3Am1%40example.org`);
    expect(gmailLink(at("m1", "example.org"), "")).toBe("https://mail.google.com/mail/#search/rfc822msgid%3Am1%40example.org");
  });
  it("encodes anything that could change the link", () => {
    expect(gmailLink(`<${at("a#b&c?d", "example.org")}>`, "")).toBe("https://mail.google.com/mail/#search/rfc822msgid%3Aa%23b%26c%3Fd%40example.org");
  });
  it("offers nothing for a missing, made-up or malformed Message-ID", () => {
    expect(gmailLink("", "")).toBe("");
    expect(gmailLink(`<${"0".repeat(32)}.synthetic${"@"}localhost>`, "")).toBe("");
    expect(gmailLink("<a b@example.org>", "")).toBe("");
    expect(gmailLink(`<${"x".repeat(600)}>`, "")).toBe("");
  });
});
