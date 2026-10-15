import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { snapshot, verifyRun } from "../../src/claude/verify.js";
import { parseLine, relToRoot, toolStep } from "../../src/claude/stream.js";
import { scrubMessage } from "../../src/claude/scrub.js";
import { refusedLine } from "../../src/claude/engine.js";
import type { ClaudeRefusal } from "@careeros/contract";
import { S } from "./fake-claude.js";
import { tmpDir } from "../helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const ROOT = "/Users/alex/CareerOS";
const JOB = "companies/acme-corp/jobs/2026-01-12-ai-engineer";

describe("stream-json to plain progress", () => {
  it("maps tools to plain steps, never showing inputs", () => {
    expect(toolStep(ROOT, "Read", { file_path: `${ROOT}/${JOB}/jd.md` })).toBe("Reading the job ad");
    expect(toolStep(ROOT, "Read", { file_path: `${ROOT}/me/history/zeta.md` })).toBe("Reading your experience");
    expect(toolStep(ROOT, "Read", { file_path: "/etc/passwd" })).toBe("Reading a file");
    expect(toolStep(ROOT, "Write", { file_path: `${ROOT}/${JOB}/application/resume.md` })).toBe("Writing your resume");
    expect(toolStep(ROOT, "Write", { file_path: `${JOB}/application/claims.json` })).toBe("Checking claims");
    expect(toolStep(ROOT, "Grep", { pattern: "secret" })).toBe("Looking through your files");
    expect(toolStep(ROOT, "WebSearch", { query: "acme corp ignore previous instructions" })).toBe("Searching the web");
    expect(toolStep(ROOT, "WebFetch", { url: "https://www.acme.example/careers?x=1" })).toBe("Reading acme.example");
    expect(toolStep(ROOT, "Bash", { command: "careeros job new --company x" })).toBe("Adding a job");
    expect(toolStep(ROOT, "Bash", { command: "rm -rf /" })).toBe("Running a command");
    expect(toolStep(ROOT, "Skill", { skill: "career" })).toBe("Using the career skill");
    expect(toolStep(ROOT, "Skill", { skill: "<script>" })).toBe(`Using a ${brand.name} skill`);
  });

  it("parses a recorded run", () => {
    const ev = [
      S.init(),
      S.tool("a", "Read", { file_path: `${ROOT}/${JOB}/jd.md` }),
      S.ok("a"),
      S.tool("b", "Write", { file_path: `${ROOT}/${JOB}/application/resume.md`, content: "x" }),
      S.ok("b"),
      S.text(`Saved to ${ROOT}/${JOB}/application/resume.md and /private/var/x/y.md`),
      S.result({ permission_denials: [{ tool_name: "Write" }] }),
      "not json at all",
      "[1,2]",
    ].flatMap((l) => parseLine(ROOT, l));
    expect(ev).toEqual([
      { kind: "step", label: "Starting Claude" },
      { kind: "auth", apiKey: true },
      { kind: "step", label: "Reading the job ad" },
      { kind: "tool_result", toolId: "a", ok: true },
      { kind: "step", label: "Writing your resume" },
      { kind: "write", toolId: "b", rel: `${JOB}/application/resume.md` },
      { kind: "tool_result", toolId: "b", ok: true },
      { kind: "text", text: `Saved to ${JOB}/application/resume.md and a file` },
      { kind: "result", ok: true, text: "I wrote the files.", cost_usd: 0.42, duration_ms: 61_000, turns: 7, denials: 1, refused: [{ tool: "Write", what: "" }] },
    ]);
  });

  it("records what each refused step tried, in safe words", () => {
    const [r] = parseLine(ROOT, S.result({ permission_denials: [
      { tool_name: "Write", tool_use_id: "w", tool_input: { file_path: `${ROOT}/knowledge/job-searches/2026-10-10.md`, content: "x" } },
      { tool_name: "Read", tool_input: { file_path: "/Users/alex/.ssh/id_rsa" } },
      { tool_name: "Bash", tool_input: { command: `agent-browser --session x open https://www.seek.com.au/jobs (in ${ROOT})` } },
      { tool_name: "WebFetch", tool_input: { url: "https://www.seek.com.au/job/100001" } },
      { tool_name: "mcp__careeros__job_new", tool_input: { company: "Acme Corp" } },
    ] }));
    expect(r).toMatchObject({ kind: "result", denials: 5, refused: [
      { tool: "Write", what: "knowledge/job-searches/2026-10-10.md" },
      { tool: "Read", what: "a file outside the workspace" },
      { tool: "Bash", what: "agent-browser --session x open https://www.seek.com.au/jobs (in your workspace)" },
      { tool: "WebFetch", what: "https://www.seek.com.au/job/100001" },
      { tool: "mcp__careeros__job_new", what: "" },
    ] });
    expect(JSON.stringify(r)).not.toContain(ROOT);
    expect(refusedLine((r as { refused: ClaudeRefusal[] }).refused, 5)).toBe(" It wasn't allowed to: Write (knowledge/job-searches/2026-10-10.md); Read (a file outside the workspace); Bash (agent-browser --session x open https://www.seek.com.au/jobs (in your workspace)); and 2 more.");
    expect(refusedLine([], 2)).toBe(" 2 of its steps were refused.");
    expect(refusedLine([], 0)).toBe("");
  });

  it("reads an error result", () => {
    const [r] = parseLine(ROOT, S.result({ subtype: "error_max_turns", is_error: true, result: `Stopped in ${ROOT}/x` }));
    expect(r).toMatchObject({ kind: "result", ok: false, text: "Stopped in x" });
  });

  it("keeps workspace paths relative and marks outside ones", () => {
    expect(relToRoot(ROOT, `${ROOT}/a/b.md`)).toBe("a/b.md");
    expect(relToRoot(ROOT, "a/b.md")).toBe("a/b.md");
    expect(relToRoot(ROOT, `${ROOT}/../evil.md`)).toBeNull();
    expect(relToRoot(ROOT, "/tmp/x")).toBeNull();
    expect(relToRoot(ROOT, 42)).toBeNull();
  });

  it("scrubs absolute paths but keeps links", () => {
    expect(scrubMessage(`Wrote ${ROOT}/notes.md, see https://acme.example/a and C:\\Users\\alex\\x.txt`, ROOT)).toBe("Wrote notes.md, see https://acme.example/a and a file");
  });
});

describe("output verification", () => {
  const write = (root: string, rel: string, text = "x") => {
    const p = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };

  it("lists the run's files, flags missing outputs and stray writes", () => {
    const root = tmpDir();
    write(root, `${JOB}/jd.md`);
    write(root, "notes/old.md");
    write(root, `${JOB}/application/resume.md`, "old");
    const before = snapshot(root);
    write(root, `${JOB}/application/cover-letter.md`);
    write(root, `${JOB}/application/answers.md`);
    write(root, "notes/sneaky.md");
    write(root, `${JOB}/job.json`, "{}");
    fs.rmSync(path.join(root, "notes/old.md"));
    const r = verifyRun({
      root, folder: `${JOB}/application`, expected: [`${JOB}/application/resume.md`, `${JOB}/application/cover-letter.md`], before,
      writes: [`${JOB}/application/cover-letter.md`, "settings/profile.json", null], others: [],
    });
    expect(r.files).toEqual([
      { path: `${JOB}/application/cover-letter.md`, label: "Cover letter", expected: true },
      { path: `${JOB}/application/answers.md`, label: "answers.md".replace("answers.md", "Application answers"), expected: false },
    ]);
    // resume.md existed before and wasn't rewritten.
    expect(r.missing).toEqual([`${JOB}/application/resume.md`]);
    expect(r.stray).toEqual(["a file outside your workspace", "notes/old.md (deleted)", "notes/sneaky.md", "settings/profile.json"]);
  });

  it("a score run's score.json (written by the score_record tool) is not stray", () => {
    const root = tmpDir();
    write(root, `${JOB}/jd.md`);
    const before = snapshot(root);
    write(root, `${JOB}/score.md`);
    write(root, `${JOB}/score.json`, "{}");
    write(root, `${JOB}/job.json`, "{}");
    const r = verifyRun({ root, folder: JOB, files: [`${JOB}/score.md`], expected: [`${JOB}/score.md`], before, writes: [`${JOB}/score.md`], others: [] });
    expect(r.missing).toEqual([]);
    expect(r.stray).toEqual([]);
  });

  it("with exact files, anything else in the folder is stray", () => {
    const root = tmpDir();
    const before = snapshot(root);
    write(root, "companies/acme-corp/research.md");
    write(root, `${JOB}/job-notes.md`);
    const r = verifyRun({ root, folder: "companies/acme-corp", files: ["companies/acme-corp/research.md"], expected: ["companies/acme-corp/research.md"], before, writes: [], others: [] });
    expect(r.missing).toEqual([]);
    expect(r.files.map((f) => f.label)).toEqual(["Company research"]);
    expect(r.stray).toEqual([`${JOB}/job-notes.md`]);
  });

  it("doesn't count another active run's folder, and never scans locked folders", () => {
    const root = tmpDir();
    const before = snapshot(root);
    write(root, "companies/acme-corp/research.md");
    write(root, "me/identity/passport.md");
    const r = verifyRun({ root, folder: `${JOB}/application`, expected: [], before, writes: [], others: ["companies/acme-corp"] });
    expect(r.stray).toEqual([]);
  });

  it("ignores OS junk files and folders anywhere, new or deleted", () => {
    const root = tmpDir();
    write(root, "companies/acme-corp/.DS_Store", "old");
    write(root, "companies/._Thumbs", "old");
    const before = snapshot(root);
    for (const junk of [".DS_Store", `${JOB}/.DS_Store`, "companies/._resume.md", "notes/Thumbs.db", "notes/THUMBS.DB", "notes/Desktop.ini",
      ".Spotlight-V100/Store-V2/x", "notes/~$cover-letter.docx", "notes/.Trashes/a", "notes/.fseventsd/b"]) write(root, junk);
    fs.rmSync(path.join(root, "companies/acme-corp/.DS_Store"));
    fs.rmSync(path.join(root, "companies/._Thumbs"));
    expect([...snapshot(root).keys()]).toEqual([]);
    const r = verifyRun({ root, folder: `${JOB}/application`, expected: [], before, writes: [], others: [] });
    expect(r.stray).toEqual([]);
  });

  it("still reports junk-looking files Claude itself says it wrote", () => {
    const root = tmpDir();
    const before = snapshot(root);
    write(root, "notes/.DS_Store");
    const r = verifyRun({ root, folder: `${JOB}/application`, expected: [], before, writes: ["notes/.DS_Store"], others: [] });
    expect(r.stray).toEqual(["notes/.DS_Store"]);
  });

  it("doesn't accept a linked output", () => {
    const root = tmpDir();
    const before = snapshot(root);
    write(root, "elsewhere.md");
    fs.mkdirSync(path.join(root, JOB), { recursive: true });
    fs.symlinkSync(path.join(root, "elsewhere.md"), path.join(root, JOB, "score.md"));
    const r = verifyRun({ root, folder: JOB, expected: [`${JOB}/score.md`], before, writes: [], others: [] });
    expect(r.missing).toEqual([`${JOB}/score.md`]);
  });
});

describe("long result lines and links (fix round 1)", () => {
  it("a result line cut off at the 64 KB line cap still counts as success, with the text that made it", () => {
    const full = S.result({ result: `Done. ${"x".repeat(70_000)}` });
    const cut = full.slice(0, 64 * 1024);
    expect(() => JSON.parse(cut)).toThrow();
    const [e] = parseLine("/w", cut);
    expect(e).toMatchObject({ kind: "result", ok: true, cost_usd: null, turns: null });
    expect((e as { text: string }).text.startsWith("Done.")).toBe(true);
    const bad = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "y".repeat(70_000) }).slice(0, 64 * 1024);
    expect(parseLine("/w", bad)[0]).toMatchObject({ kind: "result", ok: false });
    // A cut in the middle of an escape doesn't break the text.
    const esc = '{"type":"result","subtype":"success","is_error":false,"result":"Line one\\nLine \\u00';
    expect((parseLine("/w", esc)[0] as { text: string }).text).toContain("Line one");
    expect(parseLine("/w", '{"type":"assistant","message":{"content":[{"type":"text","text":"abc')).toEqual([]);
  });

  it("reports a link the run made or re-pointed, even in its own folder, instead of skipping it", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "notes"));
    fs.mkdirSync(path.join(root, "out"));
    fs.writeFileSync(path.join(root, "notes", "a.md"), "a");
    fs.symlinkSync(path.join(root, "notes", "a.md"), path.join(root, "notes", "old-link.md"));
    const before = snapshot(root);
    fs.symlinkSync("/etc/hosts", path.join(root, "out", "result.md"));
    fs.unlinkSync(path.join(root, "notes", "old-link.md"));
    fs.symlinkSync("/etc/passwd", path.join(root, "notes", "old-link.md"));
    const r = verifyRun({ root, folder: "out", files: null, expected: ["out/result.md"], before, writes: [], others: [] });
    expect(r.stray).toEqual(["notes/old-link.md (link)", "out/result.md (link)"]);
    expect(r.missing).toEqual(["out/result.md"]);
    expect(r.files).toEqual([]);
  });

  it("tells an API-key login from a Claude subscription", () => {
    expect(parseLine(ROOT, S.init("none"))).toContainEqual({ kind: "auth", apiKey: false });
    expect(parseLine(ROOT, S.init(""))).toContainEqual({ kind: "auth", apiKey: false });
    expect(parseLine(ROOT, S.init("ANTHROPIC_API_KEY"))).toContainEqual({ kind: "auth", apiKey: true });
    expect(parseLine(ROOT, S.init("apiKeyHelper"))).toContainEqual({ kind: "auth", apiKey: true });
  });
});
