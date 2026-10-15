import { describe, expect, it } from "vitest";
import { guideState, jobsToLearn, setupState, learnEntries, learnHistory, sanitizeProgress, skillGaps, skillsIn, type LearnData } from "../src/index.js";

describe("skillsIn", () => {
  it("matches whole words only", () => {
    expect([...skillsIn("We use JavaScript and Go.")]).toEqual([]);
    expect([...skillsIn("Java, K8s and Node.js")].sort()).toEqual(["Java", "Kubernetes", "Node.js"]);
    expect([...skillsIn("CI/CD with GitHub Actions")]).toEqual(["CI/CD"]);
  });
  it("counts ambiguous words only near a word that gives them the tech meaning", () => {
    const has = (t: string, skill: string) => skillsIn(t).has(skill);
    expect(has("No recruitment agents please.", "AI agents")).toBe(false);
    expect(has("Travel agents and real estate agents welcome.", "AI agents")).toBe(false);
    expect(has("You will build agents on top of LLMs.", "AI agents")).toBe(true);
    expect(has("Agentic workflows", "AI agents")).toBe(true);
    expect(has("Able to react quickly to customer issues.", "React")).toBe(false);
    expect(has("React and TypeScript on the front end.", "React")).toBe(true);
    expect(has("ReactJS", "React")).toBe(true);
    expect(has("Load shipping containers at the port.", "Docker")).toBe(false);
    expect(has("Run containers on Kubernetes.", "Docker")).toBe(true);
    expect(has("Monitoring student progress each term.", "Observability")).toBe(false);
    expect(has("Monitoring and alerting for production systems.", "Observability")).toBe(true);
  });
});

describe("skillGaps", () => {
  it("counts each job once, drops what the person has, sorts by count and caps at the limit", () => {
    const jobs = ["Kubernetes and kubernetes again, AWS", "Kubernetes, Python", "AWS, Python, Kafka"];
    const s = skillGaps({ jobs, have: ["I write Python."], limit: 2 });
    expect(s).toEqual([
      { skill: "AWS", slug: "aws", jobs: 2, total: 3, started: false },
      { skill: "Kubernetes", slug: "kubernetes", jobs: 2, total: 3, started: false },
    ]);
  });
  it("treats the person's own listed skills as theirs, ambiguous words included", () => {
    const jobs = ["Build AI agents with LLMs and React on the front end"];
    expect(skillGaps({ jobs, have: [] }).map((x) => x.skill)).toContain("AI agents");
    expect(skillGaps({ jobs, have: [], declared: ["agents", "react"] }).map((x) => x.skill)).toEqual(["LLMs"]);
  });
  it("defaults to eight suggestions", () => {
    const all = "python typescript java sql react graphql docker kubernetes terraform aws azure kafka";
    expect(skillGaps({ jobs: [all], have: [] })).toHaveLength(8);
  });
});

describe("learn entries and history", () => {
  const data: LearnData = {
    topics: [{ slug: "rag", title: "RAG", items: [{ path: "learning/rag/guide.md", title: "RAG", kind: "guide" }, { path: "learning/rag/videos/1/renders/final.mp4", title: "Video lesson 1", kind: "video" }] }],
    interviewPrep: [{ company_slug: "acme-corp", id: "j1", title: "AI Engineer", company_name: "Acme Corp", items: [
      { path: "companies/acme-corp/jobs/j1/interview/questions.md", title: "Prep", kind: "guide" },
      { path: "companies/acme-corp/jobs/j1/videos/jd-walkthrough-1/renders/final.mp4", title: "JD walkthrough 1", kind: "video" },
    ] }],
    recaps: [], videos: [], video_recaps: [],
  };
  it("types and sources every item, newest first", () => {
    const at: Record<string, string> = { "learning/rag/guide.md": "2026-01-02T00:00:00.000Z", "companies/acme-corp/jobs/j1/interview/questions.md": "2026-01-03T00:00:00.000Z" };
    const e = learnEntries(data, {}, (p) => at[p] ?? "");
    expect(e.map((x) => `${x.type}:${x.title}`)).toEqual(["interview:Prep", "guide:RAG", "video:JD walkthrough 1", "video:Video lesson 1"]);
    expect(e[0]!.source).toMatchObject({ company_name: "Acme Corp" });
  });
  it("history holds done items, latest finished first", () => {
    const progress = sanitizeProgress({
      "learning/rag/guide.md": { state: "done", at: "2026-01-05T00:00:00.000Z" },
      "companies/acme-corp/jobs/j1/interview/questions.md": { state: "done", at: "2026-01-06T00:00:00.000Z" },
      "learning/rag/videos/1/renders/final.mp4": { state: "in_progress", at: "nope" },
    });
    const h = learnHistory(learnEntries(data, progress, () => ""));
    expect(h.map((x) => x.title)).toEqual(["Prep", "RAG"]);
  });
});

describe("setupState (Set up JobCairn)", () => {
  const none = { profile: false, resume: false, prefs: false, jobs: 0, scored: 0, nextToScore: null, preparing: 0, nextToPrepare: null, learning: 0 };
  const all = { ...none, profile: true, resume: true, prefs: true, jobs: 2, scored: 1 };
  const ids = (s: ReturnType<typeof setupState>) => s.steps.map((x) => x.id);
  it("lists the six steps in order, nothing done in a new workspace", () => {
    const s = setupState(none, { claude: false, chrome: false }, []);
    expect(ids(s)).toEqual(["claude", "chrome", "profile", "search_prefs", "find_jobs", "score_job"]);
    expect(s).toMatchObject({ done: 0, total: 6, complete: false });
  });
  it("ticks each step from real state: Claude ready, Chrome connected, profile with resume, roles and places, jobs, a score", () => {
    const s = setupState(all, { claude: true, chrome: true }, []);
    expect(s.steps.every((x) => x.done)).toBe(true);
    expect(s).toMatchObject({ done: 6, total: 6, complete: true });
    // A profile without a resume isn't done yet.
    expect(setupState({ ...all, resume: false }, { claude: true, chrome: true }, []).steps.find((x) => x.id === "profile")?.done).toBe(false);
  });
  it("Claude still being checked is neither done nor complete", () => {
    const s = setupState(all, { claude: null, chrome: true }, []);
    expect(s.steps[0]).toMatchObject({ id: "claude", done: false });
    expect(s.complete).toBe(false);
  });
  it("Chrome can be skipped and then counts; other steps can't be skipped", () => {
    const s = setupState(none, { claude: false, chrome: false }, ["chrome", "profile"]);
    expect(s.steps.find((x) => x.id === "chrome")).toMatchObject({ done: false, skipped: true, optional: true });
    expect(s.steps.find((x) => x.id === "profile")).toMatchObject({ skipped: false, optional: false });
    expect(s.done).toBe(1);
    expect(setupState(all, { claude: true, chrome: false }, ["chrome"]).complete).toBe(true);
  });
  it("without Chrome in this app, the step isn't listed as doable or counted", () => {
    const s = setupState(all, { claude: true }, []);
    expect(s.steps.find((x) => x.id === "chrome")?.available).toBe(false);
    expect(s).toMatchObject({ done: 5, total: 5, complete: true });
  });
});

describe("guideState", () => {
  const facts = { profile: true, resume: false, prefs: false, jobs: 0, scored: 0, nextToScore: null, preparing: 0, nextToPrepare: null, learning: 0 };
  it("counts only steps that can be done (email is coming soon)", () => {
    const s = guideState(facts, false);
    expect(s.total).toBe(5);
    expect(s.done).toBe(0);
    expect(s.steps.find((x) => x.id === "email")).toEqual({ id: "email", done: false, available: false });
  });
  it("counts Email once the app has mail, and ticks it when Gmail is connected", () => {
    expect(guideState({ ...facts, email: false }, false)).toMatchObject({ total: 6, done: 0 });
    expect(guideState({ ...facts, email: true }, false).steps.find((x) => x.id === "email")).toEqual({ id: "email", done: true, available: true });
  });
  it("ticks steps from facts", () => {
    const s = guideState({ ...facts, resume: true, jobs: 2, scored: 1, preparing: 1, learning: 3 }, true);
    expect(s.done).toBe(5);
    expect(s.dismissed).toBe(true);
  });
});

describe("jobsToLearn", () => {
  it("lists the first few jobs not scored yet and counts all of them", () => {
    const job = (i: number, scored: boolean) => ({ company_slug: "acme-corp", id: `j${i}`, title: `Role ${i}`, company_name: "Acme Corp", gaps: scored ? ["Kafka"] : [], scored });
    const r = jobsToLearn([...Array.from({ length: 11 }, (_, i) => job(i, false)), job(99, true)]);
    expect(r.unscored).toHaveLength(8);
    expect(r.unscored_total).toBe(11);
    expect(r.scored.map((j) => j.id)).toEqual(["j99"]);
  });
});
