import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lengthKey, loadRegistry, resolveOutputFolder, validateVideoType } from "../src/registry.js";
import { BUILTIN_TYPES, sampleCopy } from "./helpers.js";

const IDS = ["application-summary", "company-briefing", "interview-prep", "jd-walkthrough", "pitch", "skill-gap-lesson", "weekly-recap"];
const custom = (root: string, name: string, body: unknown) => {
  fs.mkdirSync(path.join(root, "settings/video-types"), { recursive: true });
  fs.writeFileSync(path.join(root, "settings/video-types", name), typeof body === "string" ? body : JSON.stringify(body));
};
const base = () => JSON.parse(fs.readFileSync(path.join(BUILTIN_TYPES, "jd-walkthrough.json"), "utf8")) as Record<string, unknown>;

describe("built-in types", () => {
  it("all seven validate and load", () => {
    const r = loadRegistry({ builtinDir: BUILTIN_TYPES });
    expect(r.errors).toEqual([]);
    expect(r.types.map((t) => t.id).sort()).toEqual(IDS);
    expect(r.types.every((t) => t.origin === "builtin")).toBe(true);
    expect(r.types.filter((t) => t.media !== "none").map((t) => `${t.id}:${t.media}`).sort()).toEqual(["company-briefing:offline", "jd-walkthrough:offline"]);
  });
  it("lists the types for each screen", () => {
    const r = loadRegistry({ builtinDir: BUILTIN_TYPES });
    expect(r.forEntry("job").map((t) => t.id).sort()).toEqual(["company-briefing", "interview-prep", "jd-walkthrough", "pitch"]);
    expect(r.forEntry("home").map((t) => t.id)).toEqual(["weekly-recap"]);
    expect(r.forEntry("apply.review").map((t) => t.id)).toEqual(["application-summary"]);
    expect(r.forEntry("all")).toHaveLength(7);
  });
});

describe("workspace types", () => {
  it("loads a good custom type and reports bad ones without loading them", () => {
    const root = sampleCopy();
    custom(root, "jd-short.json", { ...base(), id: "jd-short", label: "Short JD walkthrough", length: { min_s: 30, target_s: 40, max_s: 50 } });
    custom(root, "broken.json", "{ nope");
    custom(root, "jd-walkthrough.json", base());
    custom(root, "template.json", { ...base(), id: "template", writer: "template" });
    custom(root, "slides-quiz.json", { ...base(), id: "slides-quiz", scene_types: ["title", "quiz"] });
    custom(root, "escape.json", { ...base(), id: "escape", sources: [{ resolver: "history", required: true, glob: "../identity/*" }] });
    custom(root, "outside.json", { ...base(), id: "outside", output: "me/identity/{n}/" });
    custom(root, "order.json", { ...base(), id: "order", length: { min_s: 90, target_s: 60, max_s: 120 } });
    custom(root, "brief.json", { ...base(), id: "brief", brief_template: "Hi {visa_expiry}" });
    custom(root, "named-wrong.json", { ...base(), id: "something-else" });
    const r = loadRegistry({ builtinDir: BUILTIN_TYPES, workspaceRoot: root });
    expect(r.byId("jd-short")).toMatchObject({ origin: "workspace", file: "settings/video-types/jd-short.json" });
    const errs = Object.fromEntries(r.errors.map((e) => [e.file.split("/").pop(), e.problems.join(" | ")]));
    expect(Object.keys(errs).sort()).toEqual(["brief.json", "broken.json", "escape.json", "jd-walkthrough.json", "named-wrong.json", "order.json", "outside.json", "slides-quiz.json", "template.json"]);
    expect(errs["broken.json"]).toMatch(/invalid JSON/);
    expect(errs["jd-walkthrough.json"]).toMatch(/built-in type/);
    expect(errs["template.json"]).toMatch(/template writer/);
    expect(errs["slides-quiz.json"]).toMatch(/no quiz scenes/);
    expect(errs["order.json"]).toMatch(/in order/);
    expect(errs["brief.json"]).toMatch(/\{visa_expiry\}/);
    expect(errs["named-wrong.json"]).toMatch(/file name/);
    expect(r.types).toHaveLength(8);
  });
  it("skips a types folder that is a link", () => {
    const root = sampleCopy();
    const elsewhere = sampleCopy();
    custom(elsewhere, "jd-short.json", { ...base(), id: "jd-short" });
    fs.mkdirSync(path.join(root, "settings"), { recursive: true });
    fs.symlinkSync(path.join(elsewhere, "settings/video-types"), path.join(root, "settings/video-types"), "dir");
    const r = loadRegistry({ builtinDir: BUILTIN_TYPES, workspaceRoot: root });
    expect(r.byId("jd-short")).toBeUndefined();
    expect(r.errors[0]?.problems).toEqual(["is not a plain folder"]);
  });
  it("checks a type's structure without the file system", () => {
    expect(validateVideoType({ ...base(), output: "recaps/{n}/" }).problems.join()).toMatch(/recaps\/\{week\}\//);
    expect(validateVideoType({ ...base(), scene_counts: { quiz: { min: 1, max: 2 } } }).problems.join()).toMatch(/not in scene_types/);
    expect(validateVideoType(base()).value?.id).toBe("jd-walkthrough");
  });
});

const weeklyBase = () => JSON.parse(fs.readFileSync(path.join(BUILTIN_TYPES, "weekly-recap.json"), "utf8")) as Record<string, unknown>;

describe("recaps/ output requires a template writer (Ruling F5 / U2)", () => {
  it("refuses a workspace type with subject week, writer claude and output recaps/{week}/", () => {
    const r = validateVideoType({ ...weeklyBase(), id: "claude-recap", writer: "claude" });
    expect(r.value).toBeNull();
    expect(r.problems.join()).toMatch(/template writer/);
  });
  it("still accepts the built-in weekly-recap, which is template-only", () => {
    const r = validateVideoType(weeklyBase(), "builtin");
    expect(r.problems).toEqual([]);
    expect(r.value?.id).toBe("weekly-recap");
    expect(r.value?.writer).toBe("template");
  });
});

describe("video type JSON is validated strictly (hostile files)", () => {
  it("rejects an unknown top-level key", () => {
    const r = validateVideoType({ ...base(), evil_extra_field: "whatever" });
    expect(r.value).toBeNull();
    expect(r.problems.length).toBeGreaterThan(0);
  });
  it("rejects a label far longer than the schema allows", () => {
    const r = validateVideoType({ ...base(), label: "x".repeat(500) });
    expect(r.value).toBeNull();
  });
  it("rejects an id far longer than the schema allows", () => {
    const r = validateVideoType({ ...base(), id: "a-".repeat(100) });
    expect(r.value).toBeNull();
  });
  it("rejects an output path that escapes the allowed roots with ..", () => {
    const r = validateVideoType({ ...base(), output: "companies/{slug}/../../me/{n}/" });
    expect(r.value).toBeNull();
  });
  it("rejects an absolute output path", () => {
    const r = validateVideoType({ ...base(), output: "/etc/passwd/{n}/" });
    expect(r.value).toBeNull();
  });
  it("rejects an output path under me/", () => {
    const r = validateVideoType({ ...base(), output: "me/identity/{n}/" });
    expect(r.value).toBeNull();
  });
  it("a hostile workspace file on disk is reported as an error and never loaded", () => {
    const root = sampleCopy();
    custom(root, "hostile.json", { ...base(), id: "hostile", output: "../../etc/passwd/{n}/", sneaky: "evil" });
    const r = loadRegistry({ builtinDir: BUILTIN_TYPES, workspaceRoot: root });
    expect(r.byId("hostile")).toBeUndefined();
    const err = r.errors.find((e) => e.file.endsWith("hostile.json"));
    expect(err).toBeDefined();
    expect(err!.origin).toBe("workspace");
  });
});

describe("output folders", () => {
  const r = loadRegistry({ builtinDir: BUILTIN_TYPES });
  const job = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
  it("fills the template and numbers new folders", () => {
    const root = sampleCopy();
    const t = r.byId("jd-walkthrough")!;
    const first = resolveOutputFolder(t, job, root);
    expect(first).toBe("companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1");
    fs.mkdirSync(path.join(root, first), { recursive: true });
    expect(resolveOutputFolder(t, job, root)).toBe("companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-2");
    expect(resolveOutputFolder(r.byId("skill-gap-lesson")!, { kind: "topic", topic: "Kubernetes (basics)" }, root)).toBe("learning/kubernetes-basics/videos/1");
    expect(resolveOutputFolder(r.byId("weekly-recap")!, { kind: "week", week: "2026-W03" }, root)).toBe("recaps/2026-W03");
    expect(resolveOutputFolder(r.byId("application-summary")!, job, root)).toBe("companies/acme-corp/jobs/2026-01-12-ai-engineer/application/summary-video");
    expect(resolveOutputFolder(r.byId("company-briefing")!, { kind: "company", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" }, root)).toBe("companies/acme-corp/videos/briefing-1");
  });
  it("refuses a subject of the wrong kind", () => {
    expect(() => resolveOutputFolder(r.byId("pitch")!, { kind: "week", week: "2026-W03" }, sampleCopy())).toThrow(/about a job, not a week/);
  });
  it("maps type ids to settings keys", () => {
    expect(lengthKey("skill-gap-lesson")).toBe("skill_gap_lesson");
  });
});
