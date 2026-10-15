import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allowAccessRequest, defaults, layout, readRecord, requestAccess, updateRecord, writeRecord } from "@careeros/core";
import { PLUGIN_SKILLS, type ClaudeRunView } from "@careeros/contract";
import { buildSourcePack, buildWriterPrompt, CancelledError, recapContent, type ScriptWriter, type WriterRequest } from "@careeros/video";
import { absRule } from "../src/claude/args.js";
import { engineFor } from "../src/claude/engine.js";
import { saveRun } from "../src/claude/runs.js";
import { videoFlow } from "../src/claude/video.js";
import { dispatch } from "../src/dispatch.js";
import { fakeVideoHost } from "../src/fakes-video.js";
import { claudeRunPort, claudeRunWriter, defaultWriter, WRITER_TOOLS, type RunPort } from "../src/video-claude.js";
import { registryFor, setVideoIntent, sponsorshipFor, videoIdle } from "../src/video.js";
import { fakeClaude, hangs, writes, type FakeOpts } from "./claude/fake-claude.js";
import { openSample } from "./helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const PLUGIN = path.resolve(import.meta.dirname, "../../../plugin");
const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");
const FOLDER = "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1";
const JOB = { kind: "job" as const, company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const FILES = ["script.txt", "spec.json", "sources.md", "notes.md"].map((n) => `${FOLDER}/${n}`);

function setup(o: { claude?: FakeOpts | false; consent?: boolean } = {}) {
  const x = openSample();
  x.host.video = fakeVideoHost({ pluginDir: PLUGIN, gsapFile: GSAP });
  const f = o.claude === false ? null : fakeClaude(o.claude ?? {});
  if (f) x.host.claude = f.host;
  updateRecord("job", layout(x.root).jobFile("acme-corp", "2026-01-12-ai-engineer"), (j) => { j.scores.fit.must_haves = [{ skill: "LLM agents", met: true }]; });
  const type = registryFor(x.ctx).byId("jd-walkthrough")!;
  fs.mkdirSync(path.join(x.root, FOLDER), { recursive: true });
  const ac = new AbortController();
  const req: WriterRequest = {
    root: x.root, folder: FOLDER, type, subject: JOB, options: {}, revision: null, signal: ac.signal,
    pack: buildSourcePack({ root: x.root, type, subject: JOB, folder: FOLDER, clock: x.ctx.clock() }),
  };
  const call = <T>(m: string, ...args: unknown[]) => dispatch(x.ctx, m, args) as Promise<T>;
  const consent = o.consent === false || !f ? Promise.resolve(null) : call("claude.consent");
  return { ...x, f, req, ac, call, consent };
}

/** A pretend Claude run: `script` decides what happens; approve writes the files. */
function fakePort(root: string, script: { paths: string[]; status?: string; note?: string; access?: string; hang?: boolean }) {
  const log = { started: [] as { title: string; prompt: string; folder: string; files: string[] }[], approved: [] as string[], cancelled: [] as string[] };
  let status = script.hang ? "running" : script.status ?? "done";
  const listeners = new Set<(runId: string, folder: string, state: string) => void>();
  const port: RunPort = {
    start: (o) => { log.started.push(o); if (script.access) queueMicrotask(() => { for (const l of listeners) l("run-1", script.access!, "allowed"); }); return "run-1"; },
    view: () => ({ status, note: script.note ?? "" }),
    cancel: (id) => { log.cancelled.push(id); status = "cancelled"; },
    pendingWrites: () => (log.approved.length ? [] : [{ id: "ap-1", paths: script.paths }]),
    approve: async (id) => { log.approved.push(id); for (const p of script.paths) fs.writeFileSync(path.join(root, p), "x"); },
    onAccess: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
  return { port, log };
}

const write = (w: ScriptWriter, req: WriterRequest) => w.write(req);
const content = (rel: string) => (rel.endsWith(".json") ? "{}\n" : `${path.basename(rel)}\n`);
const fileMap = (rels: string[]) => Object.fromEntries(rels.map((r) => [r, content(r)]));

describe("claudeRunWriter", () => {
  it("accepts the run's files when every one belongs to this video, and records locked facts", async () => {
    const { root, req } = setup();
    const { port, log } = fakePort(root, { paths: FILES, access: "me/employment" });
    const r = await write(claudeRunWriter(port, { pollMs: 1, now: () => new Date("2026-01-15T09:00:00Z") }), req);
    expect(log.approved).toEqual(["ap-1"]);
    expect(r.lockedFacts).toEqual([{ folder: "me/employment", granted_at: "2026-01-15T09:00:00.000Z" }]);
    expect(log.started[0]).toMatchObject({ title: "Video script: JD walkthrough", folder: FOLDER, files: FILES });
    expect(log.started[0]!.prompt).toContain(`Write each of them with the Write tool, using the full paths ${FILES.join(", ")}.`);
    expect(log.started[0]!.prompt).toContain(`Write these files into ${FOLDER}/`);
    // One instruction about locked folders: the run-mode one (fix round 1, item 4).
    expect(log.started[0]!.prompt).toContain("Nobody can answer you during this run");
    expect(log.started[0]!.prompt).not.toContain("wait for my answer");
  });

  it("gives up on a run that never ends, and cancels it", async () => {
    const { root, req } = setup();
    const { port, log } = fakePort(root, { paths: FILES, hang: true });
    await expect(write(claudeRunWriter(port, { pollMs: 1, waitMs: 20 }), req)).rejects.toThrow("Claude did not finish the script in time.");
    expect(log.cancelled).toEqual(["run-1"]);
  });

  it("stops when the run wrote any other file", async () => {
    const { root, req } = setup();
    const { port, log } = fakePort(root, { paths: [...FILES, "companies/acme-corp/notes.md"] });
    await expect(write(claudeRunWriter(port, { pollMs: 1 }), req)).rejects.toThrow(
      "Claude wrote files outside this video (companies/acme-corp/notes.md). The video stops here so you can check them.",
    );
    expect(log.approved).toEqual([]);
  });

  it("a fix pass accepts a run that changed only some files, and asks for only those", async () => {
    const { root, req } = setup();
    for (const f of FILES) fs.writeFileSync(path.join(root, f), "old");
    const fix = { ...req, revision: { note: "", issues: [{ level: "error" as const, code: "limit", scene: 1, path: "headline", message: "Scene 2: headline is too long." }] } };
    const { port, log } = fakePort(root, { paths: [FILES[1]!] });
    await write(claudeRunWriter(port, { pollMs: 1 }), fix);
    expect(log.approved).toEqual(["ap-1"]);
    expect(log.started[0]!.prompt).toContain(`Edit only the files you change, using the full paths ${FILES.join(", ")}.`);
    expect(log.started[0]!.prompt).not.toContain("write every one of them again");
  });

  it("a fix pass that wrote nothing is a failed pass", async () => {
    const { root, req } = setup();
    for (const f of FILES) fs.writeFileSync(path.join(root, f), "old");
    const fix = { ...req, revision: { note: "", issues: [{ level: "error" as const, code: "limit", scene: 1, path: "headline", message: "Too long." }] } };
    const { port } = fakePort(root, { paths: [] });
    await expect(write(claudeRunWriter(port, { pollMs: 1 }), fix)).rejects.toThrow("Claude didn't change any of the script's files.");
  });

  it("stops when Claude leaves a file out", async () => {
    const { root, req } = setup();
    const { port } = fakePort(root, { paths: FILES.slice(0, 2) });
    await expect(write(claudeRunWriter(port, { pollMs: 1 }), req)).rejects.toThrow("Claude did not write sources.md, notes.md. Ask Claude to revise, or start again.");
  });

  it("passes on the run's own message when it fails", async () => {
    const { root, req } = setup();
    const { port } = fakePort(root, { paths: [], status: "failed", note: "Claude Code isn't signed in. Open Settings > Claude to sign in." });
    await expect(write(claudeRunWriter(port, { pollMs: 1 }), req)).rejects.toThrow("Claude Code isn't signed in. Open Settings > Claude to sign in.");
  });

  it("cancels the run when the video is cancelled", async () => {
    const { root, req, ac } = setup();
    const { port, log } = fakePort(root, { paths: FILES, hang: true });
    const p = write(claudeRunWriter(port, { pollMs: 1 }), req);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(log.cancelled).toEqual(["run-1"]);
  });
});

describe("the real run port on the Claude Code engine", () => {
  it("runs Claude Code with only the writer's tools, and the run's files become the script", async () => {
    const x = setup({ claude: { run: writes(fileMap(FILES)) } });
    await x.consent;
    const r = await write(claudeRunWriter(claudeRunPort(x.ctx), { pollMs: 5 }), x.req);
    expect(r.lockedFacts).toEqual([]);
    expect(fs.readFileSync(path.join(x.root, FOLDER, "notes.md"), "utf8")).toBe("notes.md\n");

    const run = x.f!.runner.calls.find((c) => c.args[0] === "-p")!;
    expect(run.cwd).toBe(x.root);
    expect(run.input).toContain(`Write these files into ${FOLDER}/`);
    const arg = (flag: string) => run.args[run.args.indexOf(flag) + 1]!;
    expect(arg("--tools").split(",")).toEqual(WRITER_TOOLS.filter((t) => !t.startsWith("mcp__")));
    const allowed = run.args.slice(run.args.indexOf("--allowedTools") + 1, run.args.indexOf("--disallowedTools"));
    expect(allowed).toEqual(["Read(./**)", ...FILES.map((f) => `Edit(./${f})`), "mcp__careeros__request_access",
      ...PLUGIN_SKILLS.map((k) => `Skill(careeros:${k})`), `Read(${absRule(x.f!.host.pluginDir)}/**)`]);
    expect(WRITER_TOOLS).toContain("mcp__careeros__request_access");
    const denied = run.args.slice(run.args.indexOf("--disallowedTools") + 1);
    expect(denied).toEqual(expect.arrayContaining(["Read(./me/identity/**)", "Read(./me/employment/**)", "Edit(./me/**)"]));
    expect([arg("--tools"), ...allowed].join(" ")).not.toMatch(/WebSearch|WebFetch|Bash/);
    expect(JSON.parse(arg("--mcp-config")).mcpServers.careeros.args).toContain("request_access");

    const runs = await x.call<ClaudeRunView[]>("claude.runs");
    expect(runs[0]).toMatchObject({ action: "video_script", title: "Video script: JD walkthrough", status: "succeeded", stray: [], cost_usd: 0.42 });
    expect(runs[0]!.files.map((f) => f.path).sort()).toEqual([...FILES].sort());
  });

  it("records a locked folder a live grant opened for the run as a locked fact", async () => {
    const x = setup({ claude: { run: writes(fileMap(FILES)) } });
    await x.consent;
    const ask = requestAccess(x.root, { folder: "me/employment", why: "Dates for the pitch", minutes: 30 }, x.ctx.clock());
    allowAccessRequest(x.root, ask.id, 30, x.ctx.clock());
    const r = await write(claudeRunWriter(claudeRunPort(x.ctx), { pollMs: 5, now: () => new Date("2026-01-15T09:00:00Z") }), x.req);
    expect(r.lockedFacts).toEqual([{ folder: "me/employment", granted_at: "2026-01-15T09:00:00.000Z" }]);
    const run = x.f!.runner.calls.find((c) => c.args[0] === "-p")!;
    const denied = run.args.slice(run.args.indexOf("--disallowedTools") + 1);
    expect(denied).toContain("Read(./me/identity/**)");
    expect(denied).not.toContain("Read(./me/employment/**)");
  });

  it("stops the video when the run wrote outside it, and lists what it changed", async () => {
    const x = setup({ claude: { run: writes(fileMap([...FILES, "companies/acme-corp/notes.md"])) } });
    await x.consent;
    const p = write(claudeRunWriter(claudeRunPort(x.ctx), { pollMs: 5 }), x.req);
    await expect(p).rejects.toMatchObject({ code: "writer_outside" });
    await expect(p).rejects.toThrow("Claude wrote files outside this video (companies/acme-corp/notes.md). The video stops here so you can check them.");
    const runs = await x.call<ClaudeRunView[]>("claude.runs");
    expect(runs[0]).toMatchObject({
      action: "video_script", status: "failed", stray: ["companies/acme-corp/notes.md"],
      error: "Claude changed files outside this video: companies/acme-corp/notes.md. Check them before you go on. The video stops here.",
    });
  });

  // Final review I5: only what Claude itself wrote (its tool events) can fail the video. Another video's render, the
  // mail sync or the person's own edits during the run are not Claude's.
  it("doesn't blame Claude for files something else changed while it wrote the script", async () => {
    const other = "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-2";
    const x = setup({
      claude: {
        run: (opts, args) => {
          fs.mkdirSync(path.join(opts.cwd, other), { recursive: true });
          fs.writeFileSync(path.join(opts.cwd, other, "narration.wav"), "RIFF");
          fs.writeFileSync(path.join(opts.cwd, "companies/acme-corp/jobs/2026-01-12-ai-engineer/notes.md"), "# My note\n");
          fs.rmSync(path.join(opts.cwd, "companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md"), { force: true });
          return writes(fileMap(FILES))!(opts, args);
        },
      },
    });
    await x.consent;
    await write(claudeRunWriter(claudeRunPort(x.ctx), { pollMs: 5 }), x.req);
    const runs = await x.call<ClaudeRunView[]>("claude.runs");
    expect(runs[0]).toMatchObject({ action: "video_script", status: "succeeded", stray: [] });
  });

  it("two video scripts at once both finish", async () => {
    const second = "companies/acme-corp/videos/briefing-1";
    const files2 = ["script.txt", "spec.json", "sources.md"].map((n) => `${second}/${n}`);
    const x = setup({ claude: { run: async (opts, args) => {
      const own = args.join(" ").includes(second) ? files2 : FILES;
      await new Promise((r) => setTimeout(r, 20));
      return writes(fileMap(own))!(opts, args);
    } } });
    await x.consent;
    fs.mkdirSync(path.join(x.root, second), { recursive: true });
    const port = claudeRunPort(x.ctx);
    const a = port.start({ title: "a", prompt: "a", folder: FOLDER, files: FILES });
    const b = port.start({ title: "b", prompt: "b", folder: second, files: files2 });
    for (let i = 0; i < 400 && [a, b].some((id) => !["succeeded", "failed", "done"].includes(port.view(id)?.status ?? "")); i++) await new Promise((r) => setTimeout(r, 5));
    expect([port.view(a)?.status, port.view(b)?.status]).toEqual(["done", "done"]);
  });

  it("won't delete a video while its Claude script run is still ending (final review M3)", async () => {
    const x = setup({ claude: { run: hangs() } });
    await x.consent;
    writeRecord("video", path.join(x.root, FOLDER, "video.json"), defaults("video", {
      schema: 1, type: "jd-walkthrough", type_version: 1, subject: JOB, options: {}, created_at: "2026-01-15T09:00:00.000Z", updated_at: "2026-01-15T09:00:00.000Z",
    }));
    const port = claudeRunPort(x.ctx);
    const id = port.start({ title: "x", prompt: "x", folder: FOLDER, files: FILES });
    for (let i = 0; i < 100 && !x.f!.runner.calls.some((c) => c.args[0] === "-p"); i++) await new Promise((r) => setTimeout(r, 5));
    await expect(x.call("video.delete", FOLDER)).rejects.toThrow("Claude is still writing this video's script. Wait a moment, then delete it.");
    port.cancel(id);
    for (let i = 0; i < 100 && port.view(id)?.status !== "cancelled"; i++) await new Promise((r) => setTimeout(r, 5));
    await x.call("video.delete", FOLDER);
    expect(fs.existsSync(path.join(x.root, FOLDER))).toBe(false);
  });

  it("reads a stored run left active (its last save failed) as stopped, so the writer doesn't wait forever", async () => {
    const x = setup({ claude: { run: hangs() } });
    await x.consent;
    const port = claudeRunPort(x.ctx);
    const id = port.start({ title: "x", prompt: "x", folder: FOLDER, files: FILES });
    for (let i = 0; i < 100 && !x.f!.runner.calls.some((c) => c.args[0] === "-p"); i++) await new Promise((r) => setTimeout(r, 5));
    const stored = (await x.call<ClaudeRunView[]>("claude.runs")).find((r) => r.id === id)!;
    port.cancel(id);
    for (let i = 0; i < 100 && port.view(id)?.status !== "cancelled"; i++) await new Promise((r) => setTimeout(r, 5));
    saveRun(x.root, { ...stored, status: "running" });
    expect(port.view(id)).toEqual({ status: "failed", note: `Claude stopped, but ${brand.name} couldn't save how the run ended. Try again.` });
  });

  it("fails with the engine's plain message when Claude Code isn't set up", async () => {
    const x = setup({ consent: false });
    await expect(write(claudeRunWriter(claudeRunPort(x.ctx), { pollMs: 5 }), x.req)).rejects.toThrow("Set up Claude first: open Settings > Claude and read the short notice.");
  });

  it("fails when Claude finishes without writing every file", async () => {
    const x = setup({ claude: { run: writes(fileMap(FILES.slice(0, 3))) } });
    await x.consent;
    await expect(write(claudeRunWriter(claudeRunPort(x.ctx), { pollMs: 5 }), x.req)).rejects.toThrow("Claude finished but didn't write notes.md.");
  });

  it("cancels the Claude Code run when the video is cancelled", async () => {
    const x = setup({ claude: { run: hangs() } });
    await x.consent;
    const p = write(claudeRunWriter(claudeRunPort(x.ctx), { pollMs: 5 }), x.req);
    for (let i = 0; i < 100 && !x.f!.runner.calls.some((c) => c.args[0] === "-p"); i++) await new Promise((r) => setTimeout(r, 5));
    x.ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    for (let i = 0; i < 100; i++) {
      const runs = await x.call<ClaudeRunView[]>("claude.runs");
      if (runs[0]?.status === "cancelled") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await x.call<ClaudeRunView[]>("claude.runs"))[0]).toMatchObject({ action: "video_script", status: "cancelled" });
  });

  it("refuses files outside the video folder before anything runs", async () => {
    const x = setup({ claude: { run: writes(fileMap(FILES)) } });
    await x.consent;
    expect(() => claudeRunPort(x.ctx).start({ title: "x", prompt: "x", folder: FOLDER, files: ["me/identity/passport.md"] })).toThrow("A video script's files must sit directly in its video folder.");
    expect(() => claudeRunPort(x.ctx).start({ title: "x", prompt: "x", folder: "me/identity", files: ["me/identity/x.md"] })).toThrow(/isn't a plain folder/);
  });
});

describe("defaultWriter", () => {
  it("runs in the app when Claude Code is ready, and hands over to Claude Desktop when it isn't", async () => {
    expect(defaultWriter(setup({ claude: false }).ctx).mode).toBe("desktop");

    const ready = setup();
    await ready.consent;
    await ready.call("claude.engine", true);
    expect(defaultWriter(ready.ctx).mode).toBe("cli");

    const notReady = setup({ consent: false });
    await notReady.call("claude.engine", true);
    expect(defaultWriter(notReady.ctx).mode).toBe("desktop");
  });

  it("hands over to Claude Desktop when the readiness check itself fails", async () => {
    const x = setup();
    await x.consent;
    engineFor(x.ctx).state = async () => { throw new Error("probe broke at /Users/alex/secret"); };
    const p = defaultWriter(x.ctx).write(x.req);
    for (let i = 0; i < 100 && !x.host.shell.copied.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(x.host.shell.copied).toHaveLength(1);
    expect(x.f!.runner.calls.some((c) => c.args[0] === "-p")).toBe(false);
    x.ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });

  it("checks again when it writes, and falls back to the hand-off", async () => {
    const x = setup({ consent: false });
    const w = defaultWriter(x.ctx);
    const p = w.write(x.req);
    for (let i = 0; i < 100 && !x.host.shell.copied.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(x.host.shell.copied[0]).toContain(`Write these files into ${FOLDER}/`);
    x.ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(x.f!.runner.calls.some((c) => c.args[0] === "-p")).toBe(false);
  });
});

describe("candidate types: sponsorship in videos", () => {
  const BRIEF = { kind: "company" as const, company_slug: "acme-corp" };

  function briefingReq(x: ReturnType<typeof setup>, sponsorship: boolean): WriterRequest {
    const type = registryFor(x.ctx).byId("company-briefing")!;
    const folder = "companies/acme-corp/videos/briefing-1";
    return {
      root: x.root, folder, type, subject: BRIEF, options: {}, revision: null, signal: x.ac.signal, sponsorship,
      pack: buildSourcePack({ root: x.root, type, subject: BRIEF, folder, clock: x.ctx.clock(), sponsorship }),
    };
  }

  it("reads showSponsorship from the profile's work rights", () => {
    const x = setup({ claude: false });
    expect(sponsorshipFor(x.root)).toBe(true);
    for (const [status, want] of [["citizen", false], ["pr", false], ["unknown", false], ["full_visa", true], ["needs_sponsorship", true]] as const) {
      updateRecord("profile", layout(x.root).profile, (p) => { p.work_rights.status = status; });
      expect(sponsorshipFor(x.root)).toBe(want);
    }
  });

  it("keeps sponsorship out of the writer's request when it doesn't apply", () => {
    const x = setup({ claude: false });
    const on = buildWriterPrompt(briefingReq(x, true), { nonce: "n" });
    expect(on).toContain("and whether they sponsor.");
    expect(on).toContain("sponsorship evidence");
    const offReq = briefingReq(x, false);
    const off = buildWriterPrompt(offReq, { nonce: "n" });
    expect(off).toContain("what they do, how they build.");
    expect(off).toContain("Cover what they do, products, tech stack, recent news, culture, but only what the research supports.");
    expect(off).toContain("Sponsorship doesn't apply to me.");
    expect(offReq.pack.files.map((f) => f.extract).join("\n")).not.toMatch(/Sponsor status/);
    expect(off.split("\n").filter((l) => /sponsor/i.test(l))).toEqual(["- Sponsorship doesn't apply to me. Don't mention visa sponsorship, visas or work rights in the script, spec or notes, even where a rule or a file mentions them."]);
  });

  it("leaves the sponsorship mix out of the weekly recap when it doesn't apply", () => {
    const stats = {
      week: "2026-W03", from: "2026-01-12", to: "2026-01-18", found: 4, applied: 1, replies: 0, interviews: 0,
      sponsorship: { sponsorship_offered: 2, visa_ok: 1, silent: 1, citizen_pr_only: 0, clearance: 0 }, next_steps: [],
    };
    expect(recapContent(stats, "recaps/2026-W03").script).toMatch(/offer sponsorship/);
    const off = recapContent(stats, "recaps/2026-W03", { sponsorship: false });
    expect(off.script).not.toMatch(/sponsor/i);
    expect(JSON.stringify(off.spec)).not.toMatch(/sponsor/i);
  });

  it("stops a script that mentions sponsorship for a citizen, and passes the flag to the writer", async () => {
    const x = setup({ claude: false });
    updateRecord("profile", layout(x.root).profile, (p) => { p.work_rights.status = "citizen"; });
    const seen: (boolean | undefined)[] = [];
    const base = x.host.video!.writer!(x.ctx)!;
    x.host.video!.writer = () => ({
      mode: "api",
      async write(req) {
        seen.push(req.sponsorship);
        const out = await base.write(req);
        const f = path.join(req.root, req.folder, "script.txt");
        fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("Here is a short video for you.", "Here is a short video about sponsorship for you."));
        return out;
      },
    });
    const started = await x.call<{ folder: string }>("video.start", "jd-walkthrough", JOB, {});
    await videoIdle(x.ctx);
    // The first write, then a fix pass: the flag reaches both. This fake writes the same files again, so the pass
    // changed nothing and no second pass is asked for.
    expect(seen).toEqual([false, false]);
    const draft = await x.call<{ issues: { code: string; message: string }[]; can_approve: boolean }>("video.draft", started.folder);
    expect(draft.issues.filter((i) => i.code === "sponsorship").map((i) => i.message)).toEqual(["script.txt talks about visa sponsorship. It doesn't apply to you, so take it out."]);
    expect(draft.can_approve).toBe(false);
    expect(readRecord("video", path.join(x.root, started.folder, "video.json")).status).toBe("review");
  });

  async function citizenDraft(edit: (folder: string, root: string) => void) {
    const x = setup({ claude: false });
    updateRecord("profile", layout(x.root).profile, (p) => { p.work_rights.status = "citizen"; });
    const base = x.host.video!.writer!(x.ctx)!;
    x.host.video!.writer = () => ({ mode: "api", async write(req) { const out = await base.write(req); edit(req.folder, req.root); return out; } });
    const started = await x.call<{ folder: string }>("video.start", "jd-walkthrough", JOB, {});
    await videoIdle(x.ctx);
    return (await x.call<{ issues: { code: string; level: string; path: string; message: string }[] }>("video.draft", started.folder)).issues
      .filter((i) => i.code === "sponsorship" || i.code === "work_rights");
  }

  it("checks the extras too, and only warns about visa or work-rights words", async () => {
    const issues = await citizenDraft((folder, root) => {
      fs.writeFileSync(path.join(root, folder, "notes.md"), "# Notes\n\nThey sponsor 482 visas.\n");
      const s = path.join(root, folder, "script.txt");
      fs.writeFileSync(s, fs.readFileSync(s, "utf8").replace("Here is a short video for you.", "Here is a short video about full work rights."));
    });
    expect(issues).toEqual([
      { level: "warning", code: "work_rights", scene: null, path: "script.txt", message: "script.txt mentions visas or work rights. Check that it belongs in your video." },
      { level: "error", code: "sponsorship", scene: null, path: "notes.md", message: "notes.md talks about visa sponsorship. It doesn't apply to you, so take it out." },
    ]);
  });

  it("doesn't count the job title or company name as talking about sponsorship", async () => {
    const issues = await citizenDraft(() => undefined);
    expect(issues).toEqual([]);
    const named = setup({ claude: false });
    updateRecord("profile", layout(named.root).profile, (p) => { p.work_rights.status = "citizen"; });
    updateRecord("job", layout(named.root).jobFile("acme-corp", "2026-01-12-ai-engineer"), (j) => { j.title = "Sponsorship Partnerships Lead"; });
    const base = named.host.video!.writer!(named.ctx)!;
    named.host.video!.writer = () => ({ mode: "api", async write(req) {
      const out = await base.write(req);
      const s = path.join(req.root, req.folder, "script.txt");
      fs.writeFileSync(s, fs.readFileSync(s, "utf8").replace("Here is a short video for you.", "Here is a short video on the Sponsorship Partnerships Lead role."));
      return out;
    } });
    const started = await named.call<{ folder: string }>("video.start", "jd-walkthrough", JOB, {});
    await videoIdle(named.ctx);
    const d = await named.call<{ issues: { code: string }[] }>("video.draft", started.folder);
    expect(d.issues.filter((i) => i.code === "sponsorship")).toEqual([]);
  });
});

describe("videoFlow", () => {
  it("lists the registry's types and hands a request to the renderer", async () => {
    const { ctx } = setup({ claude: false });
    const flow = videoFlow({ registry: () => registryFor(ctx), open: (type, subject) => setVideoIntent(ctx, { type, subject }) });
    expect(flow.types()).toHaveLength(7);
    expect(flow.types().find((t) => t.id === "pitch")).toEqual({ id: "pitch", label: "Tell me about yourself", description: expect.any(String) });
    flow.open("pitch", "Why I fit Acme Corp");
    expect(await dispatch(ctx, "video.takeIntent", [])).toEqual({ type: "pitch", subject: "Why I fit Acme Corp" });
    expect(videoFlow({ registry: () => { throw new Error("no plugin"); } }).types()).toEqual([]);
  });
});
