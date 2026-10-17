import { describe, expect, it } from "vitest";
import { appendSearch, newJob, readRecord, layout } from "@careeros/core";
import type { ClaudeRunView } from "@careeros/contract";
import { runBoardHealth } from "../src/board-health.js";
import { handleMcp } from "../src/claude/mcp/server.js";
import { mcpSession, mcpToolsFor } from "../src/claude/mcp/tools.js";
import { openSample } from "./helpers.js";

const run = (id: string, started_at: string, ended_at: string, over: Partial<ClaudeRunView> = {}): ClaudeRunView => ({
  id, action: "find_jobs", target: { kind: "workspace" } as ClaudeRunView["target"], key: "find_jobs", status: "succeeded", started_at, ended_at,
  elapsed_ms: 0, steps: [], summary: "", files: [], missing: [], stray: [], error: "", cost_usd: null, turns: null, ...over,
});

describe("board health after a Find jobs run", () => {
  it("compares this run's searches with earlier runs' and warns about a board that returned nothing", () => {
    const { root } = openSample();
    // Two earlier runs: one with stored counts, one older record without (read from the search log in its time).
    appendSearch(root, { site: "SEEK", query: "data analyst", location: "Sampletown NSW", results: 18, at: "2026-10-10T01:05:00.000Z" });
    appendSearch(root, { site: "SEEK", query: "data analyst", location: "Sampletown NSW", results: 0, at: "2026-10-17T01:05:00.000Z" });
    appendSearch(root, { site: "LinkedIn", query: "data analyst", location: "Sampletown NSW", results: 9, at: "2026-10-17T01:06:00.000Z" });
    const now = run("r-now0001-00000001", "2026-10-17T01:00:00.000Z", "2026-10-17T01:30:00.000Z");
    const runs = [
      now,
      run("r-old0002-00000002", "2026-10-14T01:00:00.000Z", "2026-10-14T01:30:00.000Z", { board_counts: { seek: 22 } }),
      run("r-old0003-00000003", "2026-10-10T01:00:00.000Z", "2026-10-10T01:30:00.000Z"),
      run("r-old0004-00000004", "2026-10-12T01:00:00.000Z", "2026-10-12T01:30:00.000Z", { action: "score_job", board_counts: { seek: 0 } }),
    ];
    const h = runBoardHealth(root, now, runs, new Date("2026-10-17T01:31:00.000Z"));
    expect(h.counts).toEqual({ seek: 0, linkedin: 9 });
    expect(h.warnings.map((w) => w.message)).toEqual(["SEEK returned nothing this time, it usually finds about 20. Its pages may have changed."]);

    // A board Chrome stopped (a security check) is never called broken.
    const stopped = { ...now, browser_diag: [{ board: "seek" as const, diag: { mode: "profile" as const, profile_dir: "Default", outcome: "bot_check" as const, launched: false, tries: 1, ms: 10 } }] };
    expect(runBoardHealth(root, stopped, runs, new Date("2026-10-17T01:31:00.000Z")).warnings).toEqual([]);
  });

  it("reads the jobs saved during the run for junk titles", () => {
    const { root } = openSample();
    const at = new Date("2026-10-17T01:10:00.000Z");
    for (const t of ["<div>Analyst</div>", "Data &amp; AI Lead", "<b>Engineer</b>"]) newJob(root, { company: "Acme Corp", title: t, source: "browser", source_site: "SEEK" }, { now: at });
    const now = run("r-now0001-00000001", "2026-10-17T01:00:00.000Z", "2026-10-17T01:30:00.000Z");
    const h = runBoardHealth(root, now, [now], new Date("2026-10-17T01:31:00.000Z"));
    expect(h.warnings).toEqual([expect.objectContaining({ board: "seek", kind: "junk" })]);
  });
});

describe("job_new's closing date", () => {
  it("saves the closing date Claude passes, as a date", () => {
    const { root } = openSample();
    const res = handleMcp(mcpSession(root, mcpToolsFor("find_jobs")), {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "job_new", arguments: { company: "Example Labs", title: "Data Engineer", url: "https://jobs.example.com/labs/9", location: "Sampletown NSW", closes: "2026-11-30" } },
    }) as { result: { content: { text: string }[] } };
    const made = JSON.parse(res.result.content[0]!.text) as { company_slug: string; id: string };
    expect(readRecord("job", layout(root).jobFile(made.company_slug, made.id)).closes_on).toBe("2026-11-30");
  });
});
