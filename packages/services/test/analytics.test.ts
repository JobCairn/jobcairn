import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layout } from "@careeros/core";
import { analyticsInputs, homeGoals, searchLog } from "../src/analytics.js";
import { readHandlers as R } from "../src/read.js";
import { settingsHandlers as S } from "../src/settings.js";
import { openSample } from "./helpers.js";

describe("home analytics inputs", () => {
  it("reads every timeline event with its job, the search log and blank goals", () => {
    const { root } = openSample();
    const x = analyticsInputs(root);
    expect(x.events).toContainEqual({ company_slug: "acme-corp", job_id: "2026-01-12-ai-engineer", at: "2026-01-13T09:00:00.000Z", event: "Status: Applied" });
    expect(x.searches).toEqual([{ at: "2026-01-12T09:00:00.000Z", site: "Greenhouse", results: "12", kept: "1" }]);
    expect(x.goals).toEqual({ search_deadline: "", weekly_goal: null });
  });

  it("feeds Home: funnel, sources and salary check come from the workspace", () => {
    const { ctx } = openSample();
    const a = R["home.summary"](ctx).analytics;
    expect(a.funnel.stages.map((s) => s.reached)).toEqual([3, 1, 1, 1, 0, 0]);
    expect(a.sources.find((s) => s.site === "Greenhouse")).toEqual({ site: "Greenhouse", seen: 12, searches: 1, kept: 1, applied: 1 });
    expect(a.salary.specialist.count + a.salary.core.count).toBe(1); // Acme Corp: $140k-$160k
    expect(a.today.readySponsored).toBe(0); // Acme Corp is already applied for
  });

  it("saves the deadline and weekly goal through Settings and Home counts down", () => {
    const { ctx, root } = openSample();
    S["settings.save"](ctx, "search", [{ path: "search_deadline", value: "2026-02-24" }, { path: "weekly_goal", value: 5 }]);
    expect(homeGoals(root)).toEqual({ search_deadline: "2026-02-24", weekly_goal: 5 });
    const a = R["home.summary"](ctx).analytics;
    expect(a.today).toMatchObject({ searchDeadline: "2026-02-24", deadlineDays: 40 });
    expect(a.weeklyGoal).toBe(5);
    expect(() => S["settings.save"](ctx, "search", [{ path: "search_deadline", value: "next month" }])).toThrow();
  });

  it("rejects a search deadline that is not a real calendar date", () => {
    const { ctx, root } = openSample();
    for (const value of ["2026-13-45", "2026-02-30"]) {
      expect(() => S["settings.save"](ctx, "search", [{ path: "search_deadline", value }])).toThrow(/real date/);
    }
    expect(homeGoals(root).search_deadline).toBe("");
    S["settings.save"](ctx, "search", [{ path: "search_deadline", value: "" }]);
    expect(homeGoals(root).search_deadline).toBe("");
  });

  it("ignores an impossible deadline already in the settings file", () => {
    const { root } = openSample();
    const L = layout(root);
    const cur = JSON.parse(fs.readFileSync(L.search, "utf8"));
    fs.writeFileSync(L.search, JSON.stringify({ ...cur, search_deadline: "2026-02-30" }));
    expect(homeGoals(root).search_deadline).toBe("");
  });

  it("copes with a missing search log and an unreadable search settings file", () => {
    const { root } = openSample();
    const L = layout(root);
    fs.writeFileSync(L.search, "{ not json");
    expect(homeGoals(root)).toEqual({ search_deadline: "", weekly_goal: null });
    for (const f of fs.readdirSync(path.dirname(L.search))) if (/search/i.test(f) && /\.(md|csv|jsonl)$/.test(f)) fs.rmSync(path.join(path.dirname(L.search), f));
    expect(Array.isArray(searchLog(root))).toBe(true);
  });
});
