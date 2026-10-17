import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildActionPrompt } from "@careeros/contract";
import { layout, updateRecord } from "@careeros/core";
import { companyHandlers as C } from "../src/companies.js";
import { promptInfo } from "../src/actions.js";
import { companyResearchAt } from "../src/research.js";
import { FIXED, openSample } from "./helpers.js";

const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;

describe("company research age", () => {
  it("dates research from its Researched line, else the file time, and says when it's stale", () => {
    const { ctx, root } = openSample();
    const file = path.join(layout(root).companyDir("acme-corp"), "research.md");
    fs.rmSync(file, { force: true });
    expect(companyResearchAt(root, "acme-corp")).toBe("");
    expect(C["companies.get"](ctx, "acme-corp").research).toBeNull();

    fs.writeFileSync(file, "# Acme Corp\n\nResearched: 2025-12-01\n\nWhat they do: example widgets.\n");
    expect(C["companies.get"](ctx, "acme-corp").research).toEqual({ at: "2025-12-01", days: 45, stale: true });

    fs.writeFileSync(file, "# Acme Corp\n\nWhat they do: example widgets.\n");
    const t = new Date(FIXED.getTime() - 3 * 86_400_000);
    fs.utimesSync(file, t, t);
    expect(C["companies.get"](ctx, "acme-corp").research).toMatchObject({ days: 3, stale: false });
  });

  it("puts the age and the languages in the score prompt", () => {
    const { ctx, root } = openSample();
    const file = path.join(layout(root).companyDir("acme-corp"), "research.md");
    fs.writeFileSync(file, "# Acme Corp\n\nResearched: 2025-11-01\n");
    updateRecord("profile", layout(root).profile, (p) => { p.languages = [{ language: "English", level: "native" }]; });
    const info = { ...promptInfo(root, JOB), now: ctx.now().toISOString() };
    expect(info).toMatchObject({ researched_at: "2025-11-01", languages: [{ language: "English", level: "native" }] });
    const p = buildActionPrompt("score_job", JOB, info);
    expect(p).toMatch(/research\.md is 75 days old, older than 30 days, so it is stale/);
    expect(p).toContain("My languages: English (Native or fluent).");
  });
});
