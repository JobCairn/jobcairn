import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultOptions } from "@careeros/contract";
import { actionHandlers as C } from "../src/actions.js";
import { composerHandlers as K } from "../src/composer.js";
import { dispatch } from "../src/dispatch.js";
import { openSample } from "./helpers.js";

const LABS = { kind: "job", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" } as const;
const ACME = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
const sidecar = (root: string, key: string) => path.join(root, ".careeros", "requests", `${key}.json`);

describe("request composer (services)", () => {
  it("offers defaults, the job's title and company, and skill chips from the profile", () => {
    const { ctx } = openSample();
    const v = K["claude.compose"](ctx, "tailor_application", LABS);
    expect(v.saved).toBe(false);
    expect(v.options).toEqual(defaultOptions("tailor_application"));
    expect(v.info).toMatchObject({ title: "Backend Engineer (LLM)", company: "Example Labs", n: 1 });
    expect(v.suggestions).toEqual(expect.arrayContaining(["agents", "RAG", "TypeScript"]));
    expect(K["claude.compose"](ctx, "score_job", LABS).suggestions).toEqual([]);
  });

  it("remembers options per action and job, and drops chips it didn't offer", async () => {
    const { ctx, root } = openSample();
    const saved = await dispatch(ctx, "claude.saveOptions", ["tailor_application", LABS, { tone: "warm", emphasis: ["RAG", "Cobol"] }]) as { options: Record<string, unknown>; saved: boolean };
    expect(saved.saved).toBe(true);
    expect(saved.options).toMatchObject({ tone: "warm", emphasis: ["RAG"] });
    expect(fs.existsSync(sidecar(root, "tailor_application--example-labs--2026-01-12-backend-engineer-llm"))).toBe(true);
    expect(K["claude.compose"](ctx, "tailor_application", LABS).options.tone).toBe("warm");
    // Another job, or another action on the same job, keeps its own defaults.
    expect(K["claude.compose"](ctx, "tailor_application", ACME).options.tone).toBe("professional");
    expect(K["claude.compose"](ctx, "interview_prep", LABS).saved).toBe(false);
  });

  it("refuses options off the allowlist with a plain message", async () => {
    const { ctx } = openSample();
    await expect(dispatch(ctx, "claude.saveOptions", ["tailor_application", LABS, { tone: "sarcastic" }])).rejects.toThrow(/Tone must be one of/);
    await expect(dispatch(ctx, "claude.saveOptions", ["tailor_application", LABS, { outputs: ["x"] }])).rejects.toThrow(/isn't an option/);
  });

  it("a one-click request uses the saved options, never a note, and keeps the file list", async () => {
    const { ctx } = openSample({ claude: true });
    const plain = await C["claude.prepare"](ctx, "tailor_application", LABS, false);
    expect(plain.prompt).not.toContain("How I want it:");
    K["claude.saveOptions"](ctx, "tailor_application", LABS, { resume_length: "1" });
    const r = await C["claude.prepare"](ctx, "tailor_application", LABS, false);
    expect(r.prompt).toContain("- Keep the resume to one page.");
    expect(r.prompt).not.toContain("NOTE-");
    expect(r.prompt.split("\n\n").at(-1)!.startsWith("Rules:")).toBe(true);
    expect(r.prompt).toContain("application/cover-letter.md");
  });

  it("ignores a broken or linked sidecar", () => {
    const { ctx, root } = openSample();
    const key = "research_company--example-labs";
    fs.mkdirSync(path.dirname(sidecar(root, key)), { recursive: true });
    fs.writeFileSync(sidecar(root, key), "{not json");
    expect(K["claude.compose"](ctx, "research_company", LABS).saved).toBe(false);
    fs.rmSync(sidecar(root, key));
    const elsewhere = path.join(root, "elsewhere.json");
    fs.writeFileSync(elsewhere, JSON.stringify({ options: { depth: "thorough" } }));
    fs.symlinkSync(elsewhere, sidecar(root, key));
    expect(K["claude.compose"](ctx, "research_company", LABS).saved).toBe(false);
    fs.rmSync(sidecar(root, key));
    fs.writeFileSync(sidecar(root, key), JSON.stringify({ options: { depth: "thorough", focus: ["salaries"], extra: 1 } }));
    expect(K["claude.compose"](ctx, "research_company", LABS).options).toEqual({ depth: "thorough", focus: ["sponsorship", "tech_stack", "contacts"] });
  });
});

describe("cover letter turned off", () => {
  it("hides the placeholder cover letter from review and export, but shows a real one", async () => {
    const { applyHandlers: A } = await import("../src/apply.js");
    const { docsHandlers: D } = await import("../src/docs.js");
    const { ctx, root } = openSample();
    const app = path.join(root, "companies", "example-labs", "jobs", "2026-01-12-backend-engineer-llm", "application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "# Alex Example\n\nFictional resume.\n");
    fs.writeFileSync(path.join(app, "cover-letter.md"), "No cover letter requested.\n");
    const labels = () => A["apply.state"](ctx, LABS.company_slug, LABS.id).files.map((f) => f.label);
    const exportable = () => D["docs.state"](ctx, LABS.company_slug, LABS.id).sources.find((s) => s.source === "cover-letter")!.exists;
    expect(labels()).toContain("resume.md");
    expect(labels()).not.toContain("cover-letter.md");
    expect(exportable()).toBe(false);
    fs.writeFileSync(path.join(app, "cover-letter.md"), "Dear hiring team,\n\nNo cover letter requested by the ad, but here is one (fictional).\n");
    expect(labels()).toContain("cover-letter.md");
    expect(exportable()).toBe(true);
  });
  it("follows the profile's work-rights status in options, defaults and prompts", async () => {
    const { ctx } = openSample();
    const COMPANY = { kind: "company", company_slug: "example-labs" } as const;
    const WS = { kind: "workspace" } as const;
    // The sample candidate needs sponsorship.
    expect(K["claude.compose"](ctx, "research_company", COMPANY).options.focus).toEqual(["sponsorship", "tech_stack", "contacts"]);
    expect(K["claude.compose"](ctx, "research_company", COMPANY).info.work_rights).toBe("needs_sponsorship");
    // Sponsor-only is a saved search setting (Settings › Search, Find jobs' chips): the composer's old copy doesn't count.
    await dispatch(ctx, "claude.saveOptions", ["find_jobs", WS, { sponsor_only: true }]);
    expect((await C["claude.prepare"](ctx, "find_jobs", WS, false)).prompt).not.toContain("- Keep only ads that say they offer visa sponsorship.");
    await dispatch(ctx, "settings.save", ["search", [{ path: "filters.sponsor_only", value: true }]]);
    expect((await C["claude.prepare"](ctx, "find_jobs", WS, false)).prompt).toContain("- Keep only ads that say they offer visa sponsorship.");

    await dispatch(ctx, "settings.save", ["profile", [{ path: "work_rights.status", value: "citizen" }]]);
    const v = K["claude.compose"](ctx, "research_company", COMPANY);
    expect(v.info.work_rights).toBe("citizen");
    expect(v.options.focus).toEqual(["tech_stack", "contacts"]);
    // A sponsorship choice saved earlier is dropped, not sent.
    expect(K["claude.compose"](ctx, "find_jobs", WS).options).not.toHaveProperty("sponsor_only");
    const p = (await C["claude.prepare"](ctx, "find_jobs", WS, false)).prompt;
    expect(p).not.toMatch(/sponsorship/i);
    expect(p).toContain("don't filter ads on work-rights wording");
    expect((await C["claude.prepare"](ctx, "research_company", COMPANY, false)).prompt).not.toMatch(/sponsorship/i);
    await expect(dispatch(ctx, "claude.saveOptions", ["find_jobs", WS, { sponsor_only: true }])).rejects.toThrow(/isn't an option/);
  });
});
