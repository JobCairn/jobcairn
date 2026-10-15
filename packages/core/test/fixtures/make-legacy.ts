import fs from "node:fs";
import path from "node:path";

const w = (root: string, rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

export function makeLegacy(dir: string): void {
  w(dir, "Company/Acme Corp/application.json", JSON.stringify({
    company: "Acme Corp", role: "AI Engineer", source: "SEEK", source_url: "https://jobs.example.com/77?utm_source=x",
    location: "Sampletown NSW", work_mode: "Hybrid", salary: "$150k", posted: "2026-01-10", apply_via: "careers page",
    status: "Applied", sponsorship: "Explicit", sponsor_score: 95, sponsor_tier: "Very high", sponsor_reasons: ["ad says sponsorship"],
    score: { match: 80, odds: 60, tier: "Good Fit" }, fit: "High", must_haves: ["Python"],
    rights_scan: { positive: ["Visa sponsorship available"], hard: [] },
    date_found: "2026-01-12", timeline: [{ date: "2026-01-12", event: "Found", note: "SEEK" }, { date: "2026-01-14", event: "Applied", note: "" }],
    files: [{ label: "Job description", path: "JD-ai-engineer.md", date: "2026-01-12" }],
  }));
  w(dir, "Company/Acme Corp/JD-ai-engineer.md", "# AI Engineer\n");
  w(dir, "Company/Acme Corp/score-2026-01-12.md", "Match 80\n");
  w(dir, "Company/Acme Corp/resume-2026-01-13-ai-engineer.md", "# Alex Example\n");
  w(dir, "Company/Acme Corp/Recruiter-email/thread.md", "Hi Alex\n");
  w(dir, "Company/Acme Recruiting (client Example University)/application.json", JSON.stringify({
    company: "Acme Recruiting (client Example University)", role: "AI Developer", source: "LinkedIn", sponsorship: "No", status: "Found", date_found: "2026-01-13",
  }));
  w(dir, "Company/_TEMPLATE/application.json", "{}");
  w(dir, "Company/README.md", "how to\n");
  w(dir, "Company/No Record Co/notes.md", "orphan\n");
  w(dir, "Job-Hunt-Sponsorship/sponsors.json", JSON.stringify({ employers: [{ name: "Acme Corp", status: "verified" }] }));
  w(dir, "Job-Hunt-Sponsorship/SEARCH-LOG.md", [
    "| Date | Site | Query / filters | Location | Results | Kept | Notes |",
    "|------|------|-----------------|----------|--------:|-----:|-------|",
    "| 2026-01-12 14:05 | SEEK | ai engineer | Sampletown | 31 | 2 | kept Acme |",
    "| 2026-01-11 | LinkedIn | llm engineer | Remote | 10 | 0 | none |",
  ].join("\n"));
  w(dir, "resume-docs/profile.md", "# Profile\nAlex Example\n");
  w(dir, "Resume/Alex_Example_Resume.pdf", "%PDF-1.4 SAMPLE\n");
  w(dir, "Visa/26-27/grant.pdf", "%PDF-1.4 SAMPLE\n");
  w(dir, "Current-company/contract.pdf", "%PDF-1.4 SAMPLE\n");
  w(dir, "Current Address/lease.pdf", "%PDF-1.4 SAMPLE\n");
  w(dir, "Personal Projects/side-app/README.md", "# Side app\n");
  w(dir, "Personal Projects/side-app/node_modules/pkg/index.js", "x\n");
  w(dir, "scripts/tool.py", "print(1)\n");
  w(dir, ".env", "SECRET=1\n");
}
