import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { layout, readRecord, samplePdf } from "@careeros/core";
import type { ClaudeEngineState, InboxItem } from "@careeros/contract";
import { dispatch } from "../src/dispatch.js";
import { inboxHandlers as I } from "../src/inbox.js";
import { defaultTextReader, setTextReader } from "../src/inbox-text.js";
import { MCP_TOOLS, mcpSession } from "../src/claude/mcp/tools.js";
import { fakeClaude, S, type FakeOpts } from "./claude/fake-claude.js";
import { openSample } from "./helpers.js";

const AD = (company: string) => `# Applied AI Engineer

${company} is hiring an Applied AI Engineer in Brisbane.

## About the role
You will build agents.

## Responsibilities
- Ship LLM features

## Requirements
- Python

Salary: $140,000 per annum. How to apply: use the form.
`;
const RESUME = "Alex Example\nalex@example.com\n\nProfessional summary\nAI Engineer.\n\nExperience\nExample Labs, 2023 - Present\n\nEducation\nBSc, 2021\n";
const VISA = "Visa grant notice\nTransaction reference number: EGO0000000\nSubclass 482. Date of birth: 01 Jan 1990.";

function drop(root: string, name: string, text: string) { fs.writeFileSync(path.join(layout(root).inbox, name), text); }
const byName = (items: InboxItem[], name: string) => items.find((i) => i.name === name)!;

afterEach(() => { setTextReader(defaultTextReader); });

describe("drop box: classifying by content on this computer", () => {
  it("recognises a saved job ad markdown that names no saved company, and offers Add as a job", async () => {
    const { ctx, root } = openSample();
    drop(root, "saved-ad.md", AD("Example Robotics"));
    const it = byName(await I["inbox.list"](ctx), "saved-ad.md");
    expect(it.kind).toBe("job_ad");
    expect(it.suggestion).toMatchObject({ target: null, by: "content" });
    expect(it.suggestion.reason).toBe("Looks like a job ad from Example Robotics. Add it as a job, or choose a folder.");
    expect(it.job).toEqual({ company: "Example Robotics", title: "Applied AI Engineer" });
    expect(it.askable).toBe(false);
  });

  it("files a job ad for a saved company into that job, by content", async () => {
    const { ctx, root } = openSample();
    drop(root, "ad.txt", AD("Acme Corp"));
    const it = byName(await I["inbox.list"](ctx), "ad.txt");
    expect(it.suggestion).toMatchObject({ target: { kind: "job", company_slug: "acme-corp", subdir: "" }, by: "content" });
  });

  it("sends a resume to Resumes and a visa letter to the locked Identity folder, never to Claude", async () => {
    const { ctx, root } = openSample();
    drop(root, "alex.md", RESUME);
    drop(root, "notes.txt", VISA);
    const items = await I["inbox.list"](ctx);
    expect(byName(items, "alex.md")).toMatchObject({ kind: "resume", suggestion: { target: { kind: "me", dir: "resumes" }, by: "content" } });
    expect(byName(items, "notes.txt")).toMatchObject({ kind: "identity", askable: false, suggestion: { target: { kind: "me", dir: "identity", sub: "visa" } } });
    await expect(I["inbox.ask"](ctx, "notes.txt")).rejects.toThrow("This file looks like it belongs in a locked folder, so it stays on this computer and isn't sent to Claude.");
  });

  it("reads a PDF's text with the resume reader, and uses name rules when a PDF can't be read", async () => {
    const { ctx, root } = openSample();
    fs.writeFileSync(path.join(layout(root).inbox, "upload-0042.pdf"), samplePdf(["Alex Example", "Professional summary", "Experience", "Example Labs, AI Engineer, 2023 - Present", "Education", "Skills"]));
    expect(byName(await I["inbox.list"](ctx), "upload-0042.pdf")).toMatchObject({ kind: "resume", suggestion: { target: { kind: "me", dir: "resumes" }, by: "content" } });
  });

  it("falls back to name rules for a PDF it can't read", async () => {
    const { ctx, root } = openSample();
    drop(root, "scan-0042.pdf", "%PDF-1.7 not really");
    const it = byName(await I["inbox.list"](ctx), "scan-0042.pdf");
    expect(it.suggestion).toMatchObject({ target: null, by: "name", confidence: "low" });
    expect(it.askable).toBe(true);
    setTextReader({ read: async () => RESUME });
    drop(root, "cv-scan.pdf", "%PDF-1.7");
    expect(byName(await I["inbox.list"](ctx), "cv-scan.pdf")).toMatchObject({ kind: "resume", suggestion: { by: "content" } });
  });
});

describe("drop box: Add as a job", () => {
  it("creates the job with the ad as its text, then files the original into it", async () => {
    const { ctx, root } = openSample();
    drop(root, "saved-ad.md", AD("Example Robotics"));
    const r = await I["inbox.addAsJob"](ctx, "saved-ad.md", { company: "Example Robotics", title: "Applied AI Engineer" });
    expect(r.items.map((i) => i.name)).not.toContain("saved-ad.md");
    const dir = layout(root).jobDir(r.job.company_slug, r.job.id);
    expect(fs.readFileSync(path.join(dir, "jd.md"), "utf8")).toContain("Applied AI Engineer");
    expect(fs.existsSync(path.join(dir, "saved-ad.md"))).toBe(true);
    const job = readRecord("job", layout(root).jobFile(r.job.company_slug, r.job.id));
    expect(job.title).toBe("Applied AI Engineer");
    expect(job.files.map((f) => f.path)).toEqual(["jd.md", "saved-ad.md"]);
  });

  it("checks the name and fields like any other call", async () => {
    const { ctx } = openSample();
    await expect(I["inbox.addAsJob"](ctx, "missing.md", { company: "Acme Corp", title: "AI Engineer" })).rejects.toThrow(/not in the drop box/);
    await expect(dispatch(ctx, "inbox.addAsJob", ["../workspace.json", { company: "Acme Corp", title: "AI Engineer" }])).rejects.toThrow();
    await expect(dispatch(ctx, "inbox.addAsJob", ["x.md", { company: "", title: "AI Engineer" }])).rejects.toThrow();
  });
});

/** A fake Claude Code run that reads its --mcp-config and "calls" inbox_suggest like the real MCP server would. */
function answers(answer: Record<string, unknown>, seen: string[][]): FakeOpts["run"] {
  return (_opts, args) => {
    seen.push(args);
    const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as { mcpServers: { careeros: { args: string[] } } };
    const a = cfg.mcpServers.careeros.args;
    const ask = a[a.indexOf("--ask") + 1]!;
    const tool = MCP_TOOLS.inbox_suggest;
    tool.run({ ...mcpSession("/unused", ["inbox_suggest"]), ask }, tool.validate(answer, "args"));
    return { stdout: [S.init(), S.tool("t1", "mcp__careeros__inbox_suggest", answer), S.ok("t1"), S.result({ result: "Suggested." })].join("\n") };
  };
}

async function settle(ctx: Parameters<typeof I["inbox.list"]>[0], name: string, state: string) {
  for (let i = 0; i < 200; i++) {
    const it = byName(await I["inbox.list"](ctx), name);
    if (it.claude?.state === state) return it;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no ${state} for ${name}`);
}

describe("drop box: asking Claude about one unsure file", () => {
  function setup(answer: Record<string, unknown>, o: FakeOpts = {}) {
    const seen: string[][] = [];
    const f = fakeClaude({ ...o, run: answers(answer, seen) });
    const s = openSample();
    s.host.claude = f.host;
    return { ...s, seen, consent: () => dispatch(s.ctx, "claude.consent", []) as Promise<ClaudeEngineState> };
  }

  it("lets Claude read only a copy of that file, and shows its answer as a suggestion", async () => {
    const x = setup({ folder: "job_application", confidence: "high", reason: "It answers selection criteria for an AI role.", company: "Acme Corp", job_title: "AI Engineer" });
    await x.consent();
    drop(x.root, "criteria.txt", "Selection criteria responses, draft two.");
    const asked = byName(await I["inbox.ask"](x.ctx, "criteria.txt"), "criteria.txt");
    expect(asked.claude).toEqual({ state: "running" });
    const it = await settle(x.ctx, "criteria.txt", "done");
    expect(it.suggestion).toEqual({ target: { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer", subdir: "application" }, reason: "It answers selection criteria for an AI role.", confidence: "high", by: "claude" });

    const args = x.seen[0]!;
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(allowed).toEqual([expect.stringMatching(/^Read\(\.\/\.careeros\/tmp\/ask-[0-9a-f]{16}\/document\.txt\)$/), "mcp__careeros__inbox_suggest"]);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
    // The copy and its answer are cleaned up; nothing Claude touched is left behind.
    expect(fs.readdirSync(path.join(x.root, ".careeros", "tmp")).filter((n) => n.startsWith("ask-"))).toEqual([]);
    // The prompt names the copy, never the person's folders.
    expect(fs.readFileSync(path.join(layout(x.root).inbox, "criteria.txt"), "utf8")).toBe("Selection criteria responses, draft two.");
  });

  it("starts on its own for an unsure file once Claude is known to be ready, and never for a locked one", async () => {
    const x = setup({ folder: "projects", confidence: "medium", reason: "A project write-up." });
    await x.consent();
    drop(x.root, "thing.txt", "Notes about a weekend robot build.");
    drop(x.root, "notes.txt", VISA);
    const first = await I["inbox.list"](x.ctx);
    expect(byName(first, "thing.txt").claude).toEqual({ state: "running" });
    expect(byName(first, "notes.txt").claude).toBeUndefined();
    const it = await settle(x.ctx, "thing.txt", "done");
    expect(it.suggestion).toMatchObject({ target: { kind: "me", dir: "projects" }, by: "claude" });
    expect(x.seen).toHaveLength(1);
  });

  it("waits for Ask Claude when Claude is paid for with an API key or the sign-in type is unknown", async () => {
    for (const auth of [{ authMethod: "api_key" }, { apiKeySource: "ANTHROPIC_API_KEY" }, {}]) {
      const x = setup({ folder: "projects", confidence: "medium", reason: "A project write-up." }, { auth });
      const st = await x.consent();
      expect(st.auth).not.toBe("subscription");
      drop(x.root, "thing.txt", "Notes about a weekend robot build.");
      const first = byName(await I["inbox.list"](x.ctx), "thing.txt");
      expect(first.claude).toBeUndefined();
      expect(first.askable).toBe(true);
      expect(x.seen).toHaveLength(0);
      // Asking still works.
      await I["inbox.ask"](x.ctx, "thing.txt");
      expect((await settle(x.ctx, "thing.txt", "done")).suggestion).toMatchObject({ by: "claude" });
      expect(x.seen).toHaveLength(1);
    }
  });

  it("says plainly when Claude didn't answer", async () => {
    const seen: string[][] = [];
    const f = fakeClaude({ run: (_o, args) => { seen.push(args); return { stdout: [S.init(), S.result({ result: "I couldn't decide." })].join("\n") }; } });
    const s = openSample();
    s.host.claude = f.host;
    await dispatch(s.ctx, "claude.consent", []);
    drop(s.root, "thing.txt", "Notes.");
    await I["inbox.ask"](s.ctx, "thing.txt");
    const it = await settle(s.ctx, "thing.txt", "failed");
    expect(it.claude).toEqual({ state: "failed", error: "Claude didn't suggest a folder." });
    expect(it.askable).toBe(true);
  });

  it("refuses when Claude Code isn't set up", async () => {
    const { ctx, root } = openSample();
    drop(root, "thing.txt", "Notes.");
    await expect(I["inbox.ask"](ctx, "thing.txt")).rejects.toThrow("Claude Code isn't set up on this computer. Open Settings > Claude to set it up.");
  });
});

describe("drop box: the Claude run's limits", () => {
  it("pins the MCP server's answer folder to this workspace's own ask folder, and only with inbox_suggest", async () => {
    const { parseMcpArgv } = await import("../src/claude/mcp/argv.js");
    const env = { CAREEROS_WORKSPACE: "/fictional/alex-example/CareerOS" };
    const ok = "/fictional/alex-example/CareerOS/.careeros/tmp/ask-0123456789abcdef";
    expect(parseMcpArgv(["--tools", "inbox_suggest", "--ask", ok], env).ask).toBe(ok);
    for (const bad of ["/fictional/alex-example/CareerOS/me/identity", "/tmp/ask-0123456789abcdef", "/fictional/alex-example/CareerOS/.careeros/tmp/ask-../../x", "relative/ask-0123456789abcdef"]) {
      expect(() => parseMcpArgv(["--tools", "inbox_suggest", "--ask", bad], env)).toThrow();
    }
    expect(() => parseMcpArgv(["--tools", "inbox_suggest"], env)).toThrow(/go together/);
    expect(() => parseMcpArgv(["--tools", "job_new", "--ask", ok], env)).toThrow(/go together/);
  });

  it("refuses a read-only plan for anything but the run's own copy", async () => {
    const { inboxSuggestPlan, toolArgs } = await import("../src/claude/args.js");
    const t = toolArgs(inboxSuggestPlan(".careeros/tmp/ask-0123456789abcdef/document.md", "/x"), ["me/identity", "me/employment"]);
    expect(t.tools).toEqual(["Read"]);
    expect(t.allowed).toEqual(["Read(./.careeros/tmp/ask-0123456789abcdef/document.md)", "mcp__careeros__inbox_suggest"]);
    for (const bad of ["me/identity/passport.pdf", "inbox/cv.pdf", ".careeros/tmp/ask-0123456789abcdef/../x.md", "**"]) {
      expect(() => toolArgs(inboxSuggestPlan(bad, "/x"), [])).toThrow();
    }
  });
});
