// Extra fictional rows for previewing the table screens (`npm run dev`, then open `/?demo=tables`).
// Shaped like a real workspace: a sponsor cache with hyphen statuses and dated evidence, and a
// migrated search log with date-only entries and free-text result counts. Fictional names only.
import type { Fixture } from "./fixture-types";

const EV = (date: string, note: string, url = "") => ({ date, note, url });
const FOI = "On Home Affairs FOI FA 24/01 list of accredited sponsors (as at Jan 2024). Proves accreditation then, not that a given role is sponsored today.";

export function withTableDemo(f: Fixture): Fixture {
  f.employers = [
    { name: "Acme Analytics", aliases: ["Acme Data"], status: "verified", qld: true, ai_relevance: "High", last_checked: "2026-10-08",
      evidence: [EV("2026-10-01", FOI, "https://example.gov.au/foi.pdf"), EV("2026-10-08", "Job ad for ML Engineer says 482 sponsorship considered for senior roles", "https://jobs.example.com/acme-analytics/12")] },
    { name: "Acme Bank", aliases: [], status: "verified", qld: true, ai_relevance: "Medium", last_checked: "2026-10-08", evidence: [EV("2026-10-08", FOI, "https://example.gov.au/foi.pdf")] },
    { name: "Example Health", aliases: ["ExHealth"], status: "checked-none", qld: false, ai_relevance: "Medium", last_checked: "2026-10-08",
      evidence: [EV("2026-10-08", "Ad 'AI Platform Engineer': only applicants with full, unrestricted working rights. Not offering sponsorship at this time.", "https://jobs.example.com/exhealth/95")] },
    { name: "Example Telco", aliases: ["ExTel", "Example Mobile"], status: "to-verify", ai_relevance: "High", last_checked: "2026-10-07",
      evidence: [EV("2026-10-07", "Large telco with an AI team; past sponsorship mentioned on a forum, not confirmed", "")] },
    { name: "Acme Consulting", aliases: [], status: "verified", qld: true, ai_relevance: "High", last_checked: "2026-09-17",
      evidence: [EV("2026-09-17", "Careers page: 'we sponsor visas for experienced engineers'", "https://acme-consulting.example.com/careers")] },
    { name: "Example Retail", aliases: [], status: "checked-none", ai_relevance: "Low", last_checked: "2026-08-02", evidence: [EV("2026-08-02", "No sponsorship signal on careers page or ads", "")] },
    { name: "Acme Overseas", aliases: [], status: "sanctioned", last_checked: "2026-07-20", evidence: [EV("2026-07-20", "Listed on the sanctioned sponsors register", "https://example.gov.au/sanctioned")] },
  ];
  f.searches = [
    ...f.searches,
    { at: "2026-10-08T00:00:00", site: "SEEK", query: "ai engineer", location: "Brisbane QLD", results: "81 (c. 30 relevant)", kept: "3", notes: "Kept three. Most ads needed full work rights; two said sponsorship considered; one was a repost of an earlier lead." },
    { at: "2026-10-08T00:00:00", site: "LinkedIn", query: "llm engineer", location: "Remote, Australia", results: "2,000+ (too broad)", kept: "0", notes: "Too broad; narrow with 'sponsorship'." },
    { at: "2026-10-07", site: "SEEK", query: "generative ai developer", location: "Sydney NSW", results: "44", kept: "2", notes: "kept Acme Analytics, Example Telco" },
    { at: "2026-10-06", site: "Indeed", query: "conversational ai", location: "Melbourne VIC", results: "17", kept: "1", notes: "" },
    { at: "2026-09-25", site: "SEEK", query: "applied ai engineer", location: "Brisbane QLD", results: "29 (5 new)", kept: "1", notes: "Repeat of last month; mostly the same ads." },
    { at: "2026-09-12T14:30:00.000Z", site: "Greenhouse", query: "machine learning engineer", location: "Remote", results: "9", kept: "0", notes: "None sponsor." },
  ];
  return f;
}
