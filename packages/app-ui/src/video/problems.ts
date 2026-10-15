import type { VideoDraftView, VideoIssue } from "@careeros/contract";
import { withoutPaths } from "../components/VideoList";

/**
 * The script check's findings, sorted for a person. The check speaks in spec paths ("sources.0.file isn't a
 * workspace file path"); nobody reviewing a script should read that. Two kinds come out:
 *
 * - format: Claude wrote part of the spec in the wrong shape. Typing can't fix it, so it becomes one line and one
 *   button ("Fix issues"). The raw text stays behind "Technical details".
 * - content: something the person can see and judge (too many words, an empty closing line, a quote that isn't in
 *   its source). Each gets a plain sentence, on its scene or above the scenes when it's about the whole video.
 *
 * What decides is the issue's `path`: it is the person's to fix when it names a field shown on that scene (or the
 * scene's script). Message text is read only for numbers and quoted words, never shown as is.
 */
export interface PlainIssue { level: "error" | "warning"; scene: number | null; text: string }
export interface SortedProblems {
  /** Format problems, for the count and the technical details. */
  format: VideoIssue[];
  /** Scenes with at least one format problem (their empty fields get a hint, not a blank box). */
  formatScenes: Set<number>;
  /** Plain-language problems: scene null is about the whole video. */
  content: PlainIssue[];
  /** Every finding as the check wrote it, with file paths cut to file names: for "Technical details". */
  technical: string[];
}

/** Scene types in words, for "The video is missing a closing summary scene." */
const SCENE_WORDS: Record<string, string> = {
  title: "title", "recap-card": "closing summary", "bullet-build": "list", comparison: "comparison", stat: "number", quiz: "question",
  flowchart: "flowchart", sequence: "sequence", "code-typing": "code", "code-highlight": "code", "code-morph": "code", "code-diff": "code change",
  "icon-grid": "icon", "logo-row": "logo", diagram: "diagram", match: "match", checklist: "checklist", timeline: "timeline", chart: "chart",
  quote: "quote", "company-card": "company", "map-pin": "map", kinetic: "big-words", matrix: "table",
};

/** "1 min 30 s" style, rounded to 10 seconds: "about 2.5 min" reads as precise, this doesn't. */
const fmtMinutes = (sec: number) => { const r = Math.round(sec / 10) * 10; const m = Math.floor(r / 60), s = r % 60; return m ? `${m} min${s ? ` ${s} s` : ""}` : `${s} s`; };
const num = (re: RegExp, s: string) => re.exec(s)?.slice(1) ?? null;
/** Quoted words from the script, kept short so a long cue never floods the line. */
const quoted = (s: string) => { const q = /"([^"]{1,60})"/.exec(s)?.[1]; return q ? `"${q}"` : "some words"; };

/** A problem with a field shown on the scene (its label is the person's word for it), or with the scene's script. */
function fieldText(i: VideoIssue, label: string): string | null {
  const m = i.message;
  const words = num(/has (\d+) words; keep it to (\d+)/, m);
  if (words) return `${label} has ${words[0]} words. Keep it to ${words[1]}.`;
  const chars = num(/too long \((\d+) characters; at most (\d+)\)/, m);
  if (chars) return `${label} is too long. Keep it under ${chars[1]} characters.`;
  if (/is missing|is empty|script is empty/.test(m)) return `${label} is empty.${label === "The script" ? " Put the words back." : ""}`;
  if (/control character/.test(m)) return null;
  if (i.code === "reading_load") return `${label} has a lot to read on screen. Fewer words would help.`;
  if (i.code === "cue") return cueText(m);
  return i.level === "warning" ? `${label} may need a look.` : `${label} needs a change.`;
}

function cueText(m: string): string {
  if (/not heard/.test(m)) return `The narration didn't say ${quoted(m)}. Check the script, then make the video again.`;
  return `This scene highlights ${quoted(m)}, but those words aren't in its script any more. Put them back, or ask Claude to fix it.`;
}

/** A fact check finding that's about what the scene says (not how the source was written down). */
function factText(m: string): string | null {
  if (/workspace file|exact path|does not exist|not one of this video's sources|can't be read|locked folder|sources; only|were fact-checked/.test(m)) return null;
  if (/quote .* is not in/.test(m)) return "A quote in this scene isn't in its source. Check the wording, or ask Claude to fix it.";
  const n = num(/the number (\S+) (?:needs a source|is not in)/, m);
  if (n) return `The number ${n[0]} isn't backed by a source. Ask Claude to check it.`;
  if (/has no source/.test(m)) return "This scene has no source. Ask Claude to add one, or take the line out.";
  if (/is about you/.test(m)) return "A line here is about you, so it should cite your own history. Ask Claude to fix it.";
  if (/link .* is not in|cite the link/.test(m)) return "A company fact here needs the link it came from. Ask Claude to fix it.";
  return "A fact in this scene doesn't match its source. Ask Claude to check it.";
}

/** A finding about the whole video (scene null) in plain words, or null when it's a format problem. */
function videoText(i: VideoIssue): string | null {
  const m = i.message;
  switch (i.code) {
    case "sponsorship": return "The script talks about visa sponsorship. Take it out.";
    case "work_rights": return "The script mentions visas or work rights. Check that it belongs in your video.";
    case "scene_length": return "Some scenes run long. Shorter scenes are easier to follow.";
    case "chapters": return "A video this long is split into chapters. Ask Claude to mark where each one starts.";
    case "missing": return i.path === "script.txt" ? "There is no script yet." : null;
    case "fact": case "value": return factText(m);
    case "limit": {
      const count = /needs (\d+)(?: to (\d+))? ([a-z-]+) scenes?; this spec has (\d+)/.exec(m);
      if (count) {
        const [, min, max, type, has] = count;
        const what = `${SCENE_WORDS[type!] ?? "matching"} scene`;
        return Number(has) < Number(min) ? `The video is missing a ${what}.` : `The video has too many ${what}s. Keep it to ${max ?? min}.`;
      }
      if (i.path === "scenes" && /needs \d+ to \d+ scenes/.test(m)) return "The video has too many or too few scenes for its length. Ask Claude to fix it.";
      if (i.path === "script" && /characters/.test(m)) return "The script is too long. Shorten it, or ask Claude to.";
      if (i.path === "script" && /pause/.test(m)) return "A pause in the script is too long. Keep pauses short.";
      return null;
    }
    case "length": {
      const secs = num(/runs about (\d+) seconds/, m);
      const runs = secs ? `about ${fmtMinutes(Number(secs[0]))}` : "a different length";
      return i.level === "error"
        ? `The script runs ${runs}, longer than the video you asked for. Shorten it, or ask Claude to.`
        : `The script runs ${runs}, shorter than the video you asked for.`;
    }
    default:
      return i.path === "script" && /script is empty/i.test(m) ? "The script is empty." : null;
  }
}

/** A finding on one scene in plain words, or null when it's a format problem. */
function sceneText(i: VideoIssue, d: VideoDraftView): string | null {
  const scene = d.scenes.find((s) => s.index === i.scene);
  const field = scene?.fields.find((f) => f.path === i.path);
  if (field) return fieldText(i, field.label);
  if (i.path === "script" || (i.code === "cue" && /script is empty/.test(i.message))) return fieldText({ ...i, path: "script" }, "The script");
  switch (i.code) {
    case "cue": return cueText(i.message);
    case "pause_mismatch": return "The thinking pause doesn't match the question's script. Ask Claude to fix it.";
    case "reading_load": return "There's a lot to read on screen here. Fewer words would help.";
    case "word_cap": return "This scene shows too many words. Ask Claude to move them into the narration.";
    case "picture": return null;
    case "fact": case "value": return factText(i.message);
    case "limit": return /\d+ words/.test(i.message) ? "Some text on this scene is too long. Ask Claude to shorten it." : null;
    default: return null;
  }
}

export function sortProblems(d: VideoDraftView): SortedProblems {
  const out: SortedProblems = { format: [], formatScenes: new Set(), content: [], technical: [] };
  // The draft's own list has every finding; the scene lists repeat the scene ones.
  const all = d.issues.length ? d.issues : d.scenes.flatMap((s) => s.issues);
  for (const i of all) {
    out.technical.push(withoutPaths(i.message));
    const text = i.scene === null ? videoText(i) : sceneText(i, d);
    if (text === null) {
      // A format warning doesn't block anything: it stays in the technical details only.
      if (i.level === "error") { out.format.push(i); if (i.scene !== null) out.formatScenes.add(i.scene); }
    } else if (!out.content.some((c) => c.scene === i.scene && c.text === text)) {
      out.content.push({ level: i.level, scene: i.scene, text });
    }
  }
  return out;
}

/** "Scene 2", "Scenes 2 and 5", "Scenes 1, 3 and 4". */
export function sceneList(indexes: number[]): string {
  const n = [...new Set(indexes)].sort((a, b) => a - b).map((i) => String(i + 1));
  if (n.length === 1) return `Scene ${n[0]}`;
  return `Scenes ${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
}
