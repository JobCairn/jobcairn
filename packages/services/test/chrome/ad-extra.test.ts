import { describe, expect, it } from "vitest";
import { contactEmail, contactLine, contactLinks, MAX_CONTACTS, parseJsonLd } from "../../src/chrome/ad-extra.js";

/** An ad's contact links and JSON-LD, read as data (fictional addresses only). */
describe("an ad's contact links", () => {
  it("takes mailto: and tel: addresses from link addresses, without query parts, deduplicated, in page order", () => {
    const tree = [
      '- link "••••@example.com" [ref=e2]', "  - /url: mailto:Jobs@Example.com?subject=AI%20Engineer&body=hi",
      '- link "Call" [ref=e3]', "  - /url: tel:+61%20491%20570%20006",
      '- link "Email again" [ref=e4, url=mailto:jobs@example.com]',
      '- link "Site" [ref=e5]', "  - /url: https://www.example.com/careers",
      '- link "Bad" [ref=e6]', "  - /url: mailto:not-an-email",
      '- link "Several" [ref=e7]', "  - /url: mailto:hr@example.com,other@example.com",
    ].join("\n");
    expect(contactLinks(tree)).toEqual(["jobs@example.com", "+61491570006", "hr@example.com"]);
  });

  it("keeps at most a handful", () => {
    const tree = Array.from({ length: 20 }, (_, i) => `- link "x" [ref=e${i}]\n  - /url: mailto:a${i}@example.com`).join("\n");
    expect(contactLinks(tree)).toHaveLength(MAX_CONTACTS);
  });

  it("says when a link is the address the ad's text masks", () => {
    expect(contactLine(["jobs@example.com", "0491570006"], "Email: ••••@example.com"))
      .toBe("Contact links in this ad: jobs@example.com (the ad's text shows it masked as ••••@example.com), 0491570006");
    expect(contactLine(["jobs@example.com"], "Apply through the button.")).toBe("Contact links in this ad: jobs@example.com");
    expect(contactLine([], "Email: ••••@example.com")).toBe("");
    expect(contactEmail(["0491570006", "jobs@example.com"])).toBe("jobs@example.com");
    expect(contactEmail(["0491570006"])).toBe("");
  });

  it("parses a JSON-LD block only when it is valid and small", () => {
    expect(parseJsonLd('{"@type":"JobPosting","title":"AI Engineer"}')).toEqual({ "@type": "JobPosting", title: "AI Engineer" });
    expect(parseJsonLd("{not json")).toBeUndefined();
    expect(parseJsonLd(`{"x":"${"a".repeat(70_000)}"}`)).toBeUndefined();
    expect(parseJsonLd(42)).toBeUndefined();
  });
});
