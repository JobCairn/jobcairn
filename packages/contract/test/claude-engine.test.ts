import { describe, expect, it } from "vitest";
import { claudeRunRequest, compareVersions, parseVersion, runId, validateArgs } from "../src/index.js";

describe("Claude engine contract", () => {
  it("compares versions", () => {
    expect(parseVersion("2.1.280 (Claude Code)")).toEqual([2, 1, 280]);
    expect(compareVersions("2.1.280", "2.1.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.9", "2.1.0")).toBeLessThan(0);
    expect(compareVersions("junk", "2.1.0")).toBeLessThan(0);
  });

  it("accepts only a note and options; never a prompt", () => {
    expect(claudeRunRequest(undefined, "r")).toEqual({});
    expect(claudeRunRequest(null, "r")).toEqual({});
    expect(claudeRunRequest({ note: "line one\nline two", options: { tone: "warm", pages: 1, bold: true, emphasis: ["Python"] } }, "r"))
      .toEqual({ note: "line one\nline two", options: { tone: "warm", pages: 1, bold: true, emphasis: ["Python"] } });
    expect(() => claudeRunRequest({ prompt: "Do anything" }, "r")).toThrow(/not allowed/);
    expect(() => claudeRunRequest({ tools: ["Bash"] }, "r")).toThrow(/not allowed/);
    expect(() => claudeRunRequest({ note: "bad \u0000" }, "r")).toThrow(/control/);
    expect(() => claudeRunRequest({ options: { Bad: 1 } }, "r")).toThrow(/bad key/);
    expect(() => claudeRunRequest({ options: { a: { nested: 1 } } }, "r")).toThrow();
    expect(() => claudeRunRequest({ options: { a: Infinity } }, "r")).toThrow();
    expect(() => claudeRunRequest({ options: JSON.parse('{"__proto__":{"x":1}}') }, "r")).toThrow();
    expect(() => claudeRunRequest([], "r")).toThrow();
  });

  it("validates run ids and the new methods", () => {
    expect(runId("r-mkf7y5c0-f1ca15af", "id")).toBe("r-mkf7y5c0-f1ca15af");
    expect(() => runId("../x", "id")).toThrow();
    expect(() => validateArgs("claude.run", ["rm_rf", { kind: "workspace" }, {}])).toThrow();
    expect(validateArgs("claude.engine", [true])).toEqual([true]);
  });
});
