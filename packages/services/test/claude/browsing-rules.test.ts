import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSING_DO, BROWSING_DONT, CLAUDE_MD_BEGIN, CLAUDE_MD_END, claudeMd, claudeMdWithBrowsing, withBrowsingBlock } from "@careeros/core";
import { BROWSER_RULES } from "../../src/claude/args.js";

const repo = path.resolve(import.meta.dirname, "../../../..");
const ALL = [...BROWSING_DO, ...BROWSING_DONT];

describe("browsing Do and Don't rules: one source, everywhere Claude looks", () => {
  it("the workspace CLAUDE.md template holds the block, every line", () => {
    const md = claudeMdWithBrowsing();
    expect(md).toContain("Do:\n");
    expect(md).toContain("Don't:\n");
    for (const l of ALL) expect(md).toContain(`- ${l}`);
  });

  it("the career skill's browsing reference and the skill's routing table hold them", () => {
    const ref = fs.readFileSync(path.join(repo, "plugin/skills/career/references/job-search-browsing.md"), "utf8");
    for (const l of ALL) expect(ref).toContain(`- ${l}`);
    const skill = fs.readFileSync(path.join(repo, "plugin/skills/career/SKILL.md"), "utf8");
    expect(skill).toContain("`references/job-search-browsing.md`");
  });

  it("every browsing run's system prompt holds them", () => {
    for (const l of ALL) expect(BROWSER_RULES).toContain(l);
  });

  it("short imperative lines, no em-dashes", () => {
    for (const l of ALL) {
      expect(l.length, l).toBeLessThan(160);
      expect(l).not.toMatch(/\u2014/);
    }
    for (const l of BROWSING_DONT) expect(l).toMatch(/^Don't /);
  });

  it("the managed block is put in once and refreshed in place, keeping the person's own text", () => {
    const own = `${claudeMd()}\n## My notes\n\nPrefer remote roles.\n`;
    const once = withBrowsingBlock(own);
    expect(once.startsWith(own.trimEnd())).toBe(true);
    expect(withBrowsingBlock(once)).toBe(once);
    const stale = once.replace("Close your tabs", "Old line");
    expect(withBrowsingBlock(stale)).toBe(once);
    const after = `${once}\n## Later notes\n`;
    expect(withBrowsingBlock(after)).toBe(after);
    expect(once.split(CLAUDE_MD_BEGIN)).toHaveLength(2);
    expect(once.split(CLAUDE_MD_END)).toHaveLength(2);
  });
});
