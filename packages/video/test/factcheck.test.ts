import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addGrant, layout, updateRecord } from "@careeros/core";
import { factCheck, MAX_CITES_PER_SCENE, MAX_QUOTE_CHARS, MAX_SCENES_CHECKED, numbersIn } from "../src/factcheck.js";
import { buildSourcePack } from "../src/sources.js";
import type { SceneSpec } from "../src/types.js";
import { ACME_JOB, briefSpec, JD, jdSpec, RESEARCH, seedAcme, typeOf } from "./fixtures.js";
import { FIXED, sampleCopy } from "./helpers.js";

/** A hand-edited grant the workspace schema would refuse: written raw, the way a person's editor would. */
function rawGrant(root: string, grant: Record<string, string>): void {
  const file = layout(root).workspaceFile;
  const w = JSON.parse(fs.readFileSync(file, "utf8")) as { privacy: { grants: unknown[] } };
  w.privacy.grants.push(grant);
  fs.writeFileSync(file, JSON.stringify(w, null, 2));
}

const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
const COMPANY = { kind: "company", company_slug: "acme-corp" } as const;
const clock = { now: FIXED };

function run(root: string, typeId: string, spec: SceneSpec) {
  const type = typeOf(typeId);
  const subject = type.subject === "company" ? COMPANY : JOB;
  const folder = type.subject === "company" ? "companies/acme-corp/videos/briefing-1" : `${ACME_JOB}/videos/x-1`;
  const pack = buildSourcePack({ root, type, subject, folder, clock });
  return factCheck({ root, folder, type, spec, pack, clock });
}
const msgs = (r: { issues: { message: string }[] }) => r.issues.map((i) => i.message);

describe("factCheck", () => {
  it("passes well-sourced specs", () => {
    const root = sampleCopy();
    seedAcme(root);
    expect(msgs(run(root, "jd-walkthrough", jdSpec()))).toEqual([]);
    expect(msgs(run(root, "company-briefing", briefSpec()))).toEqual([]);
  });

  it("needs a source on every scene of a strict type", () => {
    const root = sampleCopy();
    seedAcme(root);
    const spec = briefSpec();
    const s = spec.scenes[1] as { headline: string; sources?: unknown; items: { sources?: unknown }[] };
    s.headline = "Acme Corp runs on Go";
    delete s.sources;
    expect(msgs(run(root, "company-briefing", spec))).toEqual(['Scene 2: "Acme Corp runs on Go" has no source. Add a source or remove the line.']);
  });

  it("checks stat numbers, quotes and research links", () => {
    const root = sampleCopy();
    seedAcme(root);
    const spec = briefSpec();
    (spec.scenes[2] as { value: number }).value = 150;
    (spec.scenes[1] as { sources: unknown }).sources = [{ file: RESEARCH, url: "https://acme.example.com/blog", quote: "Acme Corp builds rockets." }];
    (spec.scenes[3] as { sources: unknown }).sources = [{ file: RESEARCH }];
    expect(msgs(run(root, "company-briefing", spec))).toEqual([
      `Scene 2: the link https://acme.example.com/blog is not in ${RESEARCH}.`,
      `Scene 2: the quote "Acme Corp builds rockets." is not in ${RESEARCH}.`,
      `Scene 3: the number 150 is not in ${RESEARCH}.`,
      `Scene 4: cite the link from ${RESEARCH} that supports this company fact.`,
    ]);
  });

  it("refuses files outside the pack, missing files and path tricks (Review Focus 4)", () => {
    const root = sampleCopy();
    seedAcme(root);
    const spec = jdSpec();
    spec.scenes[0]!.sources = [{ file: "companies/example-labs/company.json" }];
    spec.scenes[2]!.sources = [{ file: `${ACME_JOB}/nope.md` }];
    spec.scenes[3]!.sources = [{ file: "ME/Identity/visa.md" }];
    const out = msgs(run(root, "jd-walkthrough", spec));
    expect(out).toContain("Scene 1: companies/example-labs/company.json is not one of this video's sources.");
    expect(out).toContain(`Scene 3: ${ACME_JOB}/nope.md does not exist.`);
    // Fix round 1 (item 1): a case variant of a locked path is now caught by the
    // canonical-path check before it's ever checked against a lockable folder, so the
    // message here is "isn't the exact path of a workspace file" (fix round 2, item 4's
    // wording), not the generic "is in a locked folder" one. Any of the three is an
    // acceptable refusal shape; what matters is that it's refused.
    expect(out.some((m) => /^Scene 4: .*ME\/Identity\/visa\.md.* (is in a locked folder|does not exist|isn't the exact path of a workspace file)/.test(m))).toBe(true);
  });

  it("allows a locked fact only under an open grant, and records it", () => {
    const root = sampleCopy();
    seedAcme(root);
    const spec = jdSpec();
    spec.scenes[3]!.sources = [{ file: JD }, { file: "me/identity/visa.md" }];
    expect(msgs(run(root, "jd-walkthrough", spec))).toEqual(["Scene 4: me/identity/visa.md is in a locked folder. Ask for access once, or remove it."]);
    addGrant(root, "me/identity", 15, "req-1", clock);
    const r = run(root, "jd-walkthrough", spec);
    expect(msgs(r)).toEqual([]);
    expect(r.usedLocked).toEqual([{ folder: "me/identity", granted_at: FIXED.toISOString() }]);
  });

  it("wants a history source for claims about the candidate", () => {
    const root = sampleCopy();
    seedAcme(root);
    const spec = jdSpec();
    (spec.scenes[2] as { headline: string }).headline = "You built agents at Example Labs";
    expect(msgs(run(root, "jd-walkthrough", spec))).toEqual(['Scene 3: "Example Labs" is about you. Cite me/history or your profile for it.']);
  });

  it("reads numbers with separators and decimals", () => {
    expect(numbersIn("About 1,200 staff, 4.5 stars, 30%")).toEqual([1200, 4.5, 30]);
  });

  it("never reads a locked file's contents", () => {
    const root = sampleCopy();
    seedAcme(root);
    addGrant(root, "me/identity", 15, "req-1", clock);
    const visa = path.join(root, "me/identity/visa.md");
    const openSpy = vi.spyOn(fs, "openSync");
    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      const spec = jdSpec();
      spec.scenes[3]!.sources = [{ file: JD }, { file: "me/identity/visa.md", quote: "Subclass 485" }];
      expect(msgs(run(root, "jd-walkthrough", spec))).toEqual(["Scene 4: quotes can't come from a locked folder. Remove the quote."]);
      // Direct proof the file was never opened or read, not an inference from a
      // permission error (fix round 2, item 3): readSafe swallows a failed open/read
      // and returns null instead of throwing, so a chmod-000 trick alone can't tell
      // "never tried" apart from "tried, and failed silently" — only watching the
      // actual syscalls can.
      expect(openSpy.mock.calls.some((args) => String(args[0]) === visa)).toBe(false);
      expect(readSpy.mock.calls.some((args) => String(args[0]) === visa)).toBe(false);
    } finally {
      openSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it("fails closed on a grant with a malformed `until`, even though core's own string compare would call it open (Ruling 2)", () => {
    const root = sampleCopy();
    seedAcme(root);
    // "not-a-date" sorts lexicographically after any ISO timestamp, so a plain
    // `until > now` string compare (core's own effectiveLocked) would call this grant
    // open. Date.parse("not-a-date") is NaN, so factCheck must not be fooled.
    rawGrant(root, { folder: "me/identity", until: "not-a-date", request_id: "req-x", granted_at: FIXED.toISOString() });
    const spec = jdSpec();
    spec.scenes[3]!.sources = [{ file: JD }, { file: "me/identity/visa.md" }];
    expect(msgs(run(root, "jd-walkthrough", spec))).toEqual(["Scene 4: me/identity/visa.md is in a locked folder. Ask for access once, or remove it."]);
  });

  it("fails closed on a grant that would outlive the 240-minute ceiling (Ruling 2)", () => {
    const root = sampleCopy();
    seedAcme(root);
    const granted_at = FIXED.toISOString();
    const until = new Date(FIXED.getTime() + 500 * 60_000).toISOString(); // 500 minutes: over the 240-minute ceiling, but both dates parse fine
    updateRecord("workspace", layout(root).workspaceFile, (w) => {
      w.privacy.grants.push({ folder: "me/identity", until, request_id: "req-y", granted_at });
    });
    const spec = jdSpec();
    spec.scenes[3]!.sources = [{ file: JD }, { file: "me/identity/visa.md" }];
    expect(msgs(run(root, "jd-walkthrough", spec))).toEqual(["Scene 4: me/identity/visa.md is in a locked folder. Ask for access once, or remove it."]);
  });

  it("bounds the number of scenes it checks and reports the cap (Ruling 4)", () => {
    const root = sampleCopy();
    seedAcme(root);
    const spec = jdSpec();
    const extra = MAX_SCENES_CHECKED + 10;
    spec.scenes = Array.from({ length: extra }, () => spec.scenes[0]!);
    const r = run(root, "jd-walkthrough", spec);
    expect(msgs(r)).toContain(`This spec has ${extra} scenes; only the first ${MAX_SCENES_CHECKED} were fact-checked. Shorten it.`);
  });

  it("bounds the number of sources it checks per scene and reports the cap (Ruling 4)", () => {
    const root = sampleCopy();
    seedAcme(root);
    const spec = jdSpec();
    const extra = MAX_CITES_PER_SCENE + 6;
    spec.scenes[0]!.sources = Array.from({ length: extra }, () => ({ file: JD }));
    const r = run(root, "jd-walkthrough", spec);
    expect(msgs(r)).toContain(`Scene 1: cites ${extra} sources; only the first ${MAX_CITES_PER_SCENE} were checked.`);
  });

  it("bounds how long a quote it will compare and reports the cap (Ruling 4)", () => {
    const root = sampleCopy();
    seedAcme(root);
    const spec = jdSpec();
    const quote = "x".repeat(MAX_QUOTE_CHARS + 1);
    spec.scenes[0]!.sources = [{ file: JD, quote }];
    const r = run(root, "jd-walkthrough", spec);
    expect(msgs(r)).toContain(`Scene 1: the quote for ${JD} is too long to check (more than ${MAX_QUOTE_CHARS} characters). Shorten it.`);
  });
});

describe("fix round 1", () => {
  it("refuses a case variant of a locked path even under an open grant, and records nothing (item 1)", () => {
    const root = sampleCopy();
    seedAcme(root);
    addGrant(root, "me/identity", 15, "req-1", clock);
    const spec = jdSpec();
    spec.scenes[3]!.sources = [{ file: JD }, { file: "ME/IDENTITY/visa.md" }];
    const r = run(root, "jd-walkthrough", spec);
    expect(msgs(r)).toEqual([
      `Scene 4: ${JSON.stringify("ME/IDENTITY/visa.md")} isn't the exact path of a workspace file. Check the letter case, and don't cite through a link.`,
    ]);
    expect(r.usedLocked).toEqual([]);
  });

  it("refuses a symlinked alias into a locked folder even under an open grant, and it is not counted as history evidence (item 1)", () => {
    const root = sampleCopy();
    seedAcme(root);
    fs.symlinkSync(path.join(root, "me/identity"), path.join(root, "me/history/idlink"));
    addGrant(root, "me/identity", 15, "req-1", clock);
    const spec = jdSpec();
    (spec.scenes[2] as { headline: string }).headline = "You built agents at Example Labs";
    spec.scenes[2]!.sources = [{ file: "me/history/idlink/visa.md" }];
    const r = run(root, "jd-walkthrough", spec);
    expect(msgs(r)).toEqual([
      `Scene 3: ${JSON.stringify("me/history/idlink/visa.md")} isn't the exact path of a workspace file. Check the letter case, and don't cite through a link.`,
      'Scene 3: "Example Labs" is about you. Cite me/history or your profile for it.',
    ]);
    expect(r.usedLocked).toEqual([]);
  });

  it("fails closed when a grant's granted_at is itself still in the future (item 2)", () => {
    const root = sampleCopy();
    seedAcme(root);
    updateRecord("workspace", layout(root).workspaceFile, (w) => {
      w.privacy.grants.push({ folder: "me/identity", until: "2099-01-01T01:00:00.000Z", request_id: "req-future", granted_at: "2099-01-01T00:00:00.000Z" });
    });
    const spec = jdSpec();
    spec.scenes[3]!.sources = [{ file: JD }, { file: "me/identity/visa.md" }];
    expect(msgs(run(root, "jd-walkthrough", spec))).toEqual(["Scene 4: me/identity/visa.md is in a locked folder. Ask for access once, or remove it."]);
  });

  it("fails closed on a timezone-offset `until` that a plain string compare would call open (item 2)", () => {
    const root = sampleCopy();
    seedAcme(root);
    // now is 2026-01-15T09:00:00.000Z (FIXED); this `until` is the same instant, just
    // written with a +01:00 offset, so a lexicographic string compare (">") would
    // wrongly call it still open ("...T10:00:00+01:00" sorts after "...T09:00:00.000Z").
    rawGrant(root, { folder: "me/identity", until: "2026-01-15T10:00:00+01:00", request_id: "req-tz", granted_at: "2026-01-15T08:50:00.000Z" });
    const spec = jdSpec();
    spec.scenes[3]!.sources = [{ file: JD }, { file: "me/identity/visa.md" }];
    expect(msgs(run(root, "jd-walkthrough", spec))).toEqual(["Scene 4: me/identity/visa.md is in a locked folder. Ask for access once, or remove it."]);
  });

  it("doesn't let fake thousands grouping merge separate numbers (item 4)", () => {
    expect(numbersIn("1,2,3")).toEqual([1, 2, 3]);
  });

  it("refuses a cite with a control character or an overlong path, without echoing it raw (item 5)", () => {
    const root = sampleCopy();
    seedAcme(root);
    const spec = jdSpec();
    const nulPath = "companies/acme-corp/jd\u0000.md";
    const longName = `${"a".repeat(600)}.md`;
    spec.scenes[0]!.sources = [{ file: nulPath }, { file: longName }];
    const out = msgs(run(root, "jd-walkthrough", spec));
    expect(out).toEqual([
      `Scene 1: ${JSON.stringify(nulPath)} isn't a workspace file path.`,
      `Scene 1: ${JSON.stringify(longName.slice(0, 120))} isn't a workspace file path.`,
    ]);
  });

  it("reports a fact error, not a crash, when a pack file can no longer be read safely (item 6)", () => {
    const root = sampleCopy();
    seedAcme(root);
    const type = typeOf("jd-walkthrough");
    const folder = `${ACME_JOB}/videos/x-1`;
    const pack = buildSourcePack({ root, type, subject: JOB, folder, clock });
    // Gives jd.md a second hard link after the pack was built (when it still had one):
    // readSafe refuses to read any file whose link count isn't exactly 1.
    fs.linkSync(path.join(root, JD), path.join(root, ACME_JOB, "jd-alias-2.md"));
    const spec = jdSpec();
    spec.scenes[1]!.sources = [{ file: JD, quote: "Build LLM agents." }];
    const r = factCheck({ root, folder, type, spec, pack, clock });
    expect(msgs(r)).toEqual([`Scene 2: ${JD} can't be read to check this.`]);
  });

  it("never reads a locked file's contents, even to check a stat's number (item 7)", () => {
    const root = sampleCopy();
    seedAcme(root);
    addGrant(root, "me/identity", 15, "req-1", clock);
    const visa = path.join(root, "me/identity/visa.md");
    const openSpy = vi.spyOn(fs, "openSync");
    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      const spec = briefSpec();
      (spec.scenes[2] as { sources: unknown }).sources = [{ file: RESEARCH, url: "https://acme.example.com/about" }, { file: "me/identity/visa.md" }];
      // The stat's number (120) is in RESEARCH; the locked cite is accepted (grant is
      // open) but contributes nothing, and — proven directly below, not inferred from a
      // permission error (fix round 2, item 3) — it is never opened or read.
      expect(msgs(run(root, "company-briefing", spec))).toEqual([]);
      expect(openSpy.mock.calls.some((args) => String(args[0]) === visa)).toBe(false);
      expect(readSpy.mock.calls.some((args) => String(args[0]) === visa)).toBe(false);
    } finally {
      openSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});

describe("fix round 2", () => {
  it("resolves cites correctly when the workspace root is itself reached through a symlink (item 1)", () => {
    const realRoot = sampleCopy();
    seedAcme(realRoot);
    const root = path.join(path.dirname(realRoot), "ws-symlink");
    fs.symlinkSync(realRoot, root);
    const type = typeOf("weekly-recap");
    const subject = { kind: "week", week: "2026-W03" } as const;
    const folder = "recaps/2026-W03";
    const pack = buildSourcePack({ root, type, subject, folder, clock });
    const stats = pack.facts.stats!;
    const STATS = `${folder}/stats.json`;
    const spec: SceneSpec = {
      version: 2, title: "Your week", voice_type: "slides",
      scenes: [
        { type: "title", cue: "x", kicker: "Weekly recap", title: "Your week in numbers", sources: [{ file: STATS }] },
        { type: "stat", cue: "x", value: stats.found, label: "Jobs found", source: "stats.json", sources: [{ file: STATS }] },
        {
          type: "bullet-build", cue: "x", headline: "This week",
          items: [{ text: "a", cue: "x" }, { text: "b", cue: "x" }],
          sources: [{ file: `${folder}/missing.md` }],
        },
        {
          type: "recap-card", cue: "x", headline: "Recap",
          items: [{ text: "a", cue: "x" }, { text: "b", cue: "x" }, { text: "c", cue: "x" }],
          closing: "done", sources: [{ file: STATS }],
        },
      ],
    };
    const r = factCheck({ root, folder, type, spec, pack, clock });
    // Before the fix: `abs` was built from the symlinked `root`, so a cite that falls
    // back to a lexical (non-realpath) comparison — a genuinely missing file, or this
    // video's own virtual stats.json, which has no file on disk at all — never equalled
    // the canonical, `rootReal`-anchored path it was compared against, so both wrongly
    // reported "isn't the exact path of a workspace file" instead of "does not exist"
    // for the missing one, and refused the virtual stats.json cite outright.
    expect(msgs(r)).toEqual([`Scene 3: ${folder}/missing.md does not exist.`]);
  });

  it("doesn't let a comma mid-run mask a longer digit run as a shorter thousands-grouped number (item 2)", () => {
    expect(numbersIn("1,2345")).toEqual([1, 2345]);
    expect(numbersIn("12,34567")).toEqual([12, 34567]);
  });
});
