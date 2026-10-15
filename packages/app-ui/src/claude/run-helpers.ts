import { useEffect, useRef, useState } from "react";
import { ACTIONS, isActiveRun, type ActionId, type ActionTarget, type ClaudeRunView } from "@careeros/contract";
import { useLoad } from "../bridge-context";

/** 0:42, 12:05, 1:02:03. Local to the run panel. */
/** A cost estimate in US dollars, for run details and the monthly total. Never shown on the action buttons. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "under $0.01";
  return `$${usd.toFixed(2)}`;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Counts on locally between updates from main, so the clock moves every second. */
export function useElapsed(run: ClaudeRunView | null): number {
  const base = useRef<{ id: string; ms: number; at: number } | null>(null);
  const [, setTick] = useState(0);
  const active = !!run && isActiveRun(run.status);
  if (run && (base.current?.id !== run.id || base.current.ms !== run.elapsed_ms)) base.current = { id: run.id, ms: run.elapsed_ms, at: Date.now() };
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [active]);
  if (!run || !base.current) return 0;
  return active ? base.current.ms + (Date.now() - base.current.at) : run.elapsed_ms;
}

const STRAY_TAG = / \((deleted|link)\)$/;
/** OS and tool clutter (".DS_Store", "Thumbs.db", anything inside a dot-folder): never worth a person's attention. */
const JUNK = /^(thumbs\.db|desktop\.ini|icon\r)$/i;
export function isJunkFile(rel: string): boolean {
  const parts = rel.replace(STRAY_TAG, "").split("/").filter(Boolean);
  return parts.some((p) => p.startsWith(".")) || JUNK.test(parts.at(-1) ?? "");
}
/** The changed-elsewhere files worth showing: no dot-files or OS clutter. */
export function visibleStray(stray: readonly string[]): string[] {
  return stray.filter((p) => !isJunkFile(p));
}
/** A stray path without its "(deleted)" or "(link)" tag, for Show; null when the file is gone. */
export function strayPath(rel: string): string | null {
  const m = STRAY_TAG.exec(rel);
  return m?.[1] === "deleted" ? null : m ? rel.slice(0, -m[0].length) : rel;
}

/** "profile.json in settings" rather than a raw path. */
export function strayName(rel: string): string {
  const m = / \((deleted|link)\)$/.exec(rel);
  const tag = m ? (m[1] === "link" ? " (a shortcut link)" : " (deleted)") : "";
  const p = m ? rel.slice(0, -m[0].length) : rel;
  if (!p.includes("/")) return `${p}${tag}`;
  const parts = p.split("/");
  return `${parts.at(-1)} in ${parts.at(-2)}${tag}`;
}

/** "Researching Acme Corp…": what the run is doing, with the job or company it is for. */
export function workingTitle(action: ActionId, subject: { title?: string; company?: string }): string {
  const job = subject.title ? `"${subject.title}"${subject.company ? ` at ${subject.company}` : ""}` : "this job";
  const company = subject.company ?? "the company";
  switch (action) {
    case "find_jobs": return "Finding jobs…";
    case "score_job": return `Scoring ${job}…`;
    case "tailor_application": return `Tailoring your resume and cover letter for ${job}…`;
    case "interview_prep": return `Preparing interview questions for ${job}…`;
    case "research_company": return `Researching ${company}…`;
    default: return `${ACTIONS[action].label.replace(/^Make /, "Making ")}…`;
  }
}

/** The job title and company name for the panel's title (best effort; the panel works without them). */
export function useSubject(target: ActionTarget): { title?: string; company?: string } {
  const slug = target.kind === "job" || target.kind === "company" ? target.company_slug : target.kind === "topic" ? target.company_slug : undefined;
  const id = target.kind === "job" ? target.id : target.kind === "topic" ? target.id : undefined;
  const r = useLoad(async (b) => {
    if (slug && id) { const d = await b.jobs.get(slug, id); return { title: d.job.title, company: d.company?.name }; }
    if (slug) { const l = await b.jobs.list({ limit: 500 }); return { company: l.rows.find((x) => x.company_slug === slug)?.company_name }; }
    return {};
  }, [slug, id], []);
  return r.data ?? {};
}

