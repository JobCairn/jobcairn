import { describe, expect, it } from "vitest";
import { JOB_BOARDS } from "@careeros/contract";
import { BOARDS, BOARD_FALLBACK_REASONS, BOARD_MARK_SRC, boardByHost, boardBySite, boardByUrl, hostMatches, resolveBoard } from "../src/source/boards";

describe("hostMatches", () => {
  it("matches the bare domain and its subdomains, case-insensitively", () => {
    expect(hostMatches("linkedin.com", "linkedin.com")).toBe(true);
    expect(hostMatches("www.linkedin.com", "linkedin.com")).toBe(true);
    expect(hostMatches("au.linkedin.com", "linkedin.com")).toBe(true);
    expect(hostMatches("LinkedIn.COM", "linkedin.com")).toBe(true);
    expect(hostMatches("WWW.LinkedIn.com", "linkedin.com")).toBe(true);
    // Multi-level subdomains (e.g. a job-boards host) still match.
    expect(hostMatches("job-boards.eu.greenhouse.io", "greenhouse.io")).toBe(true);
  });
  it("never matches a spoofed host that merely starts with or contains the domain", () => {
    expect(hostMatches("linkedin.com.evil.example", "linkedin.com")).toBe(false);
    expect(hostMatches("notlinkedin.com", "linkedin.com")).toBe(false);
    expect(hostMatches("linkedin.com-evil.example", "linkedin.com")).toBe(false);
    expect(hostMatches("evillinkedin.com", "linkedin.com")).toBe(false);
  });
  it("is false for an empty host or domain", () => {
    expect(hostMatches("", "linkedin.com")).toBe(false);
    expect(hostMatches("linkedin.com", "")).toBe(false);
  });
});

describe("boardByHost / boardByUrl", () => {
  it("finds the board for a known domain and its subdomains", () => {
    expect(boardByHost("www.linkedin.com")?.id).toBe("linkedin");
    expect(boardByHost("au.seek.com.au")?.id).toBe("seek");
    expect(boardByUrl("https://boards.greenhouse.io/acme/jobs/123")?.id).toBe("greenhouse");
    expect(boardByUrl("https://jobs.lever.co/acme/123")?.id).toBe("lever");
  });
  it("never matches a spoofed host through the URL form either", () => {
    expect(boardByUrl("https://linkedin.com.evil.example/jobs/view/1")).toBeUndefined();
  });
  it("returns undefined for an unknown host or an unparseable URL", () => {
    expect(boardByHost("example.com")).toBeUndefined();
    expect(boardByUrl("not a url")).toBeUndefined();
    expect(boardByUrl("")).toBeUndefined();
  });
});

describe("boardBySite", () => {
  it("matches a known site name, trimmed and case-insensitively", () => {
    expect(boardBySite("LinkedIn")?.id).toBe("linkedin");
    expect(boardBySite("  seek  ")?.id).toBe("seek");
    expect(boardBySite("GREENHOUSE")?.id).toBe("greenhouse");
  });
  it("returns undefined for free text that names no known board", () => {
    expect(boardBySite("Pasted link")).toBeUndefined();
    expect(boardBySite("")).toBeUndefined();
    expect(boardBySite("   ")).toBeUndefined();
  });
});

describe("resolveBoard", () => {
  it("prefers source_site over the URL host (an aggregator re-hosts someone else's ad)", () => {
    const b = resolveBoard({ source: "adzuna", source_site: "Indeed", url: "https://www.adzuna.com.au/land/ad/123" });
    expect(b.id).toBe("indeed");
  });
  it("falls back to the URL host when source_site names no known board", () => {
    const b = resolveBoard({ source: "ats", source_site: "", url: "https://boards.greenhouse.io/acme/jobs/1" });
    expect(b.id).toBe("greenhouse");
  });
  it("falls back to 'Pasted by you' for a pasted job with no recognisable site or host", () => {
    const b = resolveBoard({ source: "pasted", source_site: "Pasted link", url: "https://jobs.example.com/rec/3" });
    expect(b.id).toBe("pasted");
  });
  it("falls back to 'Company website' for anything else unrecognised", () => {
    expect(resolveBoard({ source: "browser", source_site: "", url: "https://careers.acme-example.com/role/1" }).id).toBe("company-website");
    expect(resolveBoard({ source: "ats", source_site: "", url: "" }).id).toBe("company-website");
    expect(resolveBoard({}).id).toBe("company-website");
  });
  it("still names a known board from source_site even when url is missing or unsafe", () => {
    expect(resolveBoard({ source: "browser", source_site: "SEEK" }).id).toBe("seek");
  });
});

describe("BOARDS", () => {
  it("covers every board the registry is meant to, each with a unique id and non-empty name", () => {
    const ids = BOARDS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const want of [
      "linkedin", "seek", "indeed", "glassdoor", "jora", "adzuna", "greenhouse", "lever",
      "workable", "ashby", "smartrecruiters", "workday", "wellfound", "company-website", "pasted",
    ]) expect(ids).toContain(want);
    for (const b of BOARDS) expect(b.name.length).toBeGreaterThan(0);
  });
  it("gives a real, bundled official mark only to the boards one was obtained for", () => {
    const markIds = BOARDS.filter((b) => b.icon.kind === "image").map((b) => b.id).sort();
    expect(markIds).toEqual([
      "adzuna", "ashby", "glassdoor", "greenhouse", "indeed", "jora", "lever", "linkedin",
      "seek", "smartrecruiters", "workable", "workforce",
    ]);
  });
  it("every mark is a non-empty bundled asset URL with a decorative alt", () => {
    for (const b of BOARDS.filter((x) => x.icon.kind === "image")) {
      expect(b.icon.kind === "image" && b.icon.src.length).toBeGreaterThan(0);
      expect(b.icon.kind === "image" && b.icon.alt).toBe(`${b.name} logo`);
    }
  });
  it("gives every other board a monogram, never a blank or missing icon", () => {
    for (const b of BOARDS.filter((x) => x.icon.kind === "monogram")) {
      expect(b.icon.kind === "monogram" && b.icon.letters.length).toBeGreaterThan(0);
      expect(b.icon.kind === "monogram" && b.icon.letters.length).toBeLessThanOrEqual(2);
    }
  });
  it("accounts for every shared board with either a bundled mark or a documented fallback reason, never both or neither", () => {
    for (const b of JOB_BOARDS) {
      const hasMark = b.id in BOARD_MARK_SRC;
      const hasReason = b.id in BOARD_FALLBACK_REASONS;
      expect(hasMark || hasReason, `${b.id} has neither a mark nor a fallback reason`).toBe(true);
      expect(hasMark && hasReason, `${b.id} has both a mark and a fallback reason`).toBe(false);
      if (hasReason) expect(BOARD_FALLBACK_REASONS[b.id]!.length).toBeGreaterThan(10);
    }
  });
});
