import { describe, expect, it } from "vitest";
import { oneLine, scrubMessage } from "../../src/claude/scrub.js";

const ROOT = "/Users/alex/CareerOS";

describe("scrubMessage (review probes)", () => {
  it("strips ANSI colour codes, and the path inside them", () => {
    const s = scrubMessage("\x1b[31mError\x1b[0m reading \x1b[1m/private/var/folders/xy/secret.txt\x1b[22m", ROOT);
    expect(s).toBe("Error reading a file");
    expect(s).not.toMatch(/\x1b|\[31m|\[0m/);
  });

  it("hides an absolute path in a percent-encoded or hashbang fragment", () => {
    expect(scrubMessage("see https://acme.example/app#%2Fopt%2Fsecret%2Fy", ROOT)).toBe("see https://acme.example/app#a file");
    expect(scrubMessage("see https://acme.example/app#!/opt/secret", ROOT)).toBe("see https://acme.example/app#a file");
    expect(scrubMessage("see https://acme.example/app#section", ROOT)).toBe("see https://acme.example/app#section");
    expect(scrubMessage("see https://acme.example/x?p=%2Fopt%2Fsecret", ROOT)).not.toContain("secret");
  });

  it("redacts token shapes", () => {
    const s = scrubMessage(
      "key sk-ant-api03-AbCdEf0123456789xyz and ghp_0123456789abcdefghijABCDEFGHIJ and github_pat_11ABCDEFG0123456789_abcdefghijkl and xoxb-1234567890-abcdefghij",
      ROOT,
    );
    expect(s).not.toMatch(/sk-ant-api03|ghp_0123|github_pat_11|xoxb-1234/);
    expect(s.match(/\[hidden key\]/g)).toHaveLength(4);
  });

  it("keeps workspace paths relative", () => {
    expect(scrubMessage(`Wrote ${ROOT}/companies/acme/research.md`, ROOT)).toBe("Wrote companies/acme/research.md");
  });

  it("oneLine also drops OSC sequences", () => {
    expect(oneLine("a\x1b]8;;https://evil.example\x07link\x1b]8;;\x07 b")).toBe("alink b");
  });
});
