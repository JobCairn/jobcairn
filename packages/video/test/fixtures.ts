import fs from "node:fs";
import path from "node:path";
import { layout, updateRecord, writeFileAtomic } from "@careeros/core";
import { loadRegistry, type Registry } from "../src/registry.js";
import { parseScript, stripTags } from "../src/script.js";
import type { SceneSpec, VideoType, Word } from "../src/types.js";
import { BUILTIN_TYPES } from "./helpers.js";

export const ACME_JOB = "companies/acme-corp/jobs/2026-01-12-ai-engineer";
export const JD = `${ACME_JOB}/jd.md`;
export const RESEARCH = "companies/acme-corp/research/overview.md";

let reg: Registry | null = null;
export function registry(): Registry { return (reg ??= loadRegistry({ builtinDir: BUILTIN_TYPES })); }
export function typeOf(id: string): VideoType {
  const t = registry().byId(id);
  if (!t) throw new Error(`no built-in type ${id}`);
  return t;
}

/** Pins the fictional files the video tests read, whatever the sample generator writes. */
export function seedAcme(root: string): void {
  const w = (rel: string, text: string) => writeFileAtomic(path.join(root, rel), text);
  w(JD, "# AI Engineer at Acme Corp\n\nBuild LLM agents. Visa sponsorship available for the right candidate.\n");
  w(`${ACME_JOB}/score.md`, "# Score\n\nFit 72. Gap: Kubernetes.\n");
  w("me/history/roles.md", "# Roles\n\n- AI Engineer, Example Labs, 2024 to now (fictional)\n- Built an agent that triages 40 support tickets a day (fictional)\n");
  w(RESEARCH, [
    "# Acme Corp overview", "", "Source: https://acme.example.com/about (retrieved 2026-01-14)", "",
    "Acme Corp builds scheduling software for clinics. About 120 staff.", "", "Source: https://acme.example.com/careers", "",
    "The platform team uses TypeScript and Postgres.", "",
  ].join("\n"));
  updateRecord("job", layout(root).jobFile("acme-corp", "2026-01-12-ai-engineer"), (j) => {
    j.scores.fit.must_haves = [{ skill: "LLM agents", met: true }, { skill: "Kubernetes", met: false }];
    j.scores.fit.nice_to_haves = ["Postgres"];
  });
  fs.mkdirSync(path.join(root, "me/identity"), { recursive: true });
  w("me/identity/visa.md", "# Visa\n\nSubclass 485, expires 2028-06-30 (fictional).\n");
}

export const JD_SCRIPT = [
  "Here is what Acme Corp wants from an AI Engineer, and where you stand.",
  "The role asks for agents and retrieval. Your evidence is the agent work in your history.",
  "Three things matter most. First, building LLM agents. Second, shipping to users. Third, visa sponsorship is on offer.",
  "So remember. Agents are the core. Your history covers them. Sponsorship is available.",
].join("\n\n") + "\n";

export function jdSpec(): SceneSpec {
  return {
    version: 2, title: "What Acme Corp asks for", voice_type: "slides", captions: "rail",
    scenes: [
      { type: "title", cue: "Here is", kicker: "JD walkthrough", title: "What Acme Corp wants from an AI Engineer", sources: [{ file: JD }] },
      {
        type: "comparison", cue: "The role asks", headline: "Agents are the heart of this role",
        left: { label: "The role asks", items: ["Build LLM agents"] }, right: { label: "Your evidence", items: ["Agent work in your history"] },
        cue_left: "agents and retrieval", cue_right: "Your evidence",
        sources: [{ file: JD, quote: "Build LLM agents." }, { file: "me/history/roles.md" }],
      },
      {
        type: "bullet-build", cue: "Three things", headline: "Three things matter most",
        items: [{ text: "Building LLM agents", cue: "First" }, { text: "Shipping to users", cue: "Second" }, { text: "Visa sponsorship on offer", cue: "Third" }],
        sources: [{ file: JD }],
      },
      {
        type: "recap-card", cue: "So remember", headline: "Your read on this role",
        items: [{ text: "Agents are the core", cue: "Agents" }, { text: "Your history covers them", cue: "covers" }, { text: "Sponsorship is available", cue: "Sponsorship" }],
        closing: "Prepare one agent story to tell.", sources: [{ file: JD }],
      },
    ],
  };
}

export const BRIEF_SCRIPT = [
  "Here is your briefing on Acme Corp.",
  "Acme Corp builds scheduling software for clinics.",
  "They have about 120 staff.",
  "So remember the basics before your call.",
].join("\n\n") + "\n";

export function briefSpec(): SceneSpec {
  const src = [{ file: RESEARCH, url: "https://acme.example.com/about" }];
  return {
    version: 2, title: "Acme Corp in one minute", voice_type: "slides",
    scenes: [
      { type: "title", cue: "Here is", kicker: "Company briefing", title: "Acme Corp in one minute", sources: src },
      {
        type: "bullet-build", cue: "Acme Corp builds", headline: "Acme Corp builds software for clinics",
        items: [{ text: "Scheduling software", cue: "scheduling" }, { text: "Made for clinics", cue: "clinics" }], sources: src,
      },
      { type: "stat", cue: "120", value: 120, label: "People work at Acme Corp", source: "Acme Corp about page", sources: src },
      {
        type: "recap-card", cue: "So remember", headline: "Before your call",
        items: [{ text: "Know what they build", cue: "remember" }, { text: "Know their size", cue: "basics" }, { text: "Ask about the platform team", cue: "call" }],
        closing: "Read the research notes once more.", sources: src,
      },
    ],
  };
}

export const QUIZ_SCRIPT = [
  "Here is your interview drill for Acme Corp.",
  "Tell me about a time you shipped an agent.",
  "[pause 8]",
  "A strong answer starts with the situation. Then the task you owned. Then your action. Then the result.",
  "What they listen for is ownership and a number. Try it now.",
  "Second question. How would you test retrieval quality?",
  "[pause 8]",
  "Clarify the goal first. Then your approach. Then the trade off. Then the result you measured.",
  "What they listen for is a clear metric. Try it now.",
  "Third question. Why Acme Corp?",
  "[pause 8]",
  "Start from the situation they face. Then the task. Then your action. Then the result you expect.",
  "What they listen for is real interest. Try it now.",
  "So remember. Stories beat lists. Numbers win. Practise out loud.",
].join("\n\n") + "\n";

export function quizSpec(): SceneSpec {
  const quiz = (cue: string, question: string, review: string, labels: [string, string, string, string], cues: [string, string, string, string]) => ({
    type: "quiz" as const, cue, kind: "behavioural" as const, question, think_seconds: 8,
    beats: labels.map((label, i) => ({ label, text: `${label} in one line`, cue: cues[i]! })),
    strong: ["A clear owner", "A number"], weak: ["Only we", "No result"], prompt: "Answer out loud in two minutes.", cue_review: review,
  });
  return {
    version: 2, title: "Acme Corp interview drill", voice_type: "interview",
    scenes: [
      { type: "title", cue: "Here is", kicker: "Interview prep", title: "Your Acme Corp drill" },
      quiz("Tell me", "Tell me about a time you shipped an agent.", "What they listen", ["Situation", "Task", "Action", "Result"], ["situation", "task", "action", "result"]),
      quiz("Second question", "How would you test retrieval quality?", "What they listen", ["Clarify", "Approach", "Trade-off", "Result"], ["Clarify", "approach", "trade off", "result"]),
      quiz("Third question", "Why Acme Corp?", "What they listen", ["Situation", "Task", "Action", "Result"], ["situation", "task", "action", "result"]),
      {
        type: "recap-card", cue: "So remember", headline: "Three things to keep",
        items: [{ text: "Stories beat lists", cue: "Stories" }, { text: "Numbers win", cue: "Numbers" }, { text: "Practise out loud", cue: "Practise" }],
        closing: "Run the drill again tomorrow.",
      },
    ],
  };
}

/** Word timings as if a voice read the script at 0.4 s per word (tests only; real timings come from transcription). */
/** The fake narration's paragraphs (narrate.py's `paragraphs`): each speech block from its first word's start to
 * its last word's end, in the same fake timing as `fakeWords`. */
export function fakeParagraphs(script: string): { index: number; text: string; start: number; end: number }[] {
  const { words } = fakeWords(script);
  const out: { index: number; text: string; start: number; end: number }[] = [];
  let n = 0;
  for (const b of parseScript(script)) {
    if (b.kind !== "speech") continue;
    const count = stripTags(b.text).split(/\s+/).filter(Boolean).length;
    if (!count) continue;
    out.push({ index: out.length, text: stripTags(b.text), start: words[n]!.start, end: words[n + count - 1]!.end });
    n += count;
  }
  return out;
}

export function fakeWords(script: string): { words: Word[]; total: number } {
  const words: Word[] = [];
  let t = 0.5;
  parseScript(script).forEach((b, i) => {
    if (i > 0) t += 0.45;
    if (b.kind === "pause") { t += b.seconds; return; }
    for (const raw of stripTags(b.text).split(/\s+/).filter(Boolean)) { words.push({ text: raw, start: +t.toFixed(2), end: +(t + 0.32).toFixed(2) }); t += 0.4; }
  });
  return { words, total: +(t + 1).toFixed(2) };
}
