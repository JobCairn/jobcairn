import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { appendSearch, ranRecently, readSearches } from "../src/knowledge.js";
import { layout } from "../src/paths.js";
import { FIXED, tmpDir } from "./helpers.js";

function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }

describe("search log", () => {
  it("appends entries with time and reads them back", () => {
    const root = ws();
    appendSearch(root, { site: "Greenhouse", query: "ai engineer", location: "Sampletown", results: 12, kept: 2 }, { now: FIXED });
    const { entries, badLines } = readSearches(root);
    expect(badLines).toEqual([]);
    expect(entries[0]).toEqual({ at: "2026-01-15T09:30:00.000Z", site: "Greenhouse", query: "ai engineer", location: "Sampletown", results: "12", kept: "2", notes: "" });
  });
  it("detects a repeat within 7 days, ignoring case and punctuation", () => {
    const root = ws();
    appendSearch(root, { site: "Greenhouse", query: '"AI Engineer"', location: "Sampletown" }, { now: FIXED });
    const later = { now: new Date("2026-01-20T00:00:00Z") };
    expect(ranRecently(root, "greenhouse", "ai engineer", "sampletown", 7, later)).not.toBeNull();
    const muchLater = { now: new Date("2026-02-01T00:00:00Z") };
    expect(ranRecently(root, "greenhouse", "ai engineer", "sampletown", 7, muchLater)).toBeNull();
  });
  it("reports bad lines instead of throwing", () => {
    const root = ws();
    fs.appendFileSync(layout(root).searchLog, "not json\n");
    appendSearch(root, { site: "x", query: "y", location: "z" }, { now: FIXED });
    const r = readSearches(root);
    expect(r.badLines).toEqual([1]);
    expect(r.entries).toHaveLength(1);
  });
  it("refuses to append through a symlinked search log pointing outside the workspace (I1)", () => {
    const root = ws();
    const outside = tmpDir("careeros-outside-");
    const outsideFile = path.join(outside, "search-log.jsonl");
    fs.writeFileSync(outsideFile, "EXISTING\n");
    fs.rmSync(layout(root).searchLog, { force: true });
    fs.symlinkSync(outsideFile, layout(root).searchLog);

    expect(() => appendSearch(root, { site: "x", query: "y", location: "z" }, { now: FIXED })).toThrow();
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("EXISTING\n");
  });
});
