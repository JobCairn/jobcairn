// Dev-preview data sets for the mock bridge. Everything here is fictional (Alex Example and made-up
// "Acme"/"Example" employers). Tests use the plain fixture; the dev preview picks a scenario with
// `?data=full` (default), `?data=small` (the sample workspace only) or `?data=empty`.
import { WR_STATUSES, type JobRecord, type JobStatus, type WorkRightsLabel } from "@careeros/contract";
import type { Fixture, FixtureCompany, FixtureJob } from "./fixture-types";
import { loadFixture, type MockOptions } from "./MockBridge";

const DAY = 86_400_000;
export const SCENARIO_NOW = new Date("2026-01-15T09:00:00.000Z");

/** A small deterministic random source, so the preview looks the same on every load. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return (s >>> 8) / 0x1000000; };
}

const EMPLOYERS = [
  "Acme Analytics", "Example Health", "Acme Bank", "Example Telecom", "Acme Logistics", "Example Insurance", "Acme Retail Group",
  "Example Energy", "Acme Consulting", "Example Media", "Acme Software", "Example Data Co", "Acme Robotics", "Example Fintech",
];
const TITLES = [
  "AI Engineer", "Senior AI Engineer", "Applied AI Engineer", "Software Engineer, GenAI", "Backend Engineer (LLM)", "Full Stack Engineer, AI Products",
  "Machine Learning Engineer", "Conversational AI Developer", "AI Platform Engineer", "Agentic Automation Engineer", "Senior Software Engineer, AI Search",
  "LLM Engineer", "AI Developer", "Voice AI Engineer",
];
const SITES: [string, JobRecord["source"]][] = [["SEEK", "browser"], ["LinkedIn", "browser"], ["Greenhouse", "ats"], ["Lever", "ats"], ["Adzuna", "adzuna"], ["Pasted link", "pasted"]];
const SALARIES = ["", "", "", "$140k-$160k + super", "$120,000 - $135,000 base + super", "$150k+", "$110k - $125k", "Up to $175k package", "$95,000 + super", "$160k-$180k", "$85 - $95 per hour", "Competitive"];
const LOCATIONS = ["Sampletown NSW", "Remote Australia", "Brisbane QLD", "Sydney NSW", "Melbourne VIC"];

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const iso = (t: number) => new Date(t).toISOString();
const day = (t: number) => iso(t).slice(0, 10);

function pickLabel(r: number): WorkRightsLabel {
  return r < 0.13 ? "sponsorship_offered" : r < 0.28 ? "visa_ok" : r < 0.86 ? "silent" : r < 0.96 ? "citizen_pr_only" : "clearance";
}
const SPONSOR_BASE: Record<WorkRightsLabel, number> = { sponsorship_offered: 95, visa_ok: 72, silent: 20, citizen_pr_only: 5, clearance: 5 };

/** About 12 weeks of fictional job-hunt history ending at SCENARIO_NOW. */
export function historyJobs(count = 46, seed = 7): { jobs: FixtureJob[]; companies: FixtureCompany[]; searches: Fixture["searches"] } {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const end = SCENARIO_NOW.getTime();
  const jobs: FixtureJob[] = [];
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    const company = pick(EMPLOYERS);
    const slug = slugify(company);
    const title = pick(TITLES);
    // More finds recently, as a search ramps up.
    const foundAt = end - Math.floor(Math.pow(r(), 0.8) * 83 * DAY) - Math.floor(r() * 8) * 3_600_000;
    const id = `${day(foundAt)}-${slugify(title)}`;
    if (used.has(`${slug}/${id}`)) continue;
    used.add(`${slug}/${id}`);
    const label = pickLabel(r());
    const [site, source] = pick(SITES);
    const fit = r() < 0.27 ? null : Math.round(45 + r() * 48);
    const sponsor = r() < 0.08 ? null : Math.max(0, Math.min(100, SPONSOR_BASE[label] + Math.round((r() - 0.5) * 16)));
    const timeline: JobRecord["timeline"] = [{ at: iso(foundAt), event: "Found", note: site }];
    let status: JobStatus = "Found";
    let t = foundAt;
    const step = (to: JobStatus, minDays: number, spread: number): boolean => {
      const next = t + (minDays + r() * spread) * DAY;
      if (next >= end) return false;
      t = next; status = to; timeline.push({ at: iso(t), event: `Status: ${to}`, note: "" });
      return true;
    };
    const blocked = label === "citizen_pr_only" || label === "clearance";
    const keen = (fit ?? 50) / 100 + (label === "sponsorship_offered" ? 0.3 : label === "visa_ok" ? 0.15 : 0);
    if (blocked) { if (r() < 0.6) step("Skipped", 0.2, 2); }
    else if (r() < keen * 0.8 && step("Saved", 0.5, 3)) {
      if (r() < 0.75 && step("Applying", 0.5, 4) && r() < 0.8 && step("Applied", 1, 4)) {
        const reply = r();
        if (reply < 0.3 && step("Interview", 6, 10)) { const o = r(); if (o < 0.2) step("Offer", 10, 8); else if (o < 0.6) step("Rejected", 5, 6); }
        else if (reply < 0.55) step("Rejected", 7, 14);
      }
    } else if (r() < 0.25) step("Skipped", 1, 10);
    const salaryText = pick(SALARIES);
    const job: JobRecord = {
      id, company_slug: slug, client: null, title, source, source_site: site, url: `https://jobs.example.com/${slug}/${i}`, apply_via: "",
      posted: day(foundAt - Math.floor(r() * 9) * DAY), found_at: iso(foundAt), location: pick(LOCATIONS), work_mode: pick(["Hybrid", "Remote", "On-site"]), job_type: "Full time",
      salary: { text: salaryText, min: null, max: null, currency: salaryText ? "AUD" : "", period: "" },
      work_rights: { label, quotes: label === "sponsorship_offered" ? ["Visa sponsorship is available for the right candidate."] : [], decided_by: "scan" },
      scores: {
        fit: { value: fit, must_haves: [], nice_to_haves: [] },
        sponsor: { value: sponsor, tier: sponsor === null ? "" : sponsor >= 70 ? "High" : sponsor >= 40 ? "Medium" : "Low", reasons: [] },
        career: { match: null, odds: null, tier: "", scored_at: "" },
      },
      status, timeline, files: [],
    };
    jobs.push({ job, company: { name: company, slug, website: `https://${slug}.example.com`, sponsor_status: label === "sponsorship_offered" ? "verified" : "unknown" }, description: `# ${title}\n\nA fictional role at ${company}, made up for the preview.\n`, interview: [] });
  }
  const companies: FixtureCompany[] = [...new Map(jobs.map((j) => [j.company.slug, j.company])).values()]
    .map((c) => ({ name: c.name, slug: c.slug, sponsor: { status: c.sponsor_status, evidence: [], last_checked: "" } }));
  const searches: Fixture["searches"] = [];
  for (let w = 0; w < 12; w++) {
    for (const [site] of SITES.slice(0, 4)) {
      if (r() < 0.35) continue;
      const at = end - (w * 7 + Math.floor(r() * 6)) * DAY;
      const results = 10 + Math.floor(r() * 50);
      searches.push({ at: iso(at), site, query: pick(["ai engineer", "llm engineer", "genai software engineer", "applied ai"]), location: pick(LOCATIONS), results: String(results), kept: String(Math.floor(r() * 4)), notes: "" });
    }
  }
  return { jobs, companies, searches };
}

export type Scenario = "full" | "small" | "empty";

export function scenarioFixture(s: Scenario): Fixture {
  const f = loadFixture();
  if (s === "small") return f;
  if (s === "empty") return { ...f, jobs: [], companies: [], searches: [], approvals: [], requests: [] };
  const h = historyJobs();
  return {
    ...f, jobs: [...f.jobs, ...h.jobs], companies: [...f.companies, ...h.companies.filter((c) => !f.companies.some((x) => x.slug === c.slug))],
    searches: [...f.searches, ...h.searches],
    search: { ...f.search, search_deadline: "2026-03-31", weekly_goal: 5 },
  };
}

/**
 * Mock options for the dev preview, from the page URL: `?data=full|small|empty` picks the data, and
 * `?rights=citizen` (any work-rights status) previews another kind of candidate, and `?mail=off`
 * starts with Gmail not connected (the Settings > Email wizard), and `?tools=missing` (with `&brew=off`) previews
 * the tool install rows.
 */
export function scenarioOptions(search: string): MockOptions {
  const params = new URLSearchParams(search);
  const v = params.get("data");
  const s: Scenario = v === "small" || v === "empty" ? v : "full";
  const fixture = scenarioFixture(s);
  const rights = params.get("rights");
  if (rights && (WR_STATUSES as readonly string[]).includes(rights)) {
    fixture.profile = { ...fixture.profile, work_rights: { ...(fixture.profile.work_rights as Record<string, unknown>), status: rights } };
  }
  // `?tools=missing` previews the install rows (Claude Code, Node.js and ffmpeg missing, Python too old);
  // add `&brew=off` for the "install Homebrew yourself" state. Nothing is installed: the mock plays fake progress.
  const tools = params.get("tools") === "missing"
    ? { setup: { missing: ["claude-code", "node", "ffmpeg"] as const, tooOld: ["python"] as const, brew: params.get("brew") !== "off", install: "auto" as const },
      claudeEngine: { cli: "missing" as const }, ttsEngine: "none" as const, videoToolsOk: false }
    : {};
  return {
    fixture, now: SCENARIO_NOW, ...(s === "empty" ? { inbox: [] } : {}), ...(params.get("mail") === "off" ? { mailConnected: false } : {}),
    ...(tools.setup ? { ...tools, setup: { ...tools.setup, missing: [...tools.setup.missing], tooOld: [...tools.setup.tooOld] } } : {}),
  };
}
