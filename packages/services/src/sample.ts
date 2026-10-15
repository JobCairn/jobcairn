import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  addEvent, appendSearch, layout, logActivity, newJob, proposeApproval, recordScore, samplePdf, setApprovalStatus, setStatus,
  updateRecord, writeFileAtomic, type Clock, type JobStatus, type WorkRightsLabel,
} from "@careeros/core";
import {
  DEFAULT_RESUME_STYLE, VARIANTS_DIR, withTemplate, type ClaudeRunView, type ResumeAccent, type ResumeLayout, type ResumeStyle, type ScoreRecordArgs,
} from "@careeros/contract";
import { writeStyleIn } from "./resume.js";
import { seedExampleMail } from "./sample-mail.js";
import { seedExampleVideos } from "./sample-videos.js";
import { exampleAddress, exampleClock, jobKey, type ExampleClock, type ExampleIds } from "./sample-shared.js";

export { exampleClock, type ExampleClock } from "./sample-shared.js";

/**
 * "Explore with an example": everything the example workspace holds beyond the bundled samples/alex-example records
 * (which tests count, so they stay as they are). Every person, company, address and link here is made up; addresses
 * and links use the reserved example.com/.org/.net domains. Longer texts (resumes, letters, ads, research, guides)
 * live in the bundled `.example-seed` folder, which is read here and never copied into the workspace as is.
 *
 * Dates are relative to the moment the example is opened, so it never looks stale: the bundled records' dates move
 * forward by whole days (see SAMPLE_ANCHOR) and everything added here is placed "N days ago".
 */

/** The bundled example's own "today". Its dates move so this day lands on the day the example is opened. */
export const SAMPLE_ANCHOR = "2026-01-15";
/** The folder in samples/alex-example with the example's longer texts and media. Never copied into a workspace. */
export const SEED_DIR = ".example-seed";

const DAY = 86_400_000;

/** Whole days from the bundled anchor to `now` (local calendar days). */
export function anchorOffsetDays(now: Date): number {
  const [y, m, d] = SAMPLE_ANCHOR.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(y, m - 1, d)) / DAY);
}

const STAMP = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\b/g;

/**
 * Moves every ISO timestamp in the copied example's records and logs forward by whole days, so the bundled jobs,
 * approvals and logs read as this week's. A moved time that would land in the future is pulled back to an hour ago.
 */
export function shiftBundledDates(root: string, now: Date): void {
  const days = anchorOffsetDays(now);
  if (days === 0) return;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== ".index") walk(p); continue; }
      if (!e.isFile() || !/\.(json|jsonl|md)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, "utf8");
      const moved = text.replace(STAMP, (s) => new Date(Math.min(Date.parse(s) + days * DAY, now.getTime() - 3_600_000)).toISOString());
      if (moved !== text) writeFileAtomic(p, moved);
    }
  };
  walk(root);
}

type Item = ScoreRecordArgs["must_haves"][number];
const met = (text: string, evidence: string): Item => ({ text, status: "met", evidence });
const partial = (text: string, evidence: string): Item => ({ text, status: "partial", evidence });
const notMet = (text: string, evidence: string): Item => ({ text, status: "not_met", evidence });

interface ExampleScore extends ScoreRecordArgs { ago: number }
interface ExampleStep { to: JobStatus; note: string; ago: number; hour?: number }
/** A tailored resume and cover letter for the job, from `.example-seed/jobs/<seed>/`, in the given template. */
interface ExampleApplication { ago: number; template: ResumeLayout; accent: ResumeAccent }

export interface ExampleJob {
  slug: string; company: string; title: string; location: string; work_mode: string; salary: string; site: string;
  /** Days ago the job was found. */
  found: number; label: WorkRightsLabel; quote: string;
  sponsor: { value: number; tier: string; reason: string } | null;
  score?: ExampleScore; steps?: ExampleStep[]; application?: ExampleApplication;
  /** `.example-seed/jobs/<seed>/`: the ad and other texts (defaults to the slug). */
  seed?: string;
  /** The bundled sample's id for this job, when it is one of the bundled three. */
  bundledId?: string;
}

/**
 * The example's jobs. The first three are the bundled sample's (Acme Corp, Example Labs, Acme Recruiting); the rest
 * are added on top each time the example is created.
 */
export const EXAMPLE_JOBS: ExampleJob[] = [
  {
    slug: "acme-corp", bundledId: "2026-01-12-ai-engineer", company: "Acme Corp", title: "AI Engineer", location: "Sampletown NSW", work_mode: "Hybrid",
    salary: "$140k-$160k + super", site: "Greenhouse", found: 3, label: "sponsorship_offered", quote: "Visa sponsorship available for the right candidate.",
    sponsor: { value: 95, tier: "Very high", reason: "ad says sponsorship is available" },
    score: {
      ago: 3, fit: 86, interview_odds: 64, tier: "Freaking Apply Now",
      recommendation: "Apply this week. The ad offers sponsorship and your retrieval and evaluation work matches the core of the role.",
      summary: "A close match. You have built agents and retrieval that cite sources, and the evaluation habit they ask for. The one gap is healthcare or scheduling experience, which is a nice-to-have.",
      must_haves: [
        met("3+ years building software in Python or TypeScript", "Six years across Sampletown Software and Fourth Coffee Digital."),
        met("Hands-on work with LLM APIs and retrieval (RAG) in production", "You lead the retrieval platform behind the support assistant."),
        met("Measuring quality with test sets", "Your nightly suite runs 400 fixed questions and gates releases."),
        partial("Explaining trade-offs to non-engineers", "Mentoring is in your history. No product-facing examples yet."),
      ],
      nice_to_haves: [
        met("Postgres and pgvector", "Your retrieval API runs on Postgres with pgvector."),
        met("Agent frameworks or tool calling", "Your support-reply agent drafts replies from product docs."),
        notMet("Healthcare or scheduling products", "Nothing in your history yet."),
      ],
      changes: ["A short example of explaining an evaluation result to a product manager.", "Any healthcare project, even a small one."],
    },
    steps: [{ to: "Applied", note: "Applied on the careers page with the tailored resume", ago: 2, hour: 9 }],
    application: { ago: 2, template: "modern", accent: "teal" },
  },
  {
    slug: "example-labs", bundledId: "2026-01-12-backend-engineer-llm", company: "Example Labs", title: "Backend Engineer (LLM)", location: "Remote Australia",
    work_mode: "Remote", salary: "$135k-$150k + super", site: "Adzuna", found: 3, label: "silent", quote: "",
    sponsor: { value: 40, tier: "Medium", reason: "remote team that hires across Australia; the ad doesn't mention visas" },
    score: {
      ago: 3, fit: 79, interview_odds: 52, tier: "Good Fit",
      recommendation: "Apply, and ask about sponsorship in the first call. The backend and retrieval match is strong.",
      summary: "Strong on retrieval pipelines and Postgres. You are a little short of their 4 years of pure backend work, and the ad says nothing about visas.",
      must_haves: [
        met("4+ years of backend work in Node.js or TypeScript", "Three years on billing services plus the retrieval API since 2023."),
        met("Production experience with Postgres and queues", "Retrieval API on Postgres; ingestion moved to a queue."),
        met("Built or run a retrieval pipeline", "You own the retrieval API and its ingestion."),
        met("Comfort reading traces and fixing slow paths", "Tracing across 14 services; answer time 6.1 s to 2.4 s."),
      ],
      nice_to_haves: [notMet("Legal or other long documents", "Product docs, but not legal text."), partial("Go", "Basics only.")],
      changes: ["Confirm sponsorship early.", "A small hybrid search demo would cover the legal search angle."],
    },
    steps: [{ to: "Applied", note: "Applied with the backend resume", ago: 2, hour: 15 }],
    application: { ago: 2, template: "technical", accent: "navy" },
  },
  {
    slug: "acme-recruiting", bundledId: "2026-01-12-ai-developer", company: "Acme Recruiting", title: "AI Developer", location: "Sampletown NSW",
    work_mode: "Onsite", salary: "Daily rate", site: "Pasted link", found: 3, label: "citizen_pr_only", quote: "Must be an Australian citizen or permanent resident.",
    sponsor: null,
    steps: [{ to: "Skipped", note: "The client needs citizens or permanent residents", ago: 2, hour: 9 }],
  },
  {
    slug: "brightwater-analytics", company: "Brightwater Analytics", title: "Machine Learning Engineer", location: "Sampletown NSW",
    work_mode: "Hybrid", salary: "$130k-$150k + super", site: "SEEK", found: 14, label: "visa_ok", quote: "Temporary visa holders are welcome to apply.",
    sponsor: { value: 70, tier: "High", reason: "has sponsored engineers before" },
    score: {
      ago: 14, fit: 82, interview_odds: 58, tier: "Good Fit",
      recommendation: "Apply. Lead with evaluation and say plainly that forecasting is new to you.",
      summary: "Your evaluation and LLM output checks fit the explanation work well. Time series forecasting is the gap.",
      must_haves: [
        met("Strong Python and SQL", "Python and SQL across your current role."),
        met("3+ years putting models into production", "LLM features in production since 2023, software since 2020."),
        met("LLMs, prompt design and output checks", "Answers checked against sources before release."),
        partial("Judgement about when a simple model is enough", "The 71% to 83% study shows measured choices."),
      ],
      nice_to_haves: [notMet("Time series forecasting", "Not in your history yet."), partial("Dashboards for non-technical users", "Internal dashboards only.")],
      changes: ["A small forecasting project would close the main gap."],
    },
    steps: [
      { to: "Applied", note: "Applied with the tailored resume and cover letter", ago: 13, hour: 11 },
      { to: "Interview", note: "First interview booked for Thursday", ago: 6, hour: 10 },
    ],
    application: { ago: 13, template: "classic", accent: "ink" },
  },
  {
    slug: "kestrel-robotics", company: "Kestrel Robotics", title: "Conversational AI Developer", location: "Remote Australia",
    work_mode: "Remote", salary: "$120k-$140k", site: "LinkedIn", found: 5, label: "sponsorship_offered", quote: "We can sponsor a visa for the right person.",
    sponsor: { value: 95, tier: "Very high", reason: "ad says sponsorship is available" },
    score: {
      ago: 5, fit: 76, interview_odds: 47, tier: "Good Fit",
      recommendation: "Apply. Sponsorship is offered; show your agent work and be honest about speech APIs.",
      summary: "Good on TypeScript, prompts and agents. Speech-to-text and text-to-speech are new to you.",
      must_haves: [
        met("TypeScript and an LLM API in production", "TypeScript services and LLM features since 2023."),
        notMet("Speech-to-text or text-to-speech APIs", "Not in your history yet."),
        met("Prompt design with tests", "Prompts are covered by your nightly evaluation suite."),
      ],
      nice_to_haves: [
        partial("Products used by frontline or shift workers", "Support staff use your assistant, but not on a shop floor."),
        notMet("Real-time systems or robotics", "Not in your history yet."),
      ],
      changes: ["A weekend voice demo with a speech API would close the gap."],
    },
    steps: [
      { to: "Saved", note: "Saved to apply this week", ago: 5, hour: 16 },
      { to: "Applying", note: "Tailoring the resume", ago: 0, hour: 9 },
    ],
  },
  {
    slug: "harbourline-bank", company: "Harbourline Bank", title: "Applied AI Engineer", location: "Sampletown NSW",
    work_mode: "Onsite", salary: "", site: "Indeed", found: 1, label: "silent", quote: "",
    sponsor: { value: 40, tier: "Medium", reason: "large employer; the ad doesn't mention visas" },
  },
  {
    slug: "juniper-health", company: "Juniper Health", title: "Senior Software Engineer (GenAI)", location: "Remote Australia",
    work_mode: "Remote", salary: "$150k-$170k + super", site: "SEEK", found: 6, label: "citizen_pr_only",
    quote: "You must be an Australian citizen or permanent resident.", sponsor: null,
    steps: [{ to: "Skipped", note: "Needs citizenship or permanent residency", ago: 6, hour: 12 }],
  },
  {
    slug: "northwind-analytics", company: "Northwind Analytics", title: "AI Platform Engineer", location: "Remote Australia",
    work_mode: "Remote", salary: "$135k-$155k + super", site: "LinkedIn", found: 24, label: "visa_ok", quote: "Visa holders are welcome. We have sponsored engineers before.",
    sponsor: { value: 75, tier: "High", reason: "the ad says they have sponsored engineers before" },
    score: {
      ago: 24, fit: 58, interview_odds: 28, tier: "Meh",
      recommendation: "A stretch. Apply only if you can show platform work; Kubernetes is a must-have you don't meet.",
      summary: "You have run LLM APIs in production, but not a shared platform or Kubernetes.",
      must_haves: [
        partial("4+ years of platform or backend engineering", "Backend services since 2020, not platform teams."),
        notMet("Kubernetes in production", "Basics only."),
        met("Running LLM APIs at scale", "Your retrieval platform serves 3 product teams."),
      ],
      nice_to_haves: [
        notMet("Infrastructure as code", "Not in your history yet."),
        met("Internal tools other engineers use", "Your retrieval API is used by 3 product teams."),
      ],
      changes: ["Production Kubernetes experience.", "A platform-style project with a model gateway."],
    },
    steps: [
      { to: "Applied", note: "Applied with the backend-focused resume", ago: 22, hour: 10 },
      { to: "Rejected", note: "They went with someone with more Kubernetes experience", ago: 8, hour: 14 },
    ],
  },
  {
    slug: "contoso-ai", company: "Contoso AI", title: "Applied AI Engineer", location: "Sampletown NSW",
    work_mode: "Hybrid", salary: "$145k-$165k + super", site: "Lever", found: 21, label: "sponsorship_offered", quote: "We sponsor visas (skilled worker visa) for this role.",
    sponsor: { value: 100, tier: "Very high", reason: "ad says sponsorship is available, and they are a verified sponsor" },
    score: {
      ago: 21, fit: 88, interview_odds: 66, tier: "Freaking Apply Now",
      recommendation: "Apply now. Sponsorship is offered and the work is your strongest area.",
      summary: "Agents that read documents and draft text, owned end to end with an evaluation set. That is the work you do today.",
      must_haves: [
        met("3+ years of Python or TypeScript", "Six years across both."),
        met("Shipped at least one LLM feature to production", "Support assistant and the support-reply agent."),
        met("Retrieval and evaluation experience", "Retrieval platform lead; nightly evaluation suite."),
      ],
      nice_to_haves: [
        partial("Insurance or claims work", "Billing systems, not claims."),
        partial("Document parsing", "You run the ingestion for the retrieval API, but not scanned forms."),
      ],
      changes: [],
    },
    steps: [
      { to: "Applying", note: "Tailoring the application", ago: 20, hour: 15 },
      { to: "Applied", note: "Applied on their careers page", ago: 19, hour: 10 },
      { to: "Interview", note: "Two interviews, then a take-home task", ago: 12, hour: 11 },
      { to: "Offer", note: "Written offer received by email", ago: 1, hour: 16 },
    ],
  },
  {
    slug: "fabrikam-health", company: "Fabrikam Health", title: "LLM Engineer", location: "Remote Australia",
    work_mode: "Remote", salary: "$125k-$145k + super", site: "Indeed", found: 17, label: "silent", quote: "",
    sponsor: { value: 20, tier: "Low", reason: "nothing known about sponsorship yet" },
    score: {
      ago: 16, fit: 74, interview_odds: 41, tier: "Good Fit",
      recommendation: "Apply and follow up in two weeks. Speech-to-text output is a gap; evaluation with human review is a strength.",
      summary: "Your evaluation work fits their accuracy loop. You haven't worked with transcripts before.",
      must_haves: [
        met("Python and an LLM API in production", "LLM features in production since 2023."),
        notMet("Experience with speech-to-text output", "Not in your history yet."),
        met("Evaluation with human review", "Hand spot-checks on top of the nightly suite."),
      ],
      nice_to_haves: [
        notMet("Health or other sensitive data", "Not in your history yet."),
        partial("Summarisation of long or messy text", "Your agent drafts replies from product docs. No summaries yet."),
      ],
      changes: ["A transcript-to-summary demo."],
    },
    steps: [{ to: "Applied", note: "Applied by email", ago: 15, hour: 9 }],
  },
  {
    slug: "example-labs", seed: "example-labs-search", company: "Example Labs", title: "AI Engineer, Search Quality", location: "Remote Australia",
    work_mode: "Remote", salary: "$130k-$150k + super", site: "Greenhouse", found: 0, label: "silent", quote: "",
    sponsor: { value: 40, tier: "Medium", reason: "remote team that hires across Australia; the ad doesn't mention visas" },
  },
];

/** The made-up employers added on top of the bundled sample. */
export const EXAMPLE_COMPANIES = EXAMPLE_JOBS.filter((j) => !j.bundledId);

/** Company facts for the Companies screen: size, recruiter, sponsorship evidence. All fictional. */
const COMPANY_FACTS: Record<string, {
  size: string; type?: "employer" | "recruiter"; recruiter?: [string, string];
  sponsor?: { status: "verified" | "to_verify" | "checked_none"; evidence: [number, string][] };
}> = {
  "acme-corp": { size: "201-500", recruiter: ["Riley Chen", "careers"], sponsor: { status: "verified", evidence: [[3, "The AI Engineer ad says visa sponsorship is available."], [40, "Two earlier engineering ads offered sponsorship."]] } },
  "example-labs": { size: "51-200", recruiter: ["Casey Park", "talent"], sponsor: { status: "to_verify", evidence: [[3, "Ads are silent on visas. Ask in the first call."]] } },
  "acme-recruiting": { size: "11-50", type: "recruiter", recruiter: ["Jordan Lee", "jordan.lee"], sponsor: { status: "checked_none", evidence: [[2, "Their government client needs citizens or permanent residents."]] } },
  "brightwater-analytics": { size: "51-200", recruiter: ["Morgan Reid", "morgan.reid"], sponsor: { status: "verified", evidence: [[14, "Ad welcomes visa holders; team page mentions sponsored engineers."]] } },
  "kestrel-robotics": { size: "51-200", sponsor: { status: "verified", evidence: [[5, "The ad says they can sponsor a visa."]] } },
  "contoso-ai": { size: "11-50", recruiter: ["Avery Brooks", "avery.brooks"], sponsor: { status: "verified", evidence: [[21, "The ad says they sponsor visas for this role."], [1, "The written offer includes sponsorship."]] } },
  "northwind-analytics": { size: "501-1000", sponsor: { status: "to_verify", evidence: [[24, "The ad says they have sponsored engineers before."]] } },
  "fabrikam-health": { size: "51-200", recruiter: ["Sam Rivera", "hiring"] },
  "harbourline-bank": { size: "1000+" },
  "juniper-health": { size: "201-500", sponsor: { status: "checked_none", evidence: [[6, "The ad needs citizens or permanent residents."]] } },
};

const read = (seed: string, rel: string): string | null => {
  try { return fs.readFileSync(path.join(seed, ...rel.split("/")), "utf8"); } catch { return null; }
};
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;


function seedJobs(root: string, seed: string, k: ExampleClock): ExampleIds {
  const L = layout(root);
  const ids: ExampleIds = new Map();
  for (const j of EXAMPLE_JOBS) {
    const ad = read(seed, `jobs/${j.seed ?? j.slug}/jd.md`);
    let slug = j.slug;
    let id = j.bundledId ?? "";
    if (!id) {
      const made = newJob(root, {
        company: j.company, title: j.title, url: `https://jobs.example.com/${j.slug}/${slugOf(j.title)}`, source: "ats", source_site: j.site,
        location: j.location, work_mode: j.work_mode, salary_text: j.salary, jd_text: ad ?? `# ${j.title} at ${j.company}\n\nThis is a made-up example ad.\n`,
      }, k.c(j.found, 9, 30));
      slug = made.company_slug;
      id = made.id;
    } else if (ad) {
      writeFileAtomic(path.join(L.jobDir(slug, id), "jd.md"), ad);
    }
    ids.set(jobKey(j.slug, j.title), { slug, id });
    const bundledStatus = j.bundledId ? readStatus(root, slug, id) : "";
    updateRecord("job", L.jobFile(slug, id), (job) => {
      job.source_site = j.site;
      job.location = j.location;
      job.work_mode = j.work_mode;
      job.salary = { ...job.salary, text: j.salary };
      job.apply_via = `https://jobs.example.com/${j.slug}/${slugOf(j.title)}/apply`;
      job.work_rights = { ...job.work_rights, label: j.label, quotes: j.quote ? [j.quote] : [], decided_by: "scan" };
      job.scores.sponsor = j.sponsor ? { value: j.sponsor.value, tier: j.sponsor.tier, reasons: [j.sponsor.reason] } : { value: null, tier: "", reasons: [] };
    });
    if (j.score) {
      const { ago, ...args } = j.score;
      recordScore(root, slug, id, args, k.c(ago, 10, 15));
      writeFileAtomic(path.join(L.jobDir(slug, id), "score.md"), scoreMarkdown(j));
      updateRecord("job", L.jobFile(slug, id), (job) => { job.files.push({ path: "score.md", label: "Score write-up", at: k.at(ago, 10, 15).toISOString() }); });
    }
    if (j.application) seedApplication(root, seed, slug, id, j, k);
    const prep = read(seed, `jobs/${j.seed ?? j.slug}/questions.md`);
    if (prep) {
      const dir = path.join(L.jobDir(slug, id), "interview");
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(path.join(dir, "questions.md"), prep);
    }
    // A bundled job already carries its bundled status (Acme Corp is "Applied" in the sample).
    for (const s of j.steps ?? []) if (s.to !== bundledStatus) setStatus(root, slug, id, s.to, s.note, k.c(s.ago, s.hour ?? 10));
  }
  return ids;
}

function readStatus(root: string, slug: string, id: string): string {
  try { return (JSON.parse(fs.readFileSync(layout(root).jobFile(slug, id), "utf8")) as { status: string }).status; } catch { return ""; }
}

function scoreMarkdown(j: ExampleJob): string {
  const s = j.score!;
  const mark = { met: "Met", partial: "Partly", not_met: "Not yet" } as const;
  const rows = (xs: Item[]) => xs.map((x) => `| ${x.text} | ${mark[x.status]} | ${x.evidence ?? ""} |`);
  const table = (xs: Item[]) => ["| What the ad asks for | You | Evidence |", "|---|---|---|", ...rows(xs), ""];
  return [
    `# Score: ${j.title} at ${j.company}`, "",
    `**Fit ${s.fit}/100 · ${s.tier}.** Interview odds about ${s.interview_odds}%.`, "",
    `> **Recommendation:** ${s.recommendation}`, "",
    s.summary, "",
    "## Must-haves", "", ...table(s.must_haves),
    ...(s.nice_to_haves.length ? ["## Nice to have", "", ...table(s.nice_to_haves)] : []),
    ...(s.changes.length ? ["## What would change this", "", ...s.changes.map((c) => `- ${c}`), ""] : []),
  ].join("\n");
}

const styled = (template: ResumeLayout, accent: ResumeAccent): ResumeStyle => ({ ...withTemplate(DEFAULT_RESUME_STYLE, template), accent });

function seedApplication(root: string, seed: string, slug: string, id: string, j: ExampleJob, k: ExampleClock): void {
  const a = j.application!;
  const dir = path.join(layout(root).jobDir(slug, id), "application");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, label] of [["resume.md", "Tailored resume"], ["cover-letter.md", "Cover letter"]] as const) {
    const text = read(seed, `jobs/${j.seed ?? j.slug}/${name}`);
    if (!text) continue;
    writeFileAtomic(path.join(dir, name), text);
    writeStyleIn(dir, name, styled(a.template, a.accent));
    const t = k.at(a.ago, 8, 40);
    fs.utimesSync(path.join(dir, name), t, t);
    updateRecord("job", layout(root).jobFile(slug, id), (job) => { job.files.push({ path: `application/${name}`, label, at: t.toISOString() }); });
  }
  addEvent(root, slug, id, "Application files ready", "Tailored resume and cover letter", k.c(a.ago, 8, 45));
}

function seedCompanies(root: string, k: ExampleClock): void {
  const L = layout(root);
  for (const [slug, f] of Object.entries(COMPANY_FACTS)) {
    if (!fs.existsSync(L.companyFile(slug))) continue;
    updateRecord("company", L.companyFile(slug), (c) => {
      c.website = `https://example.com/${slug}`;
      c.size = f.size;
      if (f.type) c.type = f.type;
      else if (c.type === "unknown") c.type = "employer";
      if (f.recruiter) c.recruiter = { name: f.recruiter[0], email: exampleAddress(f.recruiter[1]) };
      if (f.sponsor) {
        c.sponsor = {
          status: f.sponsor.status,
          evidence: f.sponsor.evidence.map(([ago, note]) => ({ date: localDate(k.at(ago)), note, url: `https://example.com/${slug}/careers` })),
          last_checked: localDate(k.at(Math.min(...f.sponsor.evidence.map(([ago]) => ago)))),
        };
      }
    });
  }
}

function copyText(seed: string, from: string, to: string, at?: Date): boolean {
  const text = read(seed, from);
  if (text === null) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  writeFileAtomic(to, text);
  if (at) fs.utimesSync(to, at, at);
  return true;
}

function seedResumes(root: string, seed: string, k: ExampleClock): void {
  const me = layout(root).me("resumes");
  fs.mkdirSync(me, { recursive: true });
  copyText(seed, "resumes/alex-example-resume.md", path.join(me, "alex-example-resume.md"), k.at(25, 20));
  // People usually keep a PDF too: a plain one-page sample.
  const pdf = path.join(me, "alex-example-resume.pdf");
  writeFileAtomic(pdf, samplePdf([
    "Alex Example", "Senior AI Engineer | Retrieval, agents and evaluation", `${exampleAddress("alex")} | 0491 570 006 | Sampletown NSW`,
    "Sampletown Software, Senior AI Engineer, 2023 to now", "Fourth Coffee Digital, Software Developer, 2020 to 2023", "Example University, BSc Computer Science",
  ]));
  fs.utimesSync(pdf, k.at(4, 9), k.at(4, 9));
  copyText(seed, "history/roles.md", path.join(layout(root).me("history"), "roles.md"), k.at(25, 20));
  const variants: [string, string, number, ResumeLayout, ResumeAccent][] = [
    ["backend-focused", "Backend-focused", 23, "compact", "slate"],
    ["evaluation-and-research", "Evaluation and research", 9, "split", "plum"],
  ];
  for (const [v, name, ago, template, accent] of variants) {
    const dir = path.join(root, VARIANTS_DIR, v);
    if (!copyText(seed, `variants/${v}/resume.md`, path.join(dir, "resume.md"), k.at(ago, 14, 30))) continue;
    writeFileAtomic(path.join(dir, "variant.json"), `${JSON.stringify({ name, created_at: k.at(ago, 14).toISOString() }, null, 2)}\n`);
    writeStyleIn(dir, "resume.md", styled(template, accent));
  }
}

function seedResearch(root: string, seed: string, k: ExampleClock): void {
  const ago: Record<string, number> = { "acme-corp": 3, "example-labs": 2, "brightwater-analytics": 13, "contoso-ai": 20 };
  for (const [slug, d] of Object.entries(ago)) copyText(seed, `research/${slug}.md`, path.join(layout(root).companyDir(slug), "research.md"), k.at(d, 12, 5));
  writeFileAtomic(path.join(layout(root).companyDir("contoso-ai"), "notes.md"), [
    "# Notes", "",
    "- Interviewers: the hiring manager and two engineers. Friendly, practical questions.",
    "- Take-home: an evaluation set for a claims letter agent. Took about 4 hours.",
    "- The offer arrived by email. Compare it with the checklist in the research before saying yes.", "",
  ].join("\n"));
}

function seedLearning(root: string, seed: string, k: ExampleClock): void {
  const L = layout(root);
  copyText(seed, "learning/evaluating-llm-apps/guide.md", path.join(L.learning, "evaluating-llm-apps", "guide.md"), k.at(4, 20, 4));
  copyText(seed, "learning/vector-search/guide.md", path.join(L.learning, "vector-search", "guide.md"), k.at(1, 20, 4));
  const progress = {
    "learning/rag-pipelines/guide.md": { state: "done", at: k.at(10, 20).toISOString() },
    "learning/evaluating-llm-apps/guide.md": { state: "in_progress", at: k.at(1, 21).toISOString() },
  };
  fs.mkdirSync(path.join(root, ".careeros"), { recursive: true });
  writeFileAtomic(path.join(root, ".careeros", "learn-progress.json"), `${JSON.stringify(progress, null, 2)}\n`);
}

function seedInbox(root: string, seed: string, k: ExampleClock): void {
  const inbox = layout(root).inbox;
  fs.mkdirSync(inbox, { recursive: true });
  const files: [string, number][] = [["reference-letter-sampletown-software.md", 0], ["evaluation-course-certificate.txt", 1], ["portfolio-project-notes.md", 2]];
  for (const [name, ago] of files) copyText(seed, `inbox/${name}`, path.join(inbox, name), k.at(ago, 18));
  // Older filings go before the bundled one (the log is oldest first).
  const log = path.join(inbox, "_filed.md");
  let bundled = "";
  try { bundled = fs.readFileSync(log, "utf8"); } catch { bundled = ""; }
  writeFileAtomic(log, [
    `- ${k.at(25, 20).toISOString()} | alex-example-resume.md -> me/resumes/alex-example-resume.md | Master resume`,
    `- ${k.at(12, 19).toISOString()} | contoso-take-home-notes.md -> companies/contoso-ai/notes.md | Take-home notes`,
  ].join("\n") + "\n" + bundled);
}

/** Searches over the last two weeks. Each day's "Find jobs" run also wrote a report with the per-query table. */
const SEARCHES: { ago: number; hour: number; site: string; query: string; location: string; results: string; kept: string; notes: string; mode: "chrome" | "web" }[] = [
  { ago: 13, hour: 8, site: "LinkedIn", query: "ai engineer", location: "Sampletown NSW", results: "64", kept: "1", notes: "kept Brightwater Analytics; most others need citizenship", mode: "chrome" },
  { ago: 13, hour: 8, site: "SEEK", query: "machine learning engineer", location: "Sampletown NSW", results: "38", kept: "0", notes: "Brightwater Analytics again; already kept", mode: "chrome" },
  { ago: 9, hour: 7, site: "Indeed", query: "llm engineer", location: "Remote Australia", results: "41", kept: "1", notes: "kept Fabrikam Health", mode: "chrome" },
  { ago: 9, hour: 7, site: "Lever", query: "applied ai engineer", location: "Sampletown NSW", results: "9", kept: "1", notes: "kept Contoso AI, which offers sponsorship", mode: "web" },
  { ago: 6, hour: 8, site: "SEEK", query: "senior software engineer genai", location: "Remote Australia", results: "52", kept: "0", notes: "Juniper Health needs citizenship; skipped", mode: "chrome" },
  { ago: 5, hour: 8, site: "LinkedIn", query: "conversational ai developer", location: "Remote Australia", results: "23", kept: "1", notes: "kept Kestrel Robotics, which offers sponsorship", mode: "chrome" },
  { ago: 3, hour: 7, site: "Greenhouse", query: "ai engineer agents", location: "Sampletown NSW", results: "12", kept: "1", notes: "kept Acme Corp, which offers sponsorship", mode: "web" },
  { ago: 3, hour: 7, site: "Adzuna", query: "backend engineer llm", location: "Remote Australia", results: "87 (about 20 relevant)", kept: "1", notes: "kept Example Labs", mode: "web" },
  { ago: 1, hour: 8, site: "Indeed", query: "applied ai engineer bank", location: "Sampletown NSW", results: "17", kept: "1", notes: "kept Harbourline Bank; the ad is silent on visas", mode: "chrome" },
  { ago: 0, hour: 7, site: "Greenhouse", query: "search quality engineer", location: "Remote Australia", results: "6", kept: "1", notes: "kept Example Labs (a second role)", mode: "web" },
  { ago: 0, hour: 7, site: "LinkedIn", query: "ai engineer visa sponsorship", location: "Remote Australia", results: "31", kept: "0", notes: "nothing new; all seen before", mode: "chrome" },
];

function seedSearches(root: string, k: ExampleClock): { rel: string; ago: number }[] {
  for (const s of SEARCHES) {
    appendSearch(root, { site: s.site, query: s.query, location: s.location, results: s.results, kept: s.kept, notes: s.notes, mode: s.mode, at: k.at(s.ago, s.hour, 20).toISOString() });
  }
  const reports: { rel: string; ago: number }[] = [];
  for (const ago of [...new Set(SEARCHES.map((s) => s.ago))]) {
    const rows = SEARCHES.filter((s) => s.ago === ago);
    const kept = rows.reduce((n, r) => n + (parseInt(r.kept, 10) || 0), 0);
    const md = [
      "# Job search report", "",
      `> **TL;DR:** ${rows.length} search${rows.length === 1 ? "" : "es"}, ${kept} new job${kept === 1 ? "" : "s"} kept. Searches run in the last 7 days were skipped.`, "",
      "## Searches", "",
      "| Board | Query | Location | Searched in | Results | Kept | Notes |", "|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.site} | ${r.query} | ${r.location} | ${r.mode === "chrome" ? "Your Chrome" : "Web search"} | ${r.results} | ${r.kept} | ${r.notes} |`), "",
      "## How jobs were picked", "",
      "- Kept: AI and LLM roles at companies that sponsor, or might.",
      "- Dropped: ads that need citizenship, permanent residency or a security clearance.",
      "- Every kept ad was read in full for its work-rights wording.", "",
    ].join("\n");
    const rel = `knowledge/job-searches/${localDate(k.at(ago, 7))}.md`;
    fs.mkdirSync(path.join(root, "knowledge", "job-searches"), { recursive: true });
    writeFileAtomic(path.join(root, ...rel.split("/")), md);
    reports.push({ rel, ago });
  }
  return reports;
}

const runId = (at: Date, key: string) => `r-${Math.floor(at.getTime() / 1000).toString(36)}-${crypto.createHash("sha256").update(`${key}|${at.toISOString()}`).digest("hex").slice(0, 8)}`;

/** Finished Claude runs, so the activity lists show what Claude did and when. */
function seedRuns(root: string, ids: ExampleIds, reports: { rel: string; ago: number }[], k: ExampleClock): void {
  const dir = path.join(root, ".careeros", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const run = (o: {
    action: ClaudeRunView["action"]; target: ClaudeRunView["target"]; key: string; ago: number; hour: number; minutes: number; summary: string;
    files: [string, string][]; steps: string[]; cost: number; turns: number;
  }) => {
    const start = k.at(o.ago, o.hour);
    const ms = o.minutes * 60_000;
    const r: ClaudeRunView = {
      id: runId(start, o.key), action: o.action, target: o.target, key: o.key, status: "succeeded", started_at: start.toISOString(),
      ended_at: new Date(start.getTime() + ms).toISOString(), elapsed_ms: ms,
      steps: o.steps.map((label, i) => ({ label, state: "done", at: new Date(start.getTime() + ((i + 1) * ms) / (o.steps.length + 1)).toISOString() })),
      summary: o.summary, files: o.files.map(([p, label]) => ({ path: p, label, expected: true })), missing: [], stray: [], error: "", cost_usd: o.cost, turns: o.turns,
    };
    writeFileAtomic(path.join(dir, `${r.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
  };
  for (const { rel, ago } of reports) {
    run({
      action: "find_jobs", target: { kind: "workspace" }, key: "find_jobs--workspace", ago, hour: 7, minutes: 9, cost: 0.42, turns: 31,
      summary: "Searched the job boards and kept the AI roles that might sponsor.", files: [[rel, "Search report"]],
      steps: ["Reading your search settings", "Searching the boards", "Reading each ad's work-rights wording", "Writing the search report"],
    });
  }
  for (const j of EXAMPLE_JOBS) {
    const ref = ids.get(jobKey(j.slug, j.title));
    if (!ref) continue;
    const target = { kind: "job" as const, company_slug: ref.slug, id: ref.id };
    const base = `companies/${ref.slug}/jobs/${ref.id}`;
    if (j.score) {
      run({
        action: "score_job", target, key: `score_job--${ref.slug}--${ref.id}`, ago: j.score.ago, hour: 10, minutes: 3, cost: 0.11, turns: 9,
        summary: `Fit ${j.score.fit}/100 · ${j.score.tier}.`, files: [[`${base}/score.md`, "Score"]],
        steps: ["Reading the ad", "Checking your resume and history", "Scoring the must-haves"],
      });
    }
    if (j.application) {
      run({
        action: "tailor_application", target, key: `tailor_application--${ref.slug}--${ref.id}`, ago: j.application.ago, hour: 8, minutes: 6, cost: 0.37, turns: 22,
        summary: "Tailored resume and cover letter ready. Every claim traces to your history.",
        files: [[`${base}/application/resume.md`, "Resume"], [`${base}/application/cover-letter.md`, "Cover letter"]],
        steps: ["Reading the ad and your score", "Choosing the strongest evidence", "Writing the resume", "Writing the cover letter", "Checking every claim"],
      });
    }
  }
  for (const [slug, title, ago] of [["brightwater-analytics", "Machine Learning Engineer", 6], ["example-labs", "Backend Engineer (LLM)", 1]] as const) {
    const ref = ids.get(jobKey(slug, title));
    if (!ref) continue;
    run({
      action: "interview_prep", target: { kind: "job", company_slug: ref.slug, id: ref.id }, key: `interview_prep--${ref.slug}--${ref.id}`, ago, hour: 19, minutes: 4,
      cost: 0.18, turns: 12, summary: "Likely questions, your best evidence and a short pitch.",
      files: [[`companies/${ref.slug}/jobs/${ref.id}/interview/questions.md`, "Interview questions"]],
      steps: ["Reading the ad and the research", "Writing likely questions", "Matching your evidence"],
    });
  }
  for (const [slug, ago] of [["contoso-ai", 20], ["brightwater-analytics", 13], ["acme-corp", 3], ["example-labs", 2]] as const) {
    run({
      action: "research_company", target: { kind: "company", company_slug: slug }, key: `research_company--${slug}`, ago, hour: 12, minutes: 5, cost: 0.24, turns: 17,
      summary: "Company research with sponsorship evidence.", files: [[`companies/${slug}/research.md`, "Company research"]],
      steps: ["Reading the careers page", "Checking sponsorship evidence", "Writing the research"],
    });
  }
  for (const [topic, label, ago] of [["evaluating-llm-apps", "Evaluating LLM apps", 4], ["vector-search", "Vector search", 1]] as const) {
    run({
      action: "study_topic", target: { kind: "topic", topic, label }, key: `study_topic--topic-${topic}`, ago, hour: 20, minutes: 4, cost: 0.15, turns: 8,
      summary: "Study guide ready.", files: [[`learning/${topic}/guide.md`, "Study guide"]], steps: ["Finding what your saved jobs ask for", "Writing the guide"],
    });
  }
}

function seedApprovals(root: string, ids: ExampleIds, k: ExampleClock): void {
  const bright = ids.get(jobKey("brightwater-analytics", "Machine Learning Engineer"));
  if (bright) {
    const a = proposeApproval(root, {
      action: "status_change", title: "Move Brightwater Analytics to Interview", summary: "Claude found an interview invite in your mail.",
      steps: ["Set the job status to Interview", 'Add a timeline event "Status: Interview"'],
      payload: { company_slug: bright.slug, id: bright.id, status: "Interview", note: "First interview booked for Thursday" }, created_by: "claude",
    }, k.c(6, 9, 50));
    setApprovalStatus(root, a.id, "approved", "", k.c(6, 9, 58));
    setApprovalStatus(root, a.id, "done", "Status changed", k.c(6, 10));
  }
  const kestrel = ids.get(jobKey("kestrel-robotics", "Conversational AI Developer"));
  if (kestrel) {
    proposeApproval(root, {
      action: "apply_handoff", title: "Apply to Kestrel Robotics", summary: "Open the application page and apply yourself. Your tailored files are in the job's folder.",
      steps: ["Open the application page in your browser", "You fill in and send the form yourself", 'Then mark the job "Applied"'],
      payload: { company_slug: kestrel.slug, id: kestrel.id, url: "https://jobs.example.com/kestrel-robotics/conversational-ai-developer/apply" }, created_by: "claude",
    }, k.c(0, 9, 30));
  }
}

function seedSettings(root: string, k: ExampleClock): void {
  const L = layout(root);
  const expiry = new Date(k.now);
  expiry.setMonth(expiry.getMonth() + 17);
  updateRecord("profile", L.profile, (p) => { p.work_rights.visa_expiry = localDate(expiry); });
  const deadline = new Date(k.now);
  deadline.setDate(deadline.getDate() + 75);
  updateRecord("search", L.search, (s) => { s.search_deadline = localDate(deadline); s.weekly_goal = 4; });
  // Gmail is never connected in the example (no password is ever saved); the address only names Alex on the made-up mail.
  updateRecord("integrations", L.integrations, (i) => {
    i.mail.address = exampleAddress("alex");
    i.mail.display_name = "Alex Example";
    i.mail.signature = "Alex Example\nSenior AI Engineer | 0491 570 006";
  });
}

/** The bundled files were copied just now: give them the times they would have had, and tidy the bundled records. */
function settleBundled(root: string, ids: ExampleIds, k: ExampleClock): void {
  const L = layout(root);
  const acme = ids.get(jobKey("acme-corp", "AI Engineer"));
  const touch = (p: string, at: Date) => { try { fs.utimesSync(p, at, at); } catch { /* not in this copy */ } };
  touch(path.join(L.learning, "rag-pipelines", "guide.md"), k.at(12, 20));
  touch(path.join(L.me("history"), "roles.md"), k.at(25, 20));
  if (acme) touch(path.join(L.jobDir(acme.slug, acme.id), "interview", "questions.md"), k.at(2, 19));
  for (const [slug, title, ago] of [["brightwater-analytics", "Machine Learning Engineer", 6], ["example-labs", "Backend Engineer (LLM)", 1]] as const) {
    const ref = ids.get(jobKey(slug, title));
    if (ref) touch(path.join(L.jobDir(ref.slug, ref.id), "interview", "questions.md"), k.at(ago, 19, 4));
  }
  // The bundled approval for Example Labs now has an invite email behind it.
  const dir = path.join(root, ".careeros", "approvals");
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, name);
    updateRecord("approval", file, (a) => {
      if (a.status === "pending" && a.action === "status_change" && a.payload.company_slug === "example-labs") {
        a.summary = "Claude found an interview invite in your mail.";
        a.payload = { ...a.payload, note: "Technical interview invite" };
      }
    });
  }
}

/** Timelines in time order: the seeding adds events out of order, the app always appends in order. */
function sortTimelines(root: string, ids: ExampleIds): void {
  for (const { slug, id } of ids.values()) {
    updateRecord("job", layout(root).jobFile(slug, id), (j) => { j.timeline = j.timeline.map((e, i) => ({ e, i })).sort((a, b) => a.e.at.localeCompare(b.e.at) || a.i - b.i).map((x) => x.e); });
  }
}

function seedActivity(root: string, k: ExampleClock): void {
  const lines: [number, number, string, string][] = [
    [14, 10, "Claude read a file", "Your resume, to score Brightwater Analytics"],
    [6, 10, "Approval done", "Move Brightwater Analytics to Interview"],
    [2, 8, "Claude read a file", "Your work history, to tailor the Acme Corp resume"],
  ];
  for (const [ago, hour, event, detail] of lines) logActivity(root, event, detail, k.c(ago, hour));
}

/**
 * Fills the example workspace copied to `root`. `src` is the bundled samples/alex-example folder (for `.example-seed`).
 * Writes only inside `root`. Mail is stored the way a sync stores it.
 */
export async function seedExample(root: string, src: string, now: Date): Promise<void> {
  const seed = path.join(src, SEED_DIR);
  const k = exampleClock(now);
  shiftBundledDates(root, now);
  seedSettings(root, k);
  const ids = seedJobs(root, seed, k);
  seedCompanies(root, k);
  seedResumes(root, seed, k);
  seedResearch(root, seed, k);
  seedLearning(root, seed, k);
  seedInbox(root, seed, k);
  seedRuns(root, ids, seedSearches(root, k), k);
  seedApprovals(root, ids, k);
  seedActivity(root, k);
  await seedExampleMail(root, ids, k);
  seedExampleVideos(root, seed, k);
  settleBundled(root, ids, k);
  sortTimelines(root, ids);
}
