import { layout, listJobs, readRecord, type Job } from "@careeros/core";
import type { WeekStats } from "./types.js";

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The ISO week a date falls in, computed in UTC so every laptop agrees. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

/** Monday and Sunday (`YYYY-MM-DD`, UTC) of an ISO week. Throws on a week that does not exist. */
export function weekRange(week: string): { from: string; to: string } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`"${week}" is not a week.`);
  const y = Number(m[1]), w = Number(m[2]);
  const jan4 = Date.UTC(y, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * DAY + (w - 1) * 7 * DAY;
  if (w < 1 || isoWeek(new Date(monday)) !== week) throw new Error(`"${week}" is not a week.`);
  return { from: ymd(monday), to: ymd(monday + 6 * DAY) };
}

const ACTION: Partial<Record<Job["status"], [number, string]>> = {
  Interview: [0, "Prepare for the interview"], Applying: [1, "Finish the application"],
  Found: [2, "Decide whether to apply"], Saved: [2, "Decide whether to apply"], Applied: [3, "Watch for a reply"],
};

/** The week in numbers, from the job files (the same records the index holds). */
export function weekStats(root: string, week: string): WeekStats {
  const { from, to } = weekRange(week);
  const inWeek = (at: string) => { const d = at.slice(0, 10); return d >= from && d <= to; };
  const s: WeekStats = {
    week, from, to, found: 0, applied: 0, replies: 0, interviews: 0,
    sponsorship: { sponsorship_offered: 0, visa_ok: 0, silent: 0, citizen_pr_only: 0, clearance: 0 }, next_steps: [],
  };
  const steps: { rank: number; at: string; title: string; company: string; action: string }[] = [];
  const names = new Map<string, string>();
  for (const ref of listJobs(root)) {
    let job: Job;
    try { job = readRecord("job", ref.file); } catch { continue; }
    if (!names.has(job.company_slug)) {
      let name = job.company_slug;
      try { name = readRecord("company", layout(root).companyFile(job.company_slug)).name || name; } catch { /* keep the slug */ }
      names.set(job.company_slug, name);
    }
    if (inWeek(job.found_at)) { s.found++; s.sponsorship[job.work_rights.label]++; }
    for (const e of job.timeline) {
      if (!inWeek(e.at)) continue;
      if (e.event === "Status: Applied") s.applied++;
      else if (e.event === "Status: Interview") s.interviews++;
      else if (/^Email received/i.test(e.event)) s.replies++;
    }
    const a = ACTION[job.status];
    const ruledOut = job.work_rights.label === "citizen_pr_only" || job.work_rights.label === "clearance";
    if (a && !(ruledOut && a[0] === 2)) steps.push({ rank: a[0], at: job.found_at, title: job.title, company: names.get(job.company_slug)!, action: a[1] });
  }
  steps.sort((x, y) => x.rank - y.rank || y.at.localeCompare(x.at) || x.title.localeCompare(y.title));
  s.next_steps = steps.slice(0, 3).map(({ title, company, action }) => ({ title, company, action }));
  return s;
}
