import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout, listApprovals } from "@careeros/core";
import { applyHandlers as A } from "../src/apply.js";
import { openSample, tmpDir } from "./helpers.js";

const LABS = ["example-labs", "2026-01-12-backend-engineer-llm"] as const;

describe("apply flow", () => {
  it("prepares: writes PREPARE.md with the prompt and moves the job to Applying", () => {
    const { ctx, root } = openSample();
    const s = A["apply.prepare"](ctx, ...LABS);
    expect(s.step).toBe("prepare");
    const file = path.join(layout(root).jobDir(...LABS), "application", "PREPARE.md");
    expect(fs.readFileSync(file, "utf8")).toContain("Do not submit anything");
    expect(s.prompt).toContain(`companies/${LABS[0]}/jobs/${LABS[1]}`);
    expect(A["apply.state"](ctx, ...LABS).files.map((f) => f.path)).toEqual(["application/PREPARE.md"]);
  });

  it("won't ask for a hand-off before there is anything to hand off", () => {
    const { ctx } = openSample();
    A["apply.prepare"](ctx, ...LABS);
    expect(() => A["apply.requestApproval"](ctx, ...LABS)).toThrow(/Nothing to hand off yet/);
  });

  it("reviews Claude's files and claims, then queues a hand-off approval", () => {
    const { ctx, root } = openSample();
    const app = path.join(layout(root).jobDir(...LABS), "application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "# Alex Example\n");
    fs.writeFileSync(path.join(app, "claims.json"), JSON.stringify([{ claim: "Built retrieval pipelines", source: "me/history/roles.md" }, { claim: 3 }]));
    const s = A["apply.state"](ctx, ...LABS);
    expect(s.step).toBe("review");
    expect(s.claims).toEqual([{ claim: "Built retrieval pipelines", source: "me/history/roles.md" }]);
    const h = A["apply.requestApproval"](ctx, ...LABS);
    expect(h.step).toBe("handoff");
    const a = listApprovals(root).find((x) => x.action === "apply_handoff")!;
    expect(a).toMatchObject({ created_by: "app", status: "pending", payload: { company_slug: LABS[0], id: LABS[1], files: ["application/claims.json", "application/resume.md"] } });
  });

  it("never hands off the Resume Studio's files or Claude's unaccepted suggestions", () => {
    const { ctx, root } = openSample();
    const app = path.join(layout(root).jobDir(...LABS), "application");
    fs.mkdirSync(path.join(app, ".studio"), { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "# Alex Example\n");
    fs.writeFileSync(path.join(app, ".studio", "resume.style.json"), "{}");
    fs.writeFileSync(path.join(app, ".studio", "resume.suggested.md"), "# Alex Example, rewritten\n");
    fs.writeFileSync(path.join(app, "resume.suggested.md"), "# Alex Example, rewritten\n");
    fs.writeFileSync(path.join(app, "resume-suggestions.json"), "[]");
    fs.writeFileSync(path.join(app, "resume.style.json"), "{}");
    expect(A["apply.state"](ctx, ...LABS).files.map((f) => f.path)).toEqual(["application/resume.md"]);
    A["apply.requestApproval"](ctx, ...LABS);
    const a = listApprovals(root).find((x) => x.action === "apply_handoff")!;
    expect(a.payload.files).toEqual(["application/resume.md"]);
    expect(a.summary).toMatch(/^1 file\(s\) ready/);
  });

  it("keeps a claim with a missing or invalid source, recording an empty source", () => {
    const { ctx, root } = openSample();
    const app = path.join(layout(root).jobDir(...LABS), "application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "x");
    fs.writeFileSync(path.join(app, "claims.json"), JSON.stringify([
      { claim: "Built retrieval pipelines" },
      { claim: "Shipped a feature", source: 42 },
      { claim: "Has a source", source: "me/history/roles.md" },
    ]));
    expect(A["apply.state"](ctx, ...LABS).claims).toEqual([
      { claim: "Built retrieval pipelines", source: "" },
      { claim: "Shipped a feature", source: "" },
      { claim: "Has a source", source: "me/history/roles.md" },
    ]);
  });

  it("treats a broken claims file as no claims", () => {
    const { ctx, root } = openSample();
    const app = path.join(layout(root).jobDir(...LABS), "application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "x");
    fs.writeFileSync(path.join(app, "claims.json"), "{ nope");
    expect(A["apply.state"](ctx, ...LABS).claims).toBeNull();
  });

  it("refuses a second pending hand-off for the same job", () => {
    const { ctx, root } = openSample();
    const app = path.join(layout(root).jobDir(...LABS), "application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "x");
    A["apply.requestApproval"](ctx, ...LABS);
    expect(() => A["apply.requestApproval"](ctx, ...LABS)).toThrow("A hand-off for this job is already waiting for you.");
    expect(listApprovals(root).filter((x) => x.action === "apply_handoff")).toHaveLength(1);
  });

  it("asks for an https apply link before queueing a hand-off", () => {
    const { ctx, root } = openSample();
    const jf = path.join(layout(root).jobDir(...LABS), "job.json");
    const job = JSON.parse(fs.readFileSync(jf, "utf8")) as { url: string; apply_via: string };
    job.url = "http://jobs.example.com/labs/2";
    job.apply_via = "";
    fs.writeFileSync(jf, JSON.stringify(job, null, 2));
    const app = path.join(layout(root).jobDir(...LABS), "application");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "resume.md"), "x");
    expect(() => A["apply.requestApproval"](ctx, ...LABS)).toThrow("Add the job's https apply link first.");
    expect(listApprovals(root).filter((x) => x.action === "apply_handoff")).toEqual([]);
  });

  it("won't write PREPARE.md or read claims through a linked application folder", () => {
    const { ctx, root } = openSample();
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, "claims.json"), JSON.stringify([{ claim: "Outside claim", source: "x" }]));
    fs.writeFileSync(path.join(outside, "resume.md"), "x");
    fs.symlinkSync(outside, path.join(layout(root).jobDir(...LABS), "application"));
    expect(() => A["apply.prepare"](ctx, ...LABS)).toThrow(`companies/${LABS[0]}/jobs/${LABS[1]}/application isn't a real folder in your workspace.`);
    expect(fs.existsSync(path.join(outside, "PREPARE.md"))).toBe(false);
    const s = A["apply.state"](ctx, ...LABS);
    expect(s.claims).toBeNull();
    expect(s.files).toEqual([]);
  });

  it("marks the job applied", () => {
    const { ctx } = openSample();
    expect(A["apply.markApplied"](ctx, ...LABS).step).toBe("done");
  });
});
