import { describe, expect, it } from "vitest";
import {
  chunkBlocks, chunkMarkdown, FIRST_CHUNK_CHARS, MERGE_CHARS, mergeSpoken, speakable, speakDates, splitLong, TTS_CACHE_NAME, TTS_PREVIEW_NAME, TTS_VOICES, voiceLabel, voiceTag,
} from "../src/index.js";

describe("speakable", () => {
  it("strips markdown markers", () => {
    expect(speakable("## About **Acme Corp**")).toBe("About Acme Corp");
    expect(speakable("- [x] Ship _fast_ and ~~loose~~ careful")).toBe("Ship fast and loose careful");
    expect(speakable("> Quoted `useState` hook")).toBe("Quoted useState hook");
  });
  it("says link instead of reading a URL", () => {
    expect(speakable("See https://example.com/jobs?id=1 for more.")).toBe("See link for more.");
    expect(speakable("Apply at <https://example.com/apply>.")).toBe("Apply at link.");
    expect(speakable("Read [the brief](https://example.com/brief) first")).toBe("Read the brief first");
    expect(speakable("Two: https://a.example https://b.example")).toBe("Two: link");
  });
  it("drops images without alt text and HTML", () => {
    expect(speakable("![](logo.png) Hello <b>there</b>")).toBe("Hello there");
    expect(speakable("![Team photo](t.png)")).toBe("Team photo");
  });
  it("never passes expression tags through from a document", () => {
    expect(speakable("Hi <laugh> there")).toBe("Hi there");
  });
  it("reads table rows as a list", () => {
    expect(speakable("| Skill | Level |\n|---|---|\n| Python | High |")).toBe("Skill, Level Python, High");
  });
});

describe("chunkMarkdown", () => {
  it("splits paragraphs, headings and list items and skips code blocks", () => {
    const md = "# Role\n\nWe build things.\nEvery day.\n\n- One\n- Two\n\n```ts\nconst x = 1;\n```\n\nDone.";
    expect(chunkMarkdown(md)).toEqual(["Role", "We build things. Every day.", "One", "Two", "Done."]);
  });
  it("drops blocks with nothing to say", () => {
    expect(chunkMarkdown("---\n\n![](x.png)\n\nHi")).toEqual(["Hi"]);
  });
  it("splits a long paragraph at sentence ends", () => {
    const s = "This is one sentence that runs on. ".repeat(30);
    const parts = chunkMarkdown(s, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) { expect(p.length).toBeLessThanOrEqual(200); expect(p.endsWith(".")).toBe(true); }
    expect(parts.join(" ")).toBe(s.trim());
  });
  it("cuts a sentence with no stops at a space", () => {
    const parts = splitLong("word ".repeat(100).trim(), 50);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(50);
    expect(parts.join(" ")).toBe("word ".repeat(100).trim());
  });
  it("cleans DOM blocks the same way", () => {
    expect(chunkBlocks(["Visit https://example.com today", "  "])).toEqual(["Visit link today"]);
  });
});

describe("joining short blocks", () => {
  const S = "This sentence is about forty characters."; // 40 chars
  it("joins short neighbours up to the limit, keeps the first part short, and splits only at sentence ends", () => {
    const blocks = Array.from({ length: 30 }, (_v, i) => ({ text: S, block: i }));
    const chunks = mergeSpoken(blocks);
    expect(chunks[0]!.text.length).toBeLessThanOrEqual(FIRST_CHUNK_CHARS);
    for (const c of chunks.slice(1)) expect(c.text.length).toBeLessThanOrEqual(MERGE_CHARS);
    expect(chunks.length).toBeLessThan(10); // not 30 stops
    for (const c of chunks) expect(c.text).toMatch(/\.$/);
    expect(chunks.map((c) => c.text).join(" ")).toBe(Array(30).fill(S).join(" ")); // nothing lost, nothing cut mid-sentence
    expect(chunks[1]!.block).toBe(chunks[0]!.parts.length); // blocks continue in order
  });
  it("adds a full stop to a heading or row when joining, but keeps a label's colon", () => {
    expect(mergeSpoken([{ text: "## Key facts", block: 0 }, { text: "Source:", block: 1 }, { text: "LinkedIn", block: 2 }]).map((c) => c.text))
      .toEqual(["Key facts. Source: LinkedIn."]);
  });
  it("keeps a long paragraph as its own sentence-split parts", () => {
    const long = Array(40).fill(S).join(" ");
    const chunks = mergeSpoken([{ text: "Intro", block: 0 }, { text: long, block: 1 }]);
    expect(chunks[0]!.text).toBe("Intro.");
    for (const c of chunks.slice(1)) { expect(c.text.length).toBeLessThanOrEqual(600); expect(c.text).toMatch(/characters\.$/); }
  });
  it("says short dates in full, but leaves month-like words alone", () => {
    expect(speakDates("Fetched 8 Oct 2026, closes 1 Sept.")).toBe("Fetched 8 October 2026, closes 1 September.");
    expect(speakDates("We march in Mar and Dec plans.")).toBe("We march in Mar and Dec plans.");
    expect(speakable("Posted 12 Jan 2026")).toBe("Posted 12 January 2026");
  });
});

describe("names and labels", () => {
  it("accepts only cache hashes and preset previews", () => {
    expect(TTS_CACHE_NAME.test(`${"a".repeat(64)}.wav`)).toBe(true);
    expect(TTS_CACHE_NAME.test(`${"a".repeat(63)}.wav`)).toBe(false);
    expect(TTS_CACHE_NAME.test(`../${"a".repeat(64)}.wav`)).toBe(false);
    expect(TTS_PREVIEW_NAME.test("preview-M3.wav")).toBe(true);
    expect(TTS_PREVIEW_NAME.test("preview-X9.wav")).toBe(false);
  });
  it("labels voices with a friendly name and a short style", () => {
    expect(voiceLabel("F4")).toBe("Maya · Warm, calm");
    expect(voiceLabel("M3")).toBe("Leo · Bright, energetic");
    expect(voiceLabel("F1")).toBe("Nora · Crisp, steady");
    expect(voiceLabel("not-a-voice")).toBe("not-a-voice");
  });
  it("gives every preset voice a distinct name and never wraps onto a third line of text", () => {
    const names = TTS_VOICES.map((v) => voiceLabel(v).split(" · ")[0]);
    expect(new Set(names).size).toBe(TTS_VOICES.length);
    for (const v of TTS_VOICES) expect(voiceLabel(v).length).toBeLessThan(30);
  });
  it("tags only the default and the recommended voice", () => {
    expect(voiceTag("F4")).toBe("Default");
    expect(voiceTag("M3")).toBe("Recommended");
    expect(voiceTag("F1")).toBe("");
    expect(voiceTag("M1")).toBe("");
  });
});
