import { canOpenExternally, PREVIEW_LIMITS, previewKind, type FilePreview, type FileRef, type LockableDir } from "@careeros/contract";
import resumePdfUrl from "../../../../samples/viewer-demo/alex-example-resume.pdf?url";
import diagramUrl from "../../../../samples/viewer-demo/pipeline-diagram.png?url";

/**
 * The file viewer's preview data (fictional). Text files come from the fixture's texts; the binary ones below stand in
 * for a PDF, a Word file and an image. In the browser preview, `fileUrl` points the PDF and the image at bundled assets,
 * because careeros-file: only exists in the desktop app.
 */
export interface MockBinary { size: number; url?: string; text?: string; at: string }

const JOB = "companies/acme-corp/jobs/2026-01-12-ai-engineer";

const COVER_DOCX = [
  "Dear hiring team at Acme Corp,",
  "I'm applying for the AI Engineer role. For the past three years I have built retrieval and evaluation systems at Example Labs, most recently a pipeline over 40,000 fictional support articles that cut answer latency from 2.1 s to 0.8 s.",
  "Your ad asks for production LLM work and clear writing. I write weekly quality reports for my team and I'd bring the same habit to yours.",
  "Kind regards,",
  "Alex Example",
].join("\n\n");

export const VIEWER_BINARIES: Record<string, MockBinary> = {
  [`${JOB}/application/resume-2026-10-08.pdf`]: { size: 1522, url: resumePdfUrl, at: "2026-10-08T03:00:00.000Z" },
  [`${JOB}/application/cover-letter-2026-10-08.docx`]: { size: 18_240, text: COVER_DOCX, at: "2026-10-08T03:05:00.000Z" },
  [`${JOB}/research/pipeline-diagram.png`]: { size: 2808, url: diagramUrl, at: "2026-10-07T22:10:00.000Z" },
  [`${JOB}/application/portfolio.key`]: { size: 4_200_000, at: "2026-10-06T01:00:00.000Z" },
};

const RESEARCH = `# Acme Corp: company research

Fictional notes for the preview.

## At a glance

| What | Notes |
|------|-------|
| Size | About 400 people, 30 in data and AI |
| Offices | Brisbane, Sydney |
| Sponsorship | Ad says 482 sponsorship is available |

## Why it fits

- They run retrieval over customer documents, which matches the Example Labs work.
- The team writes in Python and TypeScript.
`;

const COVER_NOTES = `# Cover letter notes

- Open with the retrieval latency result (2.1 s to 0.8 s).
- Mention the weekly quality report: the ad asks for clear writing.
- Keep it under 250 words.
`;

const PLAN = `# Learning plan: Acme Corp

1. Refresh evaluation metrics for retrieval (recall at k, answer faithfulness).
2. Read their engineering blog post on document chunking.
3. Practise a five minute walkthrough of the Example Labs pipeline.
`;

/** Extra files on the Acme Corp job so the preview's Files tab has one of each kind. */
export function viewerDemoFiles(texts: Record<string, string>): FileRef[] {
  texts[`${JOB}/research.md`] = RESEARCH;
  texts[`${JOB}/application/cover-letter-notes.md`] = COVER_NOTES;
  texts[`${JOB}/learning-plan.md`] = PLAN;
  return [
    { path: "research.md", label: "Company research", at: "2026-10-07T22:00:00.000Z" },
    { path: "application/cover-letter-notes.md", label: "Cover letter notes", at: "2026-10-08T02:40:00.000Z" },
    { path: "learning-plan.md", label: "Learning plan", at: "2026-10-08T04:00:00.000Z" },
    { path: "application/resume-2026-10-08.pdf", label: "Tailored resume (PDF)", at: "2026-10-08T03:00:00.000Z" },
    { path: "application/cover-letter-2026-10-08.docx", label: "Cover letter (Word)", at: "2026-10-08T03:05:00.000Z" },
    { path: "research/pipeline-diagram.png", label: "Pipeline diagram", at: "2026-10-07T22:10:00.000Z" },
    { path: "application/portfolio.key", label: "Portfolio slides", at: "2026-10-06T01:00:00.000Z" },
  ];
}

/** Like services file-preview: the lock first (from the path alone), then the file. */
export function mockPreview(rel: string, texts: Record<string, string>, locked: LockableDir[], now: string): FilePreview {
  const kind = previewKind(rel);
  const folder = locked.find((d) => rel === d || rel.startsWith(`${d}/`));
  if (folder) return { state: "locked", kind, folder };
  const bin = binaryFor(rel);
  const text = texts[rel];
  if (bin === undefined && text === undefined) return { state: "missing", kind };
  const size = bin?.size ?? new TextEncoder().encode(text ?? "").length;
  const at = bin?.at ?? now;
  if (kind === "other") return { state: "unsupported", kind, size, at, reason: rel.toLowerCase().endsWith(".doc") ? "old_word" : "kind" };
  const limit = kind === "markdown" || kind === "text" ? PREVIEW_LIMITS.text : kind === "word" ? PREVIEW_LIMITS.word : PREVIEW_LIMITS.media;
  if (size > limit) return { state: "too_large", kind, size, at, limit };
  if (kind === "markdown" || kind === "text") return { state: "ready", kind, size, at, text: text ?? "" };
  if (kind === "word") return bin?.text ? { state: "ready", kind, size, at, text: bin.text } : { state: "unsupported", kind, size, at, reason: "unreadable" };
  return { state: "ready", kind, size, at, text: null };
}

/** Like services files.open: documents and media only, never a locked folder. */
export function mockOpenCheck(rel: string, locked: LockableDir[]): void {
  if (!canOpenExternally(rel)) throw new Error("This kind of file can't be opened from the app. Use Show in Finder instead.");
  if (locked.some((d) => rel === d || rel.startsWith(`${d}/`))) throw new Error("This file is in a locked folder. Allow it once in Privacy first.");
}

/** The preview's stand-in for careeros-file: bundled assets for the demo PDF and image. */
export const demoFileUrl = (rel: string): string | undefined => binaryFor(rel)?.url;

/** A PDF saved from a (fictional) email: the preview shows the demo resume PDF in its place. */
const SAVED_ATTACHMENT = /^companies\/[^/]+\/jobs\/[^/]+\/emails\/attachments\/[^/]+\.pdf$/;
function binaryFor(rel: string): MockBinary | undefined {
  return VIEWER_BINARIES[rel] ?? (SAVED_ATTACHMENT.test(rel) ? { size: 18_000, url: resumePdfUrl, at: "2026-01-14T00:00:00.000Z" } : undefined);
}
