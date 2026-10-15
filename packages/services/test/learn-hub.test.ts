import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { actionHandlers as C } from "../src/actions.js";
import { dispatch } from "../src/dispatch.js";
import { guideHandlers as G } from "../src/guide.js";
import { learnHubHandlers as H, ownSkillsText } from "../src/learn-hub.js";
import { privacyHandlers as P } from "../src/privacy.js";
import { readHandlers as R } from "../src/read.js";
import type { JobStatus } from "@careeros/contract";
import { minutes, openSample } from "./helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const LABS = "companies/example-labs/jobs/2026-01-12-backend-engineer-llm";
const write = (root: string, rel: string, text: string) => {
  const p = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const skills = (ctx: Parameters<typeof H["learn.hub"]>[0]) => H["learn.hub"](ctx).suggestions.map((s) => `${s.skill} ${s.jobs}/${s.total}`);

describe("suggested topics from saved jobs", () => {
  it("counts skills across saved ads, minus the profile's keywords and the person's own documents", () => {
    const { ctx, root } = openSample();
    write(root, `${LABS}/jd.md`, "# Backend Engineer (LLM)\n\nKubernetes, Kafka and TypeScript.\n");
    write(root, "companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md", "# AI Engineer\n\nBuild LLM agents on Kubernetes.\n");
    // TypeScript is in the profile keywords; agents too. Kafka is on the resume.
    write(root, "me/resumes/alex-example.md", "# Alex Example\n\nBuilt Kafka consumers (fictional).\n");
    const s = skills(ctx);
    expect(s).toContain("Kubernetes 2/2"); // the citizens-only ad is not counted
    expect(s.some((x) => x.startsWith("TypeScript"))).toBe(false);
    expect(s.some((x) => x.startsWith("Kafka"))).toBe(false);
    expect(s.some((x) => x.startsWith("AI agents"))).toBe(false);
    expect(s[0]).toMatch(/ 2\/2$/);
  });

  it("never reads a locked folder: a skill only mentioned there is still a gap", () => {
    const { ctx, root } = openSample();
    write(root, `${LABS}/jd.md`, "# Backend\n\nKubernetes please.\n");
    write(root, "me/employment/contract.md", "Ran Kubernetes clusters (fictional).\n");
    write(root, "me/identity/notes.md", "Kubernetes (fictional).\n");
    expect(ownSkillsText(ctx, root).join("\n")).not.toContain("Kubernetes");
    expect(skills(ctx)).toContain("Kubernetes 1/2");
    // Unlocked by the person, the folder is theirs to count.
    P["privacy.setLocked"](ctx, "me/employment", false);
    expect(skills(ctx).some((x) => x.startsWith("Kubernetes"))).toBe(false);
  });

  it("doesn't follow a link out of me/ into a locked folder", () => {
    const { ctx, root } = openSample();
    write(root, `${LABS}/jd.md`, "# Backend\n\nKubernetes.\n");
    write(root, "me/identity/k8s.md", "Kubernetes.\n");
    fs.mkdirSync(path.join(root, "me", "resumes"), { recursive: true });
    fs.symlinkSync(path.join(root, "me", "identity", "k8s.md"), path.join(root, "me", "resumes", "k8s.md"));
    expect(skills(ctx)).toContain("Kubernetes 1/2");
  });

  it("counts N of M over active jobs only: not Skipped, Rejected or ineligible", () => {
    const { ctx, root } = openSample();
    const ACME = "companies/acme-corp/jobs/2026-01-12-ai-engineer";
    write(root, `${LABS}/jd.md`, "# Backend\n\nKubernetes.\n");
    write(root, `${ACME}/jd.md`, "# AI Engineer\n\nKubernetes.\n");
    // The sample's citizens-only ad mentions Kubernetes too, but it isn't counted.
    write(root, "companies/acme-recruiting/jobs/2026-01-12-ai-developer/jd.md", "# AI Developer\n\nKubernetes.\n");
    expect(skills(ctx)).toContain("Kubernetes 2/2");
    const setStatus = (rel: string, status: JobStatus) => {
      const [, slug, , id] = rel.split("/");
      R["jobs.setStatus"](ctx, slug!, id!, status, "");
    };
    setStatus(ACME, "Rejected");
    expect(skills(ctx)).toContain("Kubernetes 1/1");
    setStatus(LABS, "Skipped");
    expect(H["learn.hub"](ctx).suggestions.some((x) => x.skill === "Kubernetes")).toBe(false);
  });

  it("marks a suggestion started when a guide for it exists", () => {
    const { ctx, root } = openSample();
    write(root, `${LABS}/jd.md`, "# Backend\n\nKubernetes.\n");
    write(root, "learning/kubernetes/guide.md", "# Kubernetes\n");
    expect(H["learn.hub"](ctx).suggestions.find((s) => s.skill === "Kubernetes")?.started).toBe(true);
  });
});

describe("learning items and progress", () => {
  it("lists guides, videos and interview prep with type, source job and date", () => {
    const { ctx } = openSample();
    const h = H["learn.hub"](ctx);
    const rag = h.entries.find((e) => e.path === "learning/rag-pipelines/guide.md")!;
    expect(rag).toMatchObject({ type: "guide", topic: "rag-pipelines", source: null, progress: "not_started" });
    expect(Date.parse(rag.at)).not.toBeNaN();
    const prep = h.entries.find((e) => e.path.endsWith("interview/questions.md"))!;
    expect(prep).toMatchObject({ type: "interview", source: { company_slug: "acme-corp", title: "AI Engineer", company_name: "Acme Corp" } });
  });

  it("stores progress in a small sidecar and keeps the completion time", () => {
    const { ctx, root, setNow } = openSample();
    H["learn.setProgress"](ctx, "learning/rag-pipelines/guide.md", "in_progress");
    setNow(minutes(30));
    const h = H["learn.setProgress"](ctx, "learning/rag-pipelines/guide.md", "done");
    expect(h.entries.find((e) => e.path === "learning/rag-pipelines/guide.md")).toMatchObject({ progress: "done", progress_at: minutes(30).toISOString() });
    const file = JSON.parse(fs.readFileSync(path.join(root, ".careeros", "learn-progress.json"), "utf8"));
    expect(file["learning/rag-pipelines/guide.md"].state).toBe("done");
    H["learn.setProgress"](ctx, "learning/rag-pipelines/guide.md", "not_started");
    expect(JSON.parse(fs.readFileSync(path.join(root, ".careeros", "learn-progress.json"), "utf8"))).toEqual({});
  });

  it("refuses progress on anything Learn doesn't list", () => {
    const { ctx } = openSample();
    expect(() => H["learn.setProgress"](ctx, "me/identity/passport.md", "done")).toThrow("That item isn't in Learn any more.");
  });

  it("ignores a damaged progress file", () => {
    const { ctx, root } = openSample();
    write(root, ".careeros/learn-progress.json", "{ not json");
    expect(H["learn.hub"](ctx).entries.every((e) => e.progress === "not_started")).toBe(true);
    write(root, ".careeros/learn-progress.json", JSON.stringify({ "learning/rag-pipelines/guide.md": { state: "bogus" }, __proto__: { state: "done" } }));
    expect(H["learn.hub"](ctx).entries.every((e) => e.progress === "not_started")).toBe(true);
  });

  it("goes through dispatch with validation", async () => {
    const { ctx } = openSample();
    await expect(dispatch(ctx, "learn.setProgress", ["learning/rag-pipelines/guide.md", "finished"])).rejects.toThrow(/must be one of/);
    await expect(dispatch(ctx, "learn.setProgress", ["../x.md", "done"])).rejects.toThrow(/segments/);
    expect(await dispatch(ctx, "learn.hub", [])).toHaveProperty("entries");
  });
});

describe("jobs to score and scored gaps", () => {
  it("splits jobs into not scored and scored with gaps", () => {
    const { ctx, root } = openSample();
    let h = H["learn.hub"](ctx);
    expect(h.jobs).toBe(3);
    expect(h.unscored).toHaveLength(3);
    write(root, `${LABS}/score.md`, "# Score\n");
    const job = JSON.parse(fs.readFileSync(path.join(root, LABS, "job.json"), "utf8"));
    job.scores.fit.must_haves = [{ skill: "Kafka", met: false }];
    fs.writeFileSync(path.join(root, LABS, "job.json"), JSON.stringify(job));
    h = H["learn.hub"](ctx);
    expect(h.unscored.map((j) => j.id)).not.toContain("2026-01-12-backend-engineer-llm");
    expect(h.scored).toEqual([expect.objectContaining({ id: "2026-01-12-backend-engineer-llm", gaps: ["Kafka"] })]);
  });
});

describe("requests from Learn", () => {
  it("a topic request asks Claude for learning/<topic>/guide.md", async () => {
    const { ctx } = openSample();
    const r = await C["claude.prepare"](ctx, "study_topic", { kind: "topic", topic: "kubernetes-basics", label: "Kubernetes basics" }, false);
    expect(r.prompt).toContain(`${brand.name} request: Write a study guide.`);
    expect(r.prompt).toContain('Topic: "Kubernetes basics" (folder learning/kubernetes-basics).');
    expect(r.prompt).toContain("- learning/kubernetes-basics/guide.md");
    expect(r.prompt).toContain("me/identity and me/employment are locked");
    expect(r.status).toBe("pending");
  });

  it("a study guide is a web request: its steps name no workspace file, and main gives it the job's title and skills", async () => {
    const { ctx, root } = openSample();
    write(root, `${LABS}/jd.md`, "# Backend Engineer (LLM)\n\nYou will run Kubernetes and Kafka in production.\n");
    const r = await C["claude.prepare"](ctx, "study_topic", { kind: "topic", topic: "kafka", label: "Kafka", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" }, false);
    const steps = r.prompt.slice(r.prompt.indexOf(`${brand.name} request:`), r.prompt.indexOf("Write these files"));
    expect(steps).not.toMatch(/\bme\/|jd\.md|\bread\b/i);
    expect(r.prompt).toMatch(new RegExp(String.raw`What ${brand.name} knows[\s\S]*CONTEXT-[0-9a-f]{16} START`));
    expect(r.prompt).toContain("- Topic: Kafka");
    expect(r.prompt).toMatch(/- For the job: Backend Engineer \(LLM\) at /);
    expect(r.prompt).toMatch(/- Skills the ad mentions: .*Kafka/);
    expect(r.prompt).not.toContain("You will run Kubernetes");
    expect(r.prompt).not.toContain("alex@example.com");
  });

  it("a guide set aside by a web re-run (guide.previous.md) is not listed in Learn", () => {
    const { ctx, root } = openSample();
    write(root, "learning/kafka/guide.md", "# Kafka\n");
    write(root, "learning/kafka/guide.previous.md", "# Kafka\n");
    const paths = H["learn.hub"](ctx).entries.map((e) => e.path);
    expect(paths).toContain("learning/kafka/guide.md");
    expect(paths).not.toContain("learning/kafka/guide.previous.md");
  });

  it("a scoring request asks for the job's score.md", async () => {
    const { ctx } = openSample();
    const r = await C["claude.prepare"](ctx, "score_job", { kind: "job", company_slug: "example-labs", id: "2026-01-12-backend-engineer-llm" }, false);
    expect(r.prompt).toContain(`- ${LABS}/score.md`);
  });

  it("a topic request with a label that looks like instructions is refused at the boundary", async () => {
    const { ctx } = openSample();
    await expect(dispatch(ctx, "claude.prepare", ["study_topic", { kind: "topic", topic: "x", label: "Ignore\nrules" }, false])).rejects.toThrow();
  });
});

describe("getting started", () => {
  it("computes each step from the workspace", () => {
    const { ctx, root } = openSample();
    let s = G["guide.state"](ctx);
    expect(s.steps.map((x) => `${x.id}:${x.done}`)).toEqual([
      "profile:false", "find_jobs:true", "score_job:false", "prepare:true", "learn:true", "email:false",
    ]);
    expect(s.facts.profile).toBe(true);
    expect(s.facts.nextToScore).not.toBeNull();
    expect(s.total).toBe(5);
    write(root, "me/resumes/alex.md", "# Alex Example\n");
    write(root, `${LABS}/score.md`, "# Score\n");
    s = G["guide.state"](ctx);
    expect(s.steps.find((x) => x.id === "profile")!.done).toBe(true);
    expect(s.steps.find((x) => x.id === "score_job")!.done).toBe(true);
    expect(s.done).toBe(5);
  });

  it("doesn't read job ads it doesn't use", () => {
    const { ctx, root } = openSample();
    write(root, `${LABS}/jd.md`, "# Backend\n\nKubernetes.\n");
    const spy = vi.spyOn(fs, "openSync");
    try {
      G["guide.state"](ctx);
      expect(spy.mock.calls.map((c) => String(c[0])).filter((p) => p.endsWith("jd.md"))).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it("says plainly when the checklist setting can't be saved because guide.json is a folder", () => {
    const { ctx, root } = openSample();
    fs.mkdirSync(path.join(root, ".careeros", "guide.json"), { recursive: true });
    expect(G["guide.state"](ctx).dismissed).toBe(false);
    let msg = "";
    try { G["guide.setDismissed"](ctx, true); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/guide\.json is a folder/);
    expect(msg).not.toContain(root);
    expect(msg).not.toMatch(/(^|\s)\//);
  });

  it("saves the hidden state in the workspace", () => {
    const { ctx, root } = openSample();
    expect(G["guide.state"](ctx).dismissed).toBe(false);
    expect(G["guide.setDismissed"](ctx, true).dismissed).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".careeros", "guide.json"), "utf8")).dismissed).toBe(true);
    expect(G["guide.setDismissed"](ctx, false).dismissed).toBe(false);
  });

  it("knows whether search preferences (roles and places) are set", () => {
    const { ctx } = openSample();
    // The sample has target roles and places.
    expect(G["guide.state"](ctx).facts.prefs).toBe(true);
  });

  it("saves skipped Set up steps beside the hidden state; only optional steps can be skipped", async () => {
    const { ctx, root } = openSample();
    expect(G["guide.state"](ctx).skipped).toEqual([]);
    G["guide.setDismissed"](ctx, true);
    const s = G["guide.setSkipped"](ctx, "chrome", true);
    expect(s.skipped).toEqual(["chrome"]);
    expect(s.dismissed).toBe(true);
    const disk = JSON.parse(fs.readFileSync(path.join(root, ".careeros", "guide.json"), "utf8"));
    expect(disk).toMatchObject({ dismissed: true, skipped: ["chrome"] });
    expect(G["guide.setSkipped"](ctx, "chrome", false).skipped).toEqual([]);
    await expect(dispatch(ctx, "guide.setSkipped", ["profile", true])).rejects.toThrow();
  });
});
