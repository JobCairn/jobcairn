import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { samplePdf } from "../src/sample-pdf.js";
import { validateWorkspace } from "../src/validate.js";
import { buildIndex } from "../src/index-db.js";
import { tmpDir } from "./helpers.js";

const SAMPLE = path.resolve(import.meta.dirname, "../../../samples/alex-example");

describe("samples", () => {
  it("builds a valid PDF that says SAMPLE", () => {
    const text = new TextDecoder().decode(samplePdf(["Alex Example", "Resume"]));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("(SAMPLE) Tj");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });
  it("ships a valid, indexable fictional workspace", () => {
    expect(validateWorkspace(SAMPLE)).toEqual([]);
    const copy = path.join(tmpDir(), "alex");
    fs.cpSync(SAMPLE, copy, { recursive: true });
    expect(buildIndex(copy)).toMatchObject({ jobs: 3, companies: 3, skipped: [] });
  });
  it("uses only reserved fictional contact details", () => {
    const profile = JSON.parse(fs.readFileSync(path.join(SAMPLE, "settings", "profile.json"), "utf8"));
    expect(profile.contact).toMatchObject({ name: "Alex Example", email: "alex" + "@" + "example.com", phone: "0491 570 006" });
  });
});
