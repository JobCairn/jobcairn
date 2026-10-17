import { describe, expect, it } from "vitest";
import {
  ACTIONS, actionKey, actionPaths, actionsFor, buildActionPrompt, escapeHtml, parseResearchReport, readResearchReport, REPORT_JSON_MAX,
  researchHtml, researchMeta, researchRequest, researchStale, researchTextHtml, RESEARCH_CSP, safeHref, validateArgs, WEB_ACTION_IDS,
  type ResearchReport,
} from "../src/index.js";

const REPORT: ResearchReport = {
  schema: 1, title: "Example topic", as_of: "2026-10-17", summary: "A short summary (example data).",
  changes_often: "Rounds change often.", confidence: "medium",
  key_facts: [{ label: "Rounds", value: "Every two weeks", detail: "Example detail", sources: [1] }],
  sections: [{ heading: "What it is", paragraphs: ["One paragraph."], bullets: ["One bullet"], sources: [1, 2] }],
  steps: [{ title: "Make a profile", detail: "Fill it in.", duration: "1 week", sources: [1] }],
  tables: [{ title: "Compare", columns: ["Thing", "A", "B"], rows: [["Speed", "Fast", "Slow"]], sources: [2] }],
  charts: [{ title: "Example bars", unit: "points", bars: [{ label: "One", value: 10 }, { label: "Two", value: 20 }], sources: [2] }],
  uncertain: ["Something unconfirmed."],
  sources: [
    { id: 1, title: "Official page", url: "https://example.org/official", publisher: "Example Department", accessed: "2026-10-17", official: true },
    { id: 2, title: "Other page", url: "https://example.com/other", accessed: "2026-10-16" },
  ],
};
const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(REPORT)) as Record<string, unknown>;

describe("report.json check", () => {
  it("accepts a full report and ignores extra keys", () => {
    const r = parseResearchReport({ ...clone(), extra: "ignored", sections: [{ ...REPORT.sections![0], color: "red" }] });
    expect(r.problems).toEqual([]);
    expect(r.report?.title).toBe("Example topic");
    expect(r.report).not.toHaveProperty("extra");
    expect(r.report?.sections?.[0]).not.toHaveProperty("color");
  });
  it("accepts the smallest report", () => {
    const r = parseResearchReport({ schema: 1, title: "T", as_of: "2026-01-01", summary: "S", sources: [REPORT.sources[0]] });
    expect(r.report).not.toBeNull();
  });
  it("refuses non-https and scripted source links", () => {
    for (const url of ["javascript:alert(1)", "http://example.org/", "data:text/html,x", "https://user:pw@example.org/"]) {
      const raw = clone();
      (raw.sources as { url: string }[])[0]!.url = url;
      expect(parseResearchReport(raw).report, url).toBeNull();
    }
  });
  it("refuses footnotes to sources that aren't listed, and duplicate ids", () => {
    const raw = clone();
    (raw.key_facts as { sources: number[] }[])[0]!.sources = [9];
    expect(parseResearchReport(raw).problems.join(" ")).toMatch(/cites source 9/);
    const dup = clone();
    (dup.sources as { id: number }[])[1]!.id = 1;
    expect(parseResearchReport(dup).report).toBeNull();
  });
  it("refuses long text, bad dates, odd rows, too many bars and non-finite numbers", () => {
    const long = clone(); long.summary = "x".repeat(2001);
    const badDate = clone(); badDate.as_of = "17/10/2026";
    const row = clone(); (row.tables as { rows: string[][] }[])[0]!.rows = [["a", "b"]];
    const bars = clone(); (bars.charts as { bars: unknown[] }[])[0]!.bars = Array.from({ length: 13 }, (_x, i) => ({ label: `b${i}`, value: i }));
    const inf = clone(); (inf.charts as { bars: { value: unknown }[] }[])[0]!.bars[0]!.value = Number.POSITIVE_INFINITY;
    const neg = clone(); (neg.charts as { bars: { value: unknown }[] }[])[0]!.bars[0]!.value = -1;
    const text = clone(); (text.charts as { bars: { value: unknown }[] }[])[0]!.bars[0]!.value = "10";
    for (const [name, raw] of Object.entries({ long, badDate, row, bars, inf, neg, text })) expect(parseResearchReport(raw).report, name).toBeNull();
  });
  it("reads report.json text: broken JSON and huge files are problems, not throws", () => {
    expect(readResearchReport("{not json").problems).toEqual(["report.json isn't valid JSON"]);
    expect(readResearchReport(" ".repeat(REPORT_JSON_MAX + 1)).problems).toEqual(["report.json is too large"]);
    expect(readResearchReport(`﻿${JSON.stringify(REPORT)}`).report?.title).toBe("Example topic");
    expect(parseResearchReport({ ...clone(), __proto__: { polluted: true } }).report).not.toBeNull();
  });
});

describe("topic helpers", () => {
  it("is stale after 30 days", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    expect(researchStale("2026-09-16T00:00:00Z", now)).toBe(true);
    expect(researchStale("2026-09-18T00:00:00Z", now)).toBe(false);
    expect(researchStale("", now)).toBe(false);
  });
  it("reads topic.json defensively", () => {
    expect(researchMeta({ title: "Express Entry <b>", questions: "Q?", depth: "thorough", created_at: "2026-10-01T00:00:00Z" }, "x"))
      .toEqual({ title: "Express Entry b", questions: "Q?", depth: "thorough", created_at: "2026-10-01T00:00:00Z" });
    expect(researchMeta(null, "skilled-visa")).toEqual({ title: "skilled visa", questions: "", depth: "quick", created_at: "" });
  });
  it("refreshes with the saved questions and depth", () => {
    expect(researchRequest({ questions: " What scores? ", depth: "thorough" })).toEqual({ options: { depth: "thorough" }, note: "What scores?" });
  });
});

describe("research_topic action", () => {
  const t = { kind: "research" as const, topic: "express-entry-in-canada", label: "Express Entry in Canada" };
  const info = { now: "2026-10-17T01:00:00.000Z" };
  it("is a web run on the Research screen only, writing report.md and report.json", () => {
    expect(WEB_ACTION_IDS).toContain("research_topic");
    expect(ACTIONS.research_topic.surface).toBe("research");
    expect(actionsFor("research")).not.toContain("research_topic");
    expect(actionPaths("research_topic", t, info).outputs).toEqual(["research/express-entry-in-canada/report.md", "research/express-entry-in-canada/report.json"]);
    expect(actionKey("research_topic", t)).toBe("research_topic--research-express-entry-in-canada");
  });
  it("asks for official sources, citations, the as-of date, the JSON shape and no advice", () => {
    const p = buildActionPrompt("research_topic", t, info, { options: { depth: "thorough" }, note: "What score do I need?" }, "0123456789abcdef");
    expect(p).toContain('Research topic: "Express Entry in Canada" (folder research/express-entry-in-canada).');
    expect(p).toContain("As of 2026-10-17");
    expect(p).toMatch(/official sources/i);
    expect(p).toMatch(/never tell me what to do about my own visa/);
    expect(p).toContain('"sources": [{"id": 1');
    expect(p).toContain("Be thorough");
    expect(p).toContain("NOTE-0123456789abcdef START\nWhat score do I need?");
    expect(p).toContain("- research/express-entry-in-canada/report.json");
    expect(p).not.toContain("me/history or me/resumes. If evidence");
  });
  it("checks the target and the bridge calls at the boundary", () => {
    expect(() => validateArgs("claude.run", ["research_topic", { kind: "research", topic: "../me", label: "x" }, {}])).toThrow();
    expect(() => validateArgs("claude.run", ["research_topic", { kind: "research", topic: "ok", label: "Bad <label>" }, {}])).toThrow();
    expect(validateArgs("claude.run", ["research_topic", t, {}])).toBeTruthy();
    expect(() => validateArgs("research.create", ["Topic", "", "deep"])).toThrow();
    expect(() => validateArgs("research.get", ["../x"])).toThrow();
    expect(validateArgs("research.create", ["Skilled visa 482 vs 186", "Which is faster?\nAnd cheaper?", "quick"])).toHaveLength(3);
  });
});

describe("Export HTML", () => {
  const nasty: ResearchReport = {
    ...REPORT, title: '"><script>alert(1)</script>', summary: "<img src=x onerror=alert(1)> & 'quotes'",
    key_facts: [{ label: "<b>", value: "</style><script>x</script>" }],
    sources: [{ id: 1, title: "<a href=javascript:alert(1)>x</a>", url: "https://example.org/a?q=\"><script>", accessed: "2026-10-17" }, REPORT.sources[1]!],
  };
  const html = researchHtml(nasty, { madeAt: "17 Oct 2026", product: "App" });
  it("escapes every value and has no scripts or event handlers", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
    expect(html).not.toMatch(/<[^>]*javascript:/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&#39;quotes&#39;");
  });
  it("is self-contained with a strict CSP and https links only", () => {
    expect(html).toContain(`content="${RESEARCH_CSP}"`);
    expect(html).not.toMatch(/<link|@import|url\(/i);
    for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1]!.startsWith("https://") || m[1]!.startsWith("#source-")).toBe(true);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("not legal, migration, tax or financial advice");
  });
  it("draws bars scaled to the largest value", () => {
    const h = researchHtml(REPORT, { madeAt: "x", product: "App" });
    expect(h).toContain("width: 50%");
    expect(h).toContain("width: 100%");
  });
  it("exports report.md as escaped text when report.json can't be used", () => {
    const h = researchTextHtml("T", "# Hi <script>", { madeAt: "x", product: "App" });
    expect(h).toContain("# Hi &lt;script&gt;");
    expect(h).not.toMatch(/<script/i);
  });
  it("escapes and checks links", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("http://example.org")).toBeNull();
    expect(safeHref("https://example.org/x")).toBe("https://example.org/x");
  });
});
