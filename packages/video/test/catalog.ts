import { SCENE_TYPES } from "../src/types.js";
import type { SceneSpec, VideoType } from "../src/types.js";

export const CATALOG_SCRIPT = [
  "Here is one video with every scene type.",
  "Three points. First, start small. Second, measure. Third, ship.",
  "Watch the code type itself out until it is done.",
  "Look at line one, then lines two and three.",
  "Now refactor it. Let becomes const.",
  "Here is the diff between the two.",
  "The flow goes from request, to retrieve, to answer.",
  "The client sends a request and the API replies.",
  "Compare before and after.",
  "About 120 people work there.",
  "Question. How would you cache this?",
  "[pause 5]",
  "First clarify the load. Then pick an approach. Then name the trade off. Then the result.",
  "They listen for numbers.",
  "So remember. Start small, measure, ship.",
].join("\n\n") + "\n";

export function catalogSpec(): SceneSpec {
  return {
    version: 2, title: "Every scene type", voice_type: "guide", captions: "rail",
    scenes: [
      { type: "title", cue: "Here is", kicker: "Every scene", title: "One video with every scene type", subtitle: "A test of the catalog", underline: "every" },
      {
        type: "bullet-build", cue: "Three points", headline: "Three points to hold",
        items: [{ text: "Start small", cue: "First" }, { text: "Measure", cue: "Second" }, { text: "Ship", cue: "Third" }],
        marks: [{ type: "highlight", target: "Measure", cue: "Second" }],
      },
      { type: "code-typing", cue: "Watch the code", lang: "ts", code: "const a = 1;\nconst b = a + 1;", label: "Typing", cue_done: "done" },
      {
        type: "code-highlight", cue: "Look at line", lang: "ts", code: "const a = 1;\nconst b = a + 1;\nexport { b };",
        steps: [{ lines: [1, 1], note: "Set a", cue: "one" }, { lines: [2, 3], note: "Use it", cue: "two" }],
      },
      { type: "code-morph", cue: "Now refactor", lang: "ts", from: "let x = 1;", to: "const x = 1;", cue_morph: "becomes" },
      { type: "code-diff", cue: "Here is the diff", lang: "ts", before: "a();\nb();", after: "a();\nc();", note: "b became c" },
      {
        type: "flowchart", cue: "The flow", headline: "Request to answer", direction: "lr",
        nodes: [{ id: "a", label: "Request", cue: "request" }, { id: "b", label: "Retrieve", cue: "retrieve" }, { id: "c", label: "Answer", cue: "answer" }],
        edges: [["a", "b"], ["b", "c", "then"]],
      },
      {
        type: "sequence", cue: "The client", headline: "Who talks to whom", actors: ["Client", "API"],
        messages: [{ from: "Client", to: "API", label: "POST /ask", cue: "sends" }, { from: "API", to: "Client", label: "200 OK", cue: "replies" }],
      },
      {
        type: "comparison", cue: "Compare", headline: "Before and after", left: { label: "Before", items: ["Slow"] }, right: { label: "After", items: ["Fast"] },
        cue_left: "before", cue_right: "after", verdict: "After wins",
      },
      { type: "stat", cue: "About", value: 120, suffix: "+", label: "People at Acme Corp", source: "Acme Corp about page" },
      {
        type: "quiz", cue: "Question", kind: "technical", question: "How would you cache this?", think_seconds: 5,
        beats: [{ label: "Clarify", text: "Ask about load", cue: "clarify" }, { label: "Approach", text: "Pick a cache", cue: "approach" }, { label: "Trade-off", text: "Name the cost", cue: "trade" }, { label: "Result", text: "Give a number", cue: "result" }],
        strong: ["A number", "A trade-off"], weak: ["No numbers", "No trade-off"], prompt: "Your turn. Two minutes.", cue_review: "They listen",
      },
      {
        type: "recap-card", cue: "So remember", headline: "Three things",
        items: [{ text: "Start small", cue: "small" }, { text: "Measure", cue: "measure" }, { text: "Ship", cue: "ship" }], closing: "Try one today.",
      },
    ],
  };
}

/**
 * No built-in video type (plugin/video-types/*.json) uses every catalog scene type at once -
 * they're each scoped to a real product's needs. This test-only type exists purely so
 * `catalogSpec()` (one of everything, deliberately) can be run through the real `validateSpec`
 * to get a `ValidatedSpec`, the same way a real pipeline would before calling `buildHtml`. The
 * quiz scene's think_seconds: 5 needs "practice" mode (watch mode requires 0).
 */
export function catalogType(): VideoType {
  return {
    id: "catalog-test", label: "Catalog test", description: "Every scene type, for expander golden tests.",
    version: 1, entry_points: ["learn.topic"], subject: "topic", writer: "template", skill: "video-explainer",
    voice_type: "guide", length: { min_s: 1, target_s: 9999, max_s: 100_000 },
    scene_types: [...SCENE_TYPES], scene_counts: {}, sources: [], brief_template: "",
    rules: [], facts: "teaching", extras: [], output: "", media: "none", modes: ["practice"],
    origin: "workspace", file: "",
  };
}
