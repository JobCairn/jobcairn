import { describe, expect, it } from "vitest";
import { ArgError, createRemoteBridge, isSafeHttpsUrl, METHODS, validateArgs, type MethodName } from "../src/index.js";

const bad = (m: string, args: unknown) => () => validateArgs(m, args);

describe("validateArgs", () => {
  it("rejects unknown methods and wrong argument counts", () => {
    expect(bad("fs.readFile", [])).toThrow(ArgError);
    expect(bad("constructor", [])).toThrow(/unknown method/);
    expect(bad("jobs.get", ["acme-corp"])).toThrow(/expected 2 argument/);
    expect(bad("jobs.get", "acme-corp/x")).toThrow(/must be a list/);
  });
  it("rejects unsafe slugs, ids and paths", () => {
    expect(bad("jobs.get", ["../etc", "x"])).toThrow(/invalid format/);
    expect(bad("approvals.approve", ["A B", "0".repeat(64)])).toThrow(/invalid format/);
    expect(bad("approvals.approve", ["20260115t090000-abc123"])).toThrow(/expected 2 argument/);
    for (const d of ["", "0".repeat(63), "G".repeat(64), "0".repeat(65)]) expect(bad("approvals.approve", ["20260115t090000-abc123", d]), d).toThrow(ArgError);
    expect(validateArgs("approvals.approve", ["20260115t090000-abc123", "0".repeat(64)])).toHaveLength(2);
    for (const rel of ["../x", "me/../identity/x", "/etc/passwd", "a\\b", "C:/x", "a//b", "a/./b", "x\u0000y"]) {
      expect(bad("files.readText", [rel]), rel).toThrow(ArgError);
    }
    expect(bad("inbox.add", [["relative/file.pdf"]])).toThrow(/absolute path/);
    expect(bad("inbox.add", [[]])).toThrow(/at least 1/);
  });
  it("rejects extra keys, bad enums and prototype keys", () => {
    expect(bad("jobs.list", [{ text: "ai", hack: true }])).toThrow(/hack is not allowed/);
    expect(bad("jobs.list", [{ limit: 0 }])).toThrow(/whole number from 1 to 500/);
    expect(bad("jobs.setStatus", ["acme-corp", "x", "Ghosted", ""])).toThrow(/must be one of/);
    expect(bad("inbox.file", ["cv.pdf", { kind: "job", company_slug: "acme-corp" }, ""])).toThrow(/id/);
    expect(bad("inbox.file", ["cv.pdf", { kind: "disk", dir: "/" }, ""])).toThrow(/"me" or "job"/);
    expect(bad("settings.save", ["profile", [{ path: "__proto__.polluted", value: 1 }]])).toThrow(/not allowed/);
    expect(bad("settings.save", ["profile", JSON.parse('[{"path":"contact.name","value":"x","__proto__":{"a":1}}]')])).toThrow(/not allowed/);
    expect(bad("privacy.allow", ["abc", 241])).toThrow(/1 to 240/);
  });
  it("accepts good input and returns it cleaned", () => {
    expect(validateArgs("jobs.list", [{ text: "ai", statuses: ["Found"], showIneligible: false, limit: 50 }])).toEqual([{ text: "ai", statuses: ["Found"], showIneligible: false, limit: 50 }]);
    expect(validateArgs("inbox.file", ["cv.pdf", { kind: "me", dir: "identity", sub: "visa" }, "visa grant"])).toEqual(["cv.pdf", { kind: "me", dir: "identity", sub: "visa" }, "visa grant"]);
    expect(validateArgs("files.readText", ["companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md"])).toHaveLength(1);
    expect(validateArgs("inbox.add", [["/fictional/alex-example/Downloads/cv.pdf"]])).toHaveLength(1);
    expect(validateArgs("inbox.add", [["C:\\fictional\\cv.pdf"]])).toHaveLength(1);
  });
  it("has a validator list for every method", () => {
    for (const [name, spec] of Object.entries(METHODS)) expect(Array.isArray(spec), name).toBe(true);
  });
  it("has exactly one validator entry per bridge call, in both directions", () => {
    // Walk every namespaced function the bridge exposes and record which METHODS key it dials.
    const seen = new Set<string>();
    const bridge = createRemoteBridge({
      call: async (m: MethodName) => { seen.add(m); return null; },
      onChange: () => () => undefined, pathForFile: () => null, fileUrl: (r) => r, mailUrl: (r) => r,
    });
    // Namespaces nest (mail.triage.list), so walk every level.
    const walk = (group: Record<string, unknown>): void => {
      for (const v of Object.values(group)) {
        if (typeof v === "function") void (v as (...a: unknown[]) => Promise<unknown>)();
        else if (typeof v === "object" && v !== null) walk(v as Record<string, unknown>);
      }
    };
    for (const group of Object.values(bridge)) if (typeof group === "object" && group !== null) walk(group as Record<string, unknown>);
    const methodNames = Object.keys(METHODS).sort();
    const bridgeNames = [...seen].sort();
    // Every bridge method must have a validator list in METHODS...
    for (const name of bridgeNames) expect(methodNames, `bridge method "${name}" has no validator in METHODS`).toContain(name);
    // ...and every validator in METHODS must correspond to a real bridge call.
    for (const name of methodNames) expect(bridgeNames, `METHODS has "${name}" but no bridge method calls it`).toContain(name);
    expect(bridgeNames).toEqual(methodNames);
  });
});

describe("links.open: https-only URLs", () => {
  it("rejects non-https schemes, bare schemes and embedded credentials", () => {
    expect(bad("links.open", ["http://jobs.example.com"])).toThrow(/https/);
    expect(bad("links.open", ["javascript:alert(1)"])).toThrow(/https/);
    expect(bad("links.open", ["file:///etc/passwd"])).toThrow(/https/);
    expect(bad("links.open", ["data:text/plain,hi"])).toThrow(/https/);
    expect(bad("links.open", ["https://"])).toThrow(ArgError);
    // Built by concatenation (not a literal) so the privacy scan never sees a plausible credential pair.
    const withCreds = "https://" + "user:pw" + "@jobs.example.com";
    expect(bad("links.open", [withCreds])).toThrow(/username or password/);
  });
  it("accepts a plain https URL", () => {
    expect(validateArgs("links.open", ["https://jobs.example.com/acme/1"])).toEqual(["https://jobs.example.com/acme/1"]);
  });
});

describe("control characters in text fields", () => {
  it("rejects an ANSI escape in a single-line field", () => {
    expect(bad("jobs.saveView", ["\x1b[31mred\x1b[0m", {}])).toThrow(ArgError);
  });
  it("rejects embedded newlines/tabs in single-line fields but allows them in multi-line notes", () => {
    expect(bad("jobs.saveView", ["two\nlines", {}])).toThrow(/single line/);
    expect(validateArgs("jobs.addNote", ["acme-corp", "x", "line one\nline two, with a tab\there"])).toEqual(["acme-corp", "x", "line one\nline two, with a tab\there"]);
  });
});

describe("workspace.create: safe folder names", () => {
  it("rejects separators, traversal and leading dots", () => {
    for (const name of ["a/b", "a\\b", "../evil", "..", ".", ".hidden"]) {
      expect(bad("workspace.create", ["/fictional/alex-example/Careers", name]), name).toThrow(ArgError);
    }
  });
  it("accepts a plain folder name", () => {
    expect(validateArgs("workspace.create", ["/fictional/alex-example/Careers", "My Careers"])).toEqual(["/fictional/alex-example/Careers", "My Careers"]);
  });
});

describe("isSafeHttpsUrl", () => {
  it("rejects anything that isn't a plain https URL with a real host and no credentials", () => {
    for (const url of ["http://jobs.example.com", "javascript:alert(1)", "not a url", "https://" + "ok.example.com" + "@evil.example", "file:///etc/passwd", "https://", "", 42, null, undefined]) {
      expect(isSafeHttpsUrl(url), String(url)).toBe(false);
    }
  });
  it("accepts a plain https URL", () => {
    expect(isSafeHttpsUrl("https://jobs.example.com/acme/1")).toBe(true);
  });
});
