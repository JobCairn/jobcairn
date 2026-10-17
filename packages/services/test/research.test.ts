import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResearchReport, ResearchTopic, ResearchView, TrashItem } from "@careeros/contract";
import { areasFor } from "../src/watcher.js";
import { webContext } from "../src/claude/context.js";
import { dispatch } from "../src/dispatch.js";
import { openSample } from "./helpers.js";

const REPORT: ResearchReport = {
  schema: 1, title: "Example topic", as_of: "2026-01-15", summary: "Example summary.",
  key_facts: [{ label: "Rounds", value: "Every two weeks", sources: [1] }],
  sources: [{ id: 1, title: "Example official page", url: "https://example.org/page", accessed: "2026-01-15", official: true }],
};

function setup() {
  const s = openSample();
  const call = <T>(m: string, ...args: unknown[]) => dispatch(s.ctx, m, args) as Promise<T>;
  const dir = (slug: string) => path.join(s.root, "research", slug);
  return { ...s, call, dir };
}

describe("Research: topics", () => {
  it("makes a topic folder with topic.json, deduping the slug, and lists it before and after Claude writes", async () => {
    const x = setup();
    expect(await x.call<ResearchTopic[]>("research.list")).toEqual([]);
    const t = await x.call<ResearchTopic>("research.create", "Express Entry in Canada", "What score do I need?", "thorough");
    expect(t).toMatchObject({ slug: "express-entry-in-canada", title: "Express Entry in Canada", questions: "What score do I need?", depth: "thorough", at: "", stale: false });
    expect(JSON.parse(fs.readFileSync(path.join(x.dir(t.slug), "topic.json"), "utf8"))).toEqual({
      title: "Express Entry in Canada", questions: "What score do I need?", depth: "thorough", created_at: "2026-01-15T09:00:00.000Z",
    });
    expect((await x.call<ResearchTopic>("research.create", "Express Entry in Canada", "", "quick")).slug).toBe("express-entry-in-canada-2");

    fs.writeFileSync(path.join(x.dir(t.slug), "report.md"), "# Express Entry\n\nAs of 2026-01-15\n");
    fs.writeFileSync(path.join(x.dir(t.slug), "report.json"), JSON.stringify(REPORT));
    const list = await x.call<ResearchTopic[]>("research.list");
    expect(list.map((r) => r.slug)).toEqual(["express-entry-in-canada", "express-entry-in-canada-2"]);
    expect(list[0]).toMatchObject({ as_of: "2026-01-15", stale: false });
    expect(list[0]!.at).not.toBe("");
  });

  it("saves new questions and depth for Refresh", async () => {
    const x = setup();
    const t = await x.call<ResearchTopic>("research.create", "Skilled visa 482 vs 186", "", "quick");
    const u = await x.call<ResearchTopic>("research.update", t.slug, "Which is faster?", "thorough");
    expect(u).toMatchObject({ title: "Skilled visa 482 vs 186", questions: "Which is faster?", depth: "thorough" });
  });

  it("refuses an empty topic, an unknown topic and a linked research folder", async () => {
    const x = setup();
    await expect(x.call("research.create", "   ", "", "quick")).rejects.toThrow();
    await expect(x.call("research.get", "nothing-here")).rejects.toThrow(/isn't there any more/);
    fs.mkdirSync(path.join(x.root, "elsewhere"));
    fs.symlinkSync(path.join(x.root, "elsewhere"), path.join(x.root, "research"));
    await expect(x.call("research.create", "Topic", "", "quick")).rejects.toThrow(/isn't a real folder|plain folder/);
    await expect(x.call("research.list")).rejects.toThrow(/plain folder/);
  });
});

describe("Research: one report", () => {
  it("returns the checked report, or report.md with the reasons when report.json fails", async () => {
    const x = setup();
    const t = await x.call<ResearchTopic>("research.create", "Example topic", "", "quick");
    let v = await x.call<ResearchView>("research.get", t.slug);
    expect(v).toMatchObject({ report: null, markdown: null, problems: [], exports: { html: null, pdf: null } });

    fs.writeFileSync(path.join(x.dir(t.slug), "report.md"), "# Example\n");
    fs.writeFileSync(path.join(x.dir(t.slug), "report.json"), JSON.stringify(REPORT));
    v = await x.call<ResearchView>("research.get", t.slug);
    expect(v.report?.title).toBe("Example topic");
    expect(v.markdown).toBe("# Example\n");

    const bad = { ...REPORT, sources: [{ ...REPORT.sources[0], url: "javascript:alert(1)" }] };
    fs.writeFileSync(path.join(x.dir(t.slug), "report.json"), JSON.stringify(bad));
    v = await x.call<ResearchView>("research.get", t.slug);
    expect(v.report).toBeNull();
    expect(v.problems.join(" ")).toMatch(/https/);
    expect(v.markdown).toBe("# Example\n");
  });

  it("doesn't follow a linked report file", async () => {
    const x = setup();
    const t = await x.call<ResearchTopic>("research.create", "Example topic", "", "quick");
    fs.writeFileSync(path.join(x.root, "outside.md"), "secret");
    fs.symlinkSync(path.join(x.root, "outside.md"), path.join(x.dir(t.slug), "report.md"));
    const v = await x.call<ResearchView>("research.get", t.slug);
    expect(v.markdown).toBeNull();
    expect(v.topic.at).toBe("");
  });

  it("exports a self-contained HTML file and a PDF into the topic's folder", async () => {
    const x = setup();
    const t = await x.call<ResearchTopic>("research.create", "Example topic", "", "quick");
    await expect(x.call("research.exportHtml", t.slug)).rejects.toThrow(/hasn't written/);
    fs.writeFileSync(path.join(x.dir(t.slug), "report.md"), "# Example\n");
    fs.writeFileSync(path.join(x.dir(t.slug), "report.json"), JSON.stringify({ ...REPORT, title: "<script>x</script>" }));
    expect(await x.call<string>("research.exportHtml", t.slug)).toBe(`research/${t.slug}/report.html`);
    const html = fs.readFileSync(path.join(x.dir(t.slug), "report.html"), "utf8");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toMatch(/<script/i);
    expect(await x.call<string>("research.exportPdf", t.slug)).toBe(`research/${t.slug}/report.pdf`);
    expect(fs.readFileSync(path.join(x.dir(t.slug), "report.pdf"), "utf8")).toMatch(/^%PDF/);
    expect((await x.call<ResearchView>("research.get", t.slug)).exports).toEqual({ html: `research/${t.slug}/report.html`, pdf: `research/${t.slug}/report.pdf` });
  });
});

describe("Research: delete, refresh and Claude's context", () => {
  it("moves a topic to Recently deleted and puts it back", async () => {
    const x = setup();
    const t = await x.call<ResearchTopic>("research.create", "Example topic", "", "quick");
    const [item] = await x.call<TrashItem[]>("trash.move", [{ kind: "research", topic: t.slug }]);
    expect(item).toMatchObject({ kind: "research", title: "Example topic" });
    expect(fs.existsSync(x.dir(t.slug))).toBe(false);
    await x.call("trash.restore", item!.id);
    expect(fs.existsSync(path.join(x.dir(t.slug), "topic.json"))).toBe(true);
  });

  it("refreshes Research when files under research/ change", () => {
    expect(areasFor(["research/example/report.md"])).toContain("learn");
  });

  it("gives Claude the topic and today's date, and no file paths", () => {
    const x = setup();
    const c = webContext(x.root, "research_topic", { kind: "research", topic: "example", label: "Express Entry in Canada" }, new Date("2026-01-15T09:00:00.000Z"));
    expect(c).toContain("- Topic: Express Entry in Canada");
    expect(c).toContain("- Today: 2026-01-15");
    expect(c).not.toContain("research/example");
  });
});
