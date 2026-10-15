import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { assertSegment, insideRoot, isCaseInsensitiveFs, layout, slugify, splitClient } from "../src/paths.js";
import { tmpDir } from "./helpers.js";

describe("slugify", () => {
  it("lowercases, strips accents, turns & into and", () => {
    expect(slugify("Café & Co")).toBe("cafe-and-co");
  });
  it("collapses punctuation and trims hyphens", () => {
    expect(slugify("  AI Engineer -- (Senior)!! ")).toBe("ai-engineer-senior");
  });
  it("falls back when nothing usable is left", () => {
    expect(slugify("🚀🚀", "company")).toBe("company");
    expect(slugify("", "job")).toBe("job");
  });
  it("caps length at 60 without a trailing hyphen", () => {
    const s = slugify("word ".repeat(40));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
  });
  it("is stable", () => {
    expect(slugify("Example Labs")).toBe(slugify("example   labs"));
  });
});

describe("splitClient", () => {
  it("splits a recruiter name with a client in brackets", () => {
    expect(splitClient("Acme Recruiting (client Example University)")).toEqual({
      company: "Acme Recruiting", client: "Example University",
    });
    expect(splitClient("Acme Recruiting (client: Example University)").client).toBe("Example University");
  });
  it("keeps plain names", () => {
    expect(splitClient("Acme Corp")).toEqual({ company: "Acme Corp", client: null });
  });
  it("does not split when the name is only brackets", () => {
    expect(splitClient("(client X)")).toEqual({ company: "(client X)", client: null });
  });
});

describe("layout and guards", () => {
  it("builds job paths under companies/<slug>/jobs/<id>", () => {
    const L = layout("/w");
    expect(L.jobFile("acme-corp", "2026-01-15-ai-engineer")).toBe(
      path.join("/w", "companies", "acme-corp", "jobs", "2026-01-15-ai-engineer", "job.json"));
    expect(L.me("resumes")).toBe(path.join("/w", "me", "resumes"));
  });
  it("detects paths outside the root", () => {
    expect(insideRoot("/w", "/w/a/b")).toBe(true);
    expect(insideRoot("/w", "/w")).toBe(true);
    expect(insideRoot("/w", "/w/../etc")).toBe(false);
    expect(insideRoot("/w", "/wx/a")).toBe(false);
  });
  it("rejects unsafe path segments", () => {
    for (const bad of ["../x", "a/b", "a\\b", "..", ""]) {
      expect(() => assertSegment(bad, "id")).toThrow(/unsafe id/);
    }
    expect(() => assertSegment("2026-01-15-ai-engineer", "id")).not.toThrow();
  });
  it("rejects NUL bytes in a segment", () => {
    expect(() => assertSegment("a\0b", "id")).toThrow(/unsafe/);
  });
  it("rejects control characters in a segment", () => {
    for (const bad of ["a\nb", "a\rb", "a\tb", "a\x7fb"]) {
      expect(() => assertSegment(bad, "id")).toThrow(/unsafe/);
    }
  });
  it("is false for a path under a dir symlinked outside root, true for a normal nested non-existent path", () => {
    const root = path.join(tmpDir(), "ws");
    fs.mkdirSync(path.join(root, "companies"), { recursive: true });
    const outside = tmpDir("careeros-outside-");
    fs.symlinkSync(outside, path.join(root, "companies", "evil"));

    expect(insideRoot(root, path.join(root, "companies", "evil", "secret.txt"))).toBe(false);
    expect(insideRoot(root, path.join(root, "companies", "acme-corp", "jobs", "2026-01-15-ai-engineer"))).toBe(true);
  });
});

describe("isCaseInsensitiveFs (fix round 3)", () => {
  it("is true for a real directory on this machine's temp filesystem", () => {
    // The sandbox this test runs in is macOS (case-insensitive by default), which is
    // exactly the platform the "locked" and scope checks need this detection for.
    if (process.platform === "win32" || process.platform === "linux") return;
    expect(isCaseInsensitiveFs(tmpDir())).toBe(true);
  });
  it("is false (the safe default) for a path that can't be tested because it has no letters to swap", () => {
    expect(isCaseInsensitiveFs("/123/456")).toBe(false);
  });
  it("is false (the safe default) when the case-swapped path can't be found, simulating a case-sensitive volume", () => {
    const root = path.join(tmpDir(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const realStatSync = fs.statSync;
    const spy = vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, opts?: unknown) => {
      // Only the exact, as-given root resolves; its case-swapped sibling (which a
      // real case-insensitive filesystem would otherwise quietly alias to this same
      // file) is made to behave as if it genuinely doesn't exist.
      if (p !== root) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return realStatSync(p as string, opts as fs.StatOptions);
    }) as typeof fs.statSync);
    try {
      expect(isCaseInsensitiveFs(root)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
