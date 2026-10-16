import { ACTIONS, isActiveRun, type ActionId, type ClaudeRunStatus, type ClaudeRunView } from "@careeros/contract";
import type { Route } from "../router";

/** Where "Open" takes a run: its job's Activity tab, the screen it belongs to, or nowhere (details stay in the panel). */
export function runRoute(run: ClaudeRunView): Route | null {
  const t = run.target;
  if (!t) return null;
  if (t.kind === "job") return { screen: "job", slug: t.company_slug, id: t.id, tab: "activity" };
  if (t.kind === "topic") {
    if (t.company_slug && t.id) return { screen: "job", slug: t.company_slug, id: t.id, tab: "activity" };
    return { screen: "learn", topic: t.topic };
  }
  if (t.kind === "workspace") return run.action === "find_jobs" ? { screen: "jobs" } : null;
  if (t.kind === "resume_variant") return { screen: "resumes" };
  return null;
}

/** The runs that belong on a job's Activity tab: the job's own, its company's, and its skill-gap topics'. */
export function runsForJob(runs: readonly ClaudeRunView[], slug: string, id: string): ClaudeRunView[] {
  return runs.filter((r) => {
    const t = r.target;
    if (!t) return false;
    if (t.kind === "job") return t.company_slug === slug && t.id === id;
    if (t.kind === "company") return t.company_slug === slug;
    if (t.kind === "topic") return t.company_slug === slug && t.id === id;
    return false;
  });
}

/** Each run's status, to compare against the next read. */
export function statusSnapshot(runs: readonly ClaudeRunView[]): Map<string, ClaudeRunStatus> {
  return new Map(runs.map((r) => [r.id, r.status]));
}

/** Runs that were queued or running last time and have ended since. */
export function finishedSince(before: ReadonlyMap<string, ClaudeRunStatus>, runs: readonly ClaudeRunView[]): ClaudeRunView[] {
  return runs.filter((r) => {
    const was = before.get(r.id);
    return was !== undefined && isActiveRun(was) && !isActiveRun(r.status);
  });
}

/** A run of one of the catalogue's actions (not the setup test or the video maker's script writer). */
export function isActionRun(run: ClaudeRunView): run is ClaudeRunView & { action: ActionId } {
  return run.action !== "test" && run.action !== "video_script" && run.action !== "inbox_suggest";
}

/** The action's name for a run, including the setup test run and the video script writer. */
export function runLabel(run: Pick<ClaudeRunView, "action">): string {
  return run.action === "test" ? "Test run" : run.action === "video_script" ? "Video script" : run.action === "inbox_suggest" ? "Drop box suggestion" : ACTIONS[run.action]?.label ?? "Claude task";
}

/** What a finished run made, for toasts: "Score ready". */
export function doneText(run: Pick<ClaudeRunView, "action">): string {
  return run.action === "test" ? "Test run passed" : run.action === "video_script" ? "Script ready: review it to make the video" : run.action === "inbox_suggest" ? "Suggestion ready" : ACTIONS[run.action]?.done ?? "Done";
}

/** A short verb for the inline status chip: "Researching · 0:20". */
export function chipVerb(action: ClaudeRunView["action"]): string {
  switch (action) {
    case "test": return "Testing";
    case "video_script": return "Writing the script";
    case "inbox_suggest": return "Sorting";
    case "find_jobs": return "Finding jobs";
    case "chrome_check": return "Checking your boards";
    case "score_job": return "Scoring";
    case "tailor_application": return "Tailoring";
    case "interview_prep": return "Preparing";
    case "research_company": return "Researching";
    case "study_topic": return "Writing guide";
    case "rewrite_resume": return "Rewriting";
    case "draft_email": return "Drafting";
    case "outreach_note": return "Drafting";
    case "recruiter_email": return "Drafting";
    case "recruiter_job_email": return "Drafting";
    case "tailor_resume_variant": return "Writing";
    default: return ACTIONS[action]?.group === "video" ? "Making video" : "Working";
  }
}

/**
 * Where a finished run's result lives, and what to call the link: "Open score" goes to the job's Score tab.
 * Falls back to the run's own place (runRoute) with "Open".
 */
export function resultLink(run: ClaudeRunView): { label: string; to: Route | null } {
  const t = run.target;
  if (!t) return { label: "Open", to: null };
  const job = t.kind === "job" ? { slug: t.company_slug, id: t.id } : t.kind === "topic" && t.company_slug && t.id ? { slug: t.company_slug, id: t.id } : null;
  if (run.status === "succeeded") {
    switch (run.action) {
      case "score_job": if (job) return { label: "Open score", to: { screen: "job", ...job, tab: "score" } }; break;
      case "interview_prep": if (job) return { label: "Open questions", to: { screen: "job", ...job, tab: "interview" } }; break;
      case "draft_email": if (job) return { label: "Open mail", to: { screen: "job", ...job, tab: "mail" } }; break;
      case "outreach_note": if (job) return { label: "Open note", to: { screen: "job", ...job, tab: "outreach" } }; break;
      case "tailor_application": if (job) return { label: "Review application", to: { screen: "apply", ...job, step: "review" } }; break;
      case "find_jobs": return { label: "Open jobs", to: { screen: "jobs" } };
      case "study_topic": if (t.kind === "topic") return { label: "Open guide", to: { screen: "learn", topic: t.topic } }; break;
      case "tailor_resume_variant": if (t.kind === "resume_variant") return { label: "Open resume", to: { screen: "resume-variant", variant: t.variant } }; break;
      default: break;
    }
  }
  return { label: "Open", to: runRoute(run) };
}
