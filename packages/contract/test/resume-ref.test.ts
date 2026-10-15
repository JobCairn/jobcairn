import { describe, expect, it } from "vitest";
import { sameRef, validateArgs, VARIANT_NAME, type ResumeRef } from "../src/index.js";

const JOB: ResumeRef = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const VAR: ResumeRef = { kind: "variant", variant: "backend-heavy" };
const load = (ref: unknown) => () => validateArgs("resume.load", [ref, "resume.md"]);

describe("resume refs: a job's tailored resume or a general version", () => {
  it("accepts a job ref and a version ref", () => {
    expect(load(JOB)).not.toThrow();
    expect(load(VAR)).not.toThrow();
  });
  it("refuses unknown kinds, path tricks, extra keys and mixed shapes", () => {
    expect(load({ kind: "base" })).toThrow();
    expect(load({ kind: "variant", variant: "../me" })).toThrow();
    expect(load({ kind: "variant", variant: "Backend" })).toThrow();
    expect(load({ kind: "variant", variant: "a".repeat(61) })).toThrow();
    expect(load({ kind: "variant", variant: "x", company_slug: "acme-corp" })).toThrow();
    expect(load({ kind: "job", variant: "x" })).toThrow();
    expect(load("acme-corp")).toThrow();
  });
  it("compares refs by value", () => {
    expect(sameRef(VAR, { kind: "variant", variant: "backend-heavy" })).toBe(true);
    expect(sameRef(VAR, JOB)).toBe(false);
    expect(sameRef(JOB, { ...JOB, id: "2026-01-13-ai-engineer" })).toBe(false);
  });
  it("new version names are plain text", () => {
    expect(() => validateArgs("resumes.newVariant", ["For consulting firms"])).not.toThrow();
    expect(() => validateArgs("resumes.newVariant", ["<script>"])).toThrow();
    expect(VARIANT_NAME.test("Line\nbreak")).toBe(false);
  });
});
