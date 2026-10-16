import { PRODUCT_NAME } from "@careeros/brand";
import type { ActionId } from "@careeros/contract";
import { CheckIcon, CloseIcon, FileIcon, LockIcon, VideoIcon, type ComposerIcon } from "./icons";

export interface FileChip { label: string; icon: ComposerIcon; optional: boolean }

/** Friendly names for the files Claude writes, by file name. Anything not named here isn't shown as a chip. */
const FILES: Record<string, { label: string; icon: ComposerIcon }> = {
  "resume.md": { label: "Resume", icon: FileIcon },
  "cover-letter.md": { label: "Cover letter", icon: FileIcon },
  "claims.json": { label: "Claim check", icon: CheckIcon },
  "answers.md": { label: "Answers", icon: FileIcon },
  "score.md": { label: "Fit score", icon: CheckIcon },
  "research.md": { label: "Company research", icon: FileIcon },
  "questions.md": { label: "Interview questions", icon: FileIcon },
  "script.txt": { label: "Script", icon: FileIcon },
  "sources.md": { label: "Sources", icon: FileIcon },
  "notes.md": { label: "Notes", icon: FileIcon },
  "pitch.md": { label: "Pitch", icon: FileIcon },
  "draft.mp4": { label: "Draft video", icon: VideoIcon },
};

/** File chips for "What Claude will create": the outputs, then the optional extras that have a friendly name. */
export function fileChips(outputs: readonly string[], extras: readonly string[]): FileChip[] {
  const name = (p: string) => p.split("/").pop() ?? p;
  const chip = (p: string, optional: boolean): FileChip => {
    const n = name(p);
    // A search report is named by its date.
    const known = FILES[n] ?? (/^\d{4}-\d{2}-\d{2}\.md$/.test(n) ? { label: "Search report", icon: FileIcon } : { label: "File", icon: FileIcon });
    return { ...known, optional };
  };
  return [...outputs.map((p) => chip(p, false)), ...extras.filter((p) => FILES[name(p)]).map((p) => chip(p, true))];
}

const AT = (title: string, company: string) => [title, company].filter(Boolean).join(" at ");

/** The header sentence: what Claude will do, in plain words. `title` and `company` come from the ad. */
export function requestSentence(id: ActionId, info: { title?: string; company?: string }, options: Record<string, unknown> = {}, topic = ""): string {
  const title = info.title ?? "";
  const company = info.company ?? "";
  const job = AT(title, company) || "this job";
  switch (id) {
    case "tailor_application":
      return options.cover_letter === false
        ? `Claude will write a tailored resume and answers for ${job}.`
        : `Claude will write a tailored resume, a cover letter and answers for ${job}.`;
    case "score_job": return `Claude will score how well you fit ${job} and say whether to apply.`;
    case "interview_prep": return `Claude will prepare likely interview questions and answer outlines for ${job}.`;
    case "research_company": return `Claude will research ${company || "this company"} from public pages and cite every fact.`;
    case "find_jobs": return "Claude will search job sites for new ads that match your target roles.";
    case "find_recruiters":
      return `Claude will search the web, directories and job boards for ${typeof options.max_agencies === "number" ? `up to ${options.max_agencies} ` : ""}recruitment agencies for your roles and cities, with the contact details they publish and where each was found.`;
    case "check_recruiters": return "Claude will check the recruiters you added on their own sites and fill in the contact details they publish.";
    case "chrome_check": return "Claude will open each job board in your Chrome and check whether you're signed in.";
    case "study_topic": return `Claude will write a study guide on ${topic || "this topic"} and check its sources on the web.`;
    case "skill_gap_video": return `Claude will make a short lesson video on ${topic || "this topic"}.`;
    case "jd_walkthrough_video": return `Claude will make a short slide video that walks you through the ad for ${job}.`;
    case "company_background_video": return `Claude will make a short slide video about ${company || "this company"}.`;
    case "interview_prep_video": return `Claude will make an interview drill video for ${job}.`;
    case "pitch_video": return `Claude will make a "tell me about yourself" pitch video for ${job}.`;
    case "application_summary_video": return `Claude will make a short recap video of your application for ${job}.`;
    case "weekly_recap_video": return "Your weekly recap video is made by the video maker.";
    case "rewrite_resume":
      return options.scope === "section" ? `Claude will rewrite one section of your resume for ${job}.`
        : options.scope === "bullet" ? `Claude will rewrite one bullet of your resume for ${job}.`
        : `Claude will rewrite your resume for ${job}.`;
    case "suggest_targets": return "Claude will suggest job titles and skills to search for, from your resume only.";
    case "draft_email":
      return options.mode && options.mode !== "new" ? "Claude will rework your email, keeping its facts." : `Claude will draft an email about ${job} from your own files.`;
    case "tailor_resume_variant": return `Claude will write a version of your resume aimed at ${topic || "this focus"}, from your own files only.`;
    case "outreach_note": return `Claude will draft a short note to the hiring manager for ${job}, naming one real result from your files. You send it yourself.`;
  }
}

/** The parts of every request nobody can change, in plain words. */
export const ALWAYS_ON: { label: string; text: string; icon: ComposerIcon }[] = [
  { label: "Only these files", text: `Claude writes only the files listed here, inside your ${PRODUCT_NAME} folder.`, icon: FileIcon },
  { label: "No made-up claims", text: "Every claim must come from your own files. Missing evidence is marked as a gap.", icon: CheckIcon },
  { label: "Private folders stay closed", text: "Your identity and employment folders stay locked. Claude has to ask you first.", icon: LockIcon },
  { label: "Nothing gets sent", text: "Claude never submits applications, forms, emails or messages.", icon: CloseIcon },
];

/** Example wishes shown as chips under the note box. Clicking one adds it to the note. */
export const NOTE_EXAMPLES: Partial<Record<ActionId, string[]>> = {
  tailor_application: ["Lead with my most recent project.", "Use Australian spelling.", "Keep the summary to three lines."],
  score_job: ["Be strict about the must-haves.", "Say what would raise my odds."],
  interview_prep: ["Include questions about my career change.", "Keep each outline short."],
  research_company: ["Look for their engineering blog.", "Note any recent layoffs."],
  find_jobs: ["Prefer remote roles.", "Skip recruitment agencies."],
  find_recruiters: ["Focus on contract roles.", "Include government panels."],
  pitch_video: ["Keep it under a minute.", "Mention why I want this role."],
};
export const DEFAULT_EXAMPLES = ["Keep it short.", "Use Australian spelling."];

/**
 * The prompt for reading on screen: workspace paths shortened so the folder names don't crowd the text. The copied
 * and run prompt keeps the full paths.
 */
export function displayPrompt(prompt: string): string {
  return prompt
    .replace(/companies\/[a-z0-9-]+\/jobs\/[a-z0-9-]+\//g, "…/")
    .replace(/companies\/[a-z0-9-]+\/jobs\/[a-z0-9-]+\b/g, "the job folder")
    .replace(/companies\/[a-z0-9-]+\//g, "…/")
    .replace(/\(folder companies\/[a-z0-9-]+\)/g, "(company folder)");
}
