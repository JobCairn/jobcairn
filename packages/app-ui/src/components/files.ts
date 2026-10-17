import { fmtDay, parseDay } from "../reading/dates";

/** File helpers shared by the Job, Apply and Drop box screens. */
const isMac = () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
export const showInFolderLabel = () => (isMac() ? "Show in Finder" : "Show in folder");

const DOC_NAMES: Record<string, string> = { resume: "Resume", "cover-letter": "Cover letter", cover: "Cover letter", answers: "Answers", claims: "Claim check", review: "Second-pass review", letter: "Cover letter" };
const KIND_TEXT: Record<string, string> = {
  md: "Text", pdf: "PDF", docx: "Word", doc: "Word", json: "Data", txt: "Text", png: "Image", jpg: "Image", jpeg: "Image", gif: "Image", webp: "Image",
  key: "Keynote", pages: "Pages", numbers: "Numbers", xlsx: "Excel", pptx: "PowerPoint", mp4: "Video", mov: "Video",
};

/** "resume-2026-10-08-ml-engineer.md" → { title: "Resume · 8 Oct 2026", type: "Text" }. */
export function friendlyFile(name: string, at = ""): { title: string; type: string } {
  const base = name.split("/").pop() ?? name;
  const ext = (base.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const stem = base.replace(/\.[a-z0-9]+$/i, "");
  const dateIn = stem.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const key = Object.keys(DOC_NAMES).find((k) => stem.toLowerCase() === k || stem.toLowerCase().startsWith(`${k}-`));
  const words = stem.replace(/\d{4}-\d{2}-\d{2}/, "").replace(/[-_]+/g, " ").trim();
  const name0 = key ? DOC_NAMES[key]! : words ? words[0]!.toUpperCase() + words.slice(1) : base;
  const day = parseDay(dateIn ?? at.slice(0, 10));
  return { title: day ? `${name0} · ${fmtDay(day)}` : name0, type: KIND_TEXT[ext] ?? ext.toUpperCase() };
}
