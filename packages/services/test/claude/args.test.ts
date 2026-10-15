import { describe, expect, it } from "vitest";
import { ACTION_IDS, ACTIONS, actionPaths, claudeWrites, LOCKABLE_DIRS, ownTarget, PLUGIN_SKILLS, type ActionId, type ActionTarget } from "@careeros/contract";
import { assertRuleFolder, claudeArgs, inboxSuggestPlan, mcpConfig, NON_INTERACTIVE, testArgs, toolArgs, WEB_ACTIONS, type RunPlace } from "../../src/claude/args.js";
import { mcpToolsFor } from "../../src/claude/mcp/tools.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const PLACE: RunPlace = { root: "/work/CareerOS", pluginDir: "/apps/careeros/plugin", mcp: { command: "/apps/careeros/CareerOS", args: ["/apps/careeros/mcp.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } } };

const TARGETS: Record<string, ActionTarget> = {
  workspace: { kind: "workspace" },
  company: { kind: "company", company_slug: "acme-corp" },
  job: { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" },
  topic: { kind: "topic", topic: "kubernetes", label: "Kubernetes", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" },
  resume_variant: { kind: "resume_variant", variant: "backend-heavy", label: "Backend-heavy" },
};
const NOW = "2026-01-15T09:00:00.000Z";

function argsFor(id: ActionId, locked: readonly string[] = LOCKABLE_DIRS) {
  const t = ownTarget(id, TARGETS[ACTIONS[id].target]!);
  const { folder, outputs, extras } = actionPaths(id, t, { now: NOW, n: 1, title: "AI Engineer", company: "Acme Corp" });
  const files = ACTIONS[id].group === "video" ? undefined : [...outputs, ...extras];
  return { folder, files, args: claudeArgs({ action: id, folder, files, web: WEB_ACTIONS.includes(id), mcp: mcpToolsFor(id), job: t.kind === "job" ? { company_slug: t.company_slug, id: t.id } : null }, locked, PLACE) };
}

/** The values after a variadic flag, up to the next flag. */
function after(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j]!.startsWith("--"); j++) out.push(args[j]!);
  return out;
}

const RULE = /^(Edit|Write)\((.*)\)$/;
/** What every run with the plugin gets: its skills by name, and read-only access to the plugin's folder. */
const SKILL_RULES = [...PLUGIN_SKILLS.map((k) => `Skill(careeros:${k})`), "Read(//apps/careeros/plugin/**)"];

describe("per-action permissions", () => {
  for (const id of ACTION_IDS.filter(claudeWrites)) {
    it(`${id}: writes only in its own folder, no shell at all, no locked folders`, () => {
      const { folder, files, args } = argsFor(id);
      const allowed = after(args, "--allowedTools");
      const writes = allowed.filter((a) => RULE.test(a) || a === "Edit" || a === "Write");
      expect(writes).toEqual(files ? files.map((f) => `Edit(./${f})`) : [`Edit(./${folder}/**)`]);
      for (const w of writes) expect(w.startsWith(`Edit(./${folder}/`)).toBe(true);
      expect(allowed.filter((a) => /bash|powershell|repl/i.test(a))).toEqual([]);
      expect(after(args, "--tools")[0]!.split(",").filter((t) => /bash|powershell|repl/i.test(t))).toEqual([]);
      expect(allowed.filter((a) => a.startsWith("mcp__"))).toEqual(mcpToolsFor(id).map((t) => `mcp__careeros__${t}`));
      for (const a of allowed) for (const d of LOCKABLE_DIRS) expect(a).not.toContain(d);
      expect(allowed.some((a) => a === "Glob" || a === "Grep" || a === "Read")).toBe(false);
      const web = allowed.includes("WebFetch") || allowed.includes("WebSearch");
      expect(web).toBe(WEB_ACTIONS.includes(id));
      expect(after(args, "--tools")[0]!.includes("Web")).toBe(WEB_ACTIONS.includes(id));
      // The locked folders are denied for reading and writing whatever the action.
      const denied = after(args, "--disallowedTools");
      for (const d of LOCKABLE_DIRS) {
        expect(denied).toContain(`Read(./${d}/**)`);
        expect(denied).toContain(`Edit(./${d}/**)`);
      }
      for (const d of ["me", "settings", ".careeros", ".claude"]) expect(denied).toContain(`Edit(./${d}/**)`);
      expect(args).toContain("dontAsk");
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as { disableAllHooks: boolean; permissions: Record<string, unknown> };
      expect(settings).toEqual({ disableAllHooks: true, permissions: { blockReadsOutsideWorkingDirectories: true, defaultMode: "dontAsk", allow: allowed, deny: denied } });
      // Isolated from the person's own Claude Code setup (R2).
      for (const f of ["--restricted", "--strict-mcp-config", "--no-session-persistence"]) expect(args).toContain(f);
      expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
      expect(args[args.indexOf("--plugin-dir") + 1]).toBe(PLACE.pluginDir);
      expect(args).not.toContain("--setting-sources");
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("bypassPermissions");
    });
  }

  it("snapshot: tailor_application", () => {
    expect(argsFor("tailor_application").args).toMatchSnapshot();
  });
  it("snapshot: research_company (web tools)", () => {
    expect(argsFor("research_company").args).toMatchSnapshot();
  });
  it("snapshot: a video action", () => {
    expect(argsFor("pitch_video").args).toMatchSnapshot();
  });

  it("with a folder unlocked by a grant, still never lets Claude write in it", () => {
    const { args } = argsFor("score_job", []);
    const denied = after(args, "--disallowedTools");
    expect(denied).toContain("Edit(./me/**)");
    expect(denied).not.toContain("Read(./me/identity/**)");
  });

  it("refuses folders that could break out of a rule or reach a locked or internal folder", () => {
    for (const bad of ["../x", "a/../b", "/abs", "a)/**", "a*", "me/identity", "me/identity/x", "me", ".careeros/x", "settings", "a\\b", "x/.hidden", ""]) {
      expect(() => assertRuleFolder(bad), bad).toThrow();
      expect(() => toolArgs({ folder: bad, web: false, mcp: [] }, [])).toThrow();
    }
    expect(() => assertRuleFolder("companies/acme-corp/jobs/2026-01-12-ai-engineer/application")).not.toThrow();
  });

  it("lets only rewrite_resume write its own declared file in application/.studio, and nothing else in a dot folder", () => {
    const APP = "companies/acme-corp/jobs/2026-01-12-ai-engineer/application";
    const SUG = `${APP}/.studio/resume.suggested.md`;
    const t = toolArgs({ action: "rewrite_resume", folder: APP, files: [SUG], web: false, mcp: [] }, []);
    expect(t.allowed.filter((a) => a.startsWith("Edit"))).toEqual([`Edit(./${SUG})`]);
    for (const d of [".careeros", ".claude", ".index", ".backup", ".git"]) expect(t.denied).toContain(`Edit(./${d}/**)`);
    // Another action, no action, another file, the folder itself, or a path that climbs out: refused.
    expect(() => toolArgs({ action: "tailor_application", folder: APP, files: [SUG], web: false, mcp: [] }, [])).toThrow();
    expect(() => toolArgs({ folder: APP, files: [SUG], web: false, mcp: [] }, [])).toThrow();
    expect(() => toolArgs({ action: "rewrite_resume", folder: APP, files: [`${APP}/.studio/other.md`], web: false, mcp: [] }, [])).toThrow();
    expect(() => toolArgs({ action: "rewrite_resume", folder: `${APP}/.studio`, web: false, mcp: [] }, [])).toThrow();
    expect(() => toolArgs({ action: "rewrite_resume", folder: APP, files: [`${APP}/.studio/../../x/resume.suggested.md`], web: false, mcp: [] }, [])).toThrow();
    for (const bad of [`${APP}/.git/resume.suggested.md`, `${APP}/.careeros/resume.suggested.md`, ".studio/resume.suggested.md"]) {
      expect(() => assertRuleFolder(bad, [bad]), bad).toThrow();
    }
  });

  it("a company action can write only its research and contacts files, not the company's job folders", () => {
    const { args } = argsFor("research_company");
    const allowed = after(args, "--allowedTools");
    expect(allowed.filter((a) => a.startsWith("Edit"))).toEqual(["Edit(./companies/acme-corp/research.md)", "Edit(./companies/acme-corp/contacts.json)"]);
    expect(() => toolArgs({ folder: "companies/a", files: ["companies/b/x.md"], web: false, mcp: [] }, [])).toThrow();
  });

  it("every run with the plugin can load only its skills and read (never edit) the plugin folder; a drop box look can't", () => {
    for (const id of ACTION_IDS.filter(claudeWrites)) {
      const { args } = argsFor(id);
      expect(after(args, "--tools")[0]!.split(","), id).toContain("Skill");
      expect(args[args.indexOf("--add-dir") + 1], id).toBe(PLACE.pluginDir);
      expect(after(args, "--allowedTools"), id).toEqual(expect.arrayContaining(SKILL_RULES));
      expect(after(args, "--allowedTools").filter((a) => a.startsWith("Skill")), id).toEqual(SKILL_RULES.filter((r) => r.startsWith("Skill")));
      expect(after(args, "--disallowedTools"), id).toContain("Edit(//apps/careeros/plugin/**)");
      expect(args[args.indexOf("--append-system-prompt") + 1], id).toContain("load it with the Skill tool as careeros:<name>");
    }
    const ask = claudeArgs(inboxSuggestPlan(".careeros/tmp/ask-0123abcd/document.pdf", "/work/CareerOS/.careeros/tmp/ask-0123abcd"), LOCKABLE_DIRS, PLACE);
    expect(after(ask, "--tools")[0]!.split(",")).toEqual(["Read"]);
    expect(ask).not.toContain("--add-dir");
    expect(toolArgs(inboxSuggestPlan(".careeros/tmp/ask-0123abcd/document.pdf", "/x"), LOCKABLE_DIRS, PLACE.pluginDir).allowed.some((a) => a.startsWith("Skill"))).toBe(false);
    expect(testArgs()).not.toContain("--add-dir");
  });

  it("puts the prompt on stdin, not in the arguments", () => {
    const { args } = argsFor("score_job");
    expect(args[0]).toBe("-p");
    expect(args.some((a) => a.includes(`${brand.name} request`))).toBe(false);
  });

  it("the setup test has no tools, no MCP and no plugin, and is isolated too", () => {
    const a = testArgs();
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a).not.toContain("--allowedTools");
    for (const f of ["--restricted", "--strict-mcp-config"]) expect(a).toContain(f);
    for (const f of ["--mcp-config", "--plugin-dir"]) expect(a).not.toContain(f);
    expect(JSON.parse(a[a.indexOf("--settings") + 1]!).disableAllHooks).toBe(true);
  });

  it("gives the MCP server only this workspace and this action's tools", () => {
    const { args } = argsFor("find_jobs");
    const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    expect(Object.keys(cfg.mcpServers)).toEqual(["careeros"]);
    const s = cfg.mcpServers.careeros!;
    expect(s.command).toBe(PLACE.mcp.command);
    expect(s.args).toEqual([...PLACE.mcp.args, "--tools", "search_check,search_add,job_new,request_access"]);
    expect(s.env).toEqual({ ELECTRON_RUN_AS_NODE: "1", CAREEROS_WORKSPACE: PLACE.root });
    expect(JSON.parse(mcpConfig(PLACE, ["request_access"])).mcpServers.careeros.args.at(-1)).toBe("request_access");
  });

  it("web runs (F2) read no workspace file at all; workspace runs have no web tools", () => {
    for (const id of WEB_ACTIONS) {
      const { args, files } = argsFor(id);
      const tools = after(args, "--tools")[0]!.split(",");
      // Read is there only for the skills' reference files in the plugin folder: every workspace read is denied.
      expect(tools.filter((t) => ["Read", "Glob", "Grep"].includes(t)), id).toEqual(["Read"]);
      expect(tools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
      const allowed = after(args, "--allowedTools");
      // No workspace reads: the only readable folder is the app's own plugin (skill reference files).
      expect(allowed.filter((a) => a.startsWith("Read"))).toEqual(["Read(//apps/careeros/plugin/**)"]);
      expect(allowed.filter((a) => a.startsWith("Edit"))).toEqual(files!.map((f) => `Edit(./${f})`));
      const denied = after(args, "--disallowedTools");
      for (const d of ["Read(./me/**)", "Read(./settings/**)", "Read(./inbox/**)", "Grep", "Glob", "Read(./.backup/**)"]) expect(denied, `${id} ${d}`).toContain(d);
      // Never a blanket Read deny: Claude Code checks Write against Read deny rules, so it refused the run's own output.
      expect(denied, id).not.toContain("Read(./**)");
      for (const f of files!) expect(denied.filter((d) => d.startsWith("Read(./") && f.startsWith(d.slice(7, -4))), `${id} ${f}`).toEqual([]);
      expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("can't read files in the workspace");
    }
    for (const id of ACTION_IDS.filter(claudeWrites).filter((i) => !WEB_ACTIONS.includes(i))) {
      const { args } = argsFor(id);
      expect(after(args, "--tools")[0], id).not.toMatch(/Web/);
      expect(after(args, "--allowedTools")).toContain("Read(./**)");
      const denied = after(args, "--disallowedTools");
      expect(denied).not.toContain("Read(./**)");
      for (const d of ["Read(./.backup/**)", "Read(./.index/**)", "Read(./me/identity/**)", "Read(./me/employment/**)"]) expect(denied, `${id} ${d}`).toContain(d);
    }
  });

  it("study_topic is a web run (ruling 2026-10-10): web tools to check sources, no workspace reads, writes only guide.md", () => {
    expect(WEB_ACTIONS).toContain("study_topic");
    const { args } = argsFor("study_topic");
    const tools = after(args, "--tools")[0]!.split(",");
    expect(tools.sort()).toEqual(["Edit", "Read", "Skill", "WebFetch", "WebSearch", "Write"]);
    const allowed = after(args, "--allowedTools");
    expect(allowed).toEqual(["Edit(./learning/kubernetes/guide.md)", "mcp__careeros__request_access", "WebSearch", "WebFetch", ...SKILL_RULES]);
    const denied = after(args, "--disallowedTools");
    for (const d of ["Read(./me/**)", "Grep", "Glob", "Edit(./me/**)"]) expect(denied).toContain(d);
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("can't read files in the workspace");
  });

  it("pins job_event to the run's own job (F3)", () => {
    const cfg = (job: { company_slug: string; id: string } | null, tools = mcpToolsFor("score_job")) =>
      (JSON.parse(mcpConfig(PLACE, tools, job)) as { mcpServers: { careeros: { args: string[] } } }).mcpServers.careeros.args;
    expect(cfg({ company_slug: "acme-corp", id: "2026-01-12-ai-engineer" }).slice(-2)).toEqual(["--job", "acme-corp/2026-01-12-ai-engineer"]);
    expect(cfg(null)).not.toContain("--job");
    expect(cfg({ company_slug: "acme-corp", id: "x" }, ["request_access"])).not.toContain("--job");
    expect(cfg({ company_slug: "acme-corp", id: "x" }, ["score_record", "request_access"]).slice(-2)).toEqual(["--job", "acme-corp/x"]);
  });

  it("tells Claude which tool replaces each careeros command, with no person's text in it", () => {
    const t = NON_INTERACTIVE("companies/acme-corp/jobs/x", mcpToolsFor("score_job"));
    expect(t).toContain("careeros job event is job_event");
    expect(t).toContain("no command line");
    expect(t).not.toContain("search_add");
    // score_record has no command-line twin, so no made-up command is named for it.
    expect(t).not.toMatch(/is score_record|undefined/);
  });
});
