import fs from "node:fs";
import path from "node:path";
import { appendSearch, fileInboxItem, initWorkspace, layout, newJob, proposeApproval, requestAccess, samplePdf, setStatus, updateRecord } from "../src/index.js";

const ROOT = path.resolve(import.meta.dirname, "../../../samples/alex-example");
const at = (d: string) => ({ now: new Date(`${d}T09:00:00.000Z`) });

// The example's seed texts (.example-seed, read by services/src/sample.ts) are kept; everything else is rebuilt.
const SEED = path.join(ROOT, ".example-seed");
for (const e of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) if (e !== ".example-seed") fs.rmSync(path.join(ROOT, e), { recursive: true, force: true });
/** The full ad for a bundled job, shared with the example so both show the same text. */
const ad = (seed: string) => fs.readFileSync(path.join(SEED, "jobs", seed, "jd.md"), "utf8");
initWorkspace(ROOT, { name: "Alex Example", now: new Date("2026-01-10T09:00:00.000Z") });
const L = layout(ROOT);

updateRecord("profile", L.profile, (p) => {
  p.contact = { ...p.contact, email: "alex" + "@" + "example.com", phone: "0491 570 006", city: "Sampletown NSW", links: ["https://example.com/alex"] };
  p.work_rights = { ...p.work_rights, status: "needs_sponsorship", visa_subclass: "485", visa_expiry: "2028-06-30" };
  p.targets = { ...p.targets, roles: ["AI Engineer", "Software Engineer (LLM)"], keywords: ["agents", "RAG", "TypeScript"], seniority: "Senior", job_types: ["full_time", "contract"] };
  p.locations = [{ place: "Sampletown NSW", modes: ["onsite", "hybrid", "remote"], will_relocate: false }, { place: "Remote Australia", modes: ["remote"], will_relocate: false }];
  p.salary = { ...p.salary, min: 100000 };
  p.skip_big_tech = true;
});

const a = newJob(ROOT, { company: "Acme Corp", title: "AI Engineer", url: "https://jobs.example.com/acme/1", source: "ats", source_site: "Greenhouse", location: "Sampletown NSW", work_mode: "Hybrid", salary_text: "$140k-$160k + super", jd_text: ad("acme-corp") }, at("2026-01-12"));
updateRecord("job", L.jobFile(a.company_slug, a.id), (j) => {
  j.work_rights = { label: "sponsorship_offered", quotes: ["Visa sponsorship available for the right candidate."], decided_by: "scan" };
  j.scores.sponsor = { value: 95, tier: "Very high", reasons: ["ad says sponsorship is available"] };
});
setStatus(ROOT, a.company_slug, a.id, "Applied", "Applied on the careers page", at("2026-01-13"));

const b = newJob(ROOT, { company: "Example Labs", title: "Backend Engineer (LLM)", url: "https://jobs.example.com/labs/2", source: "adzuna", source_site: "Adzuna", location: "Remote Australia", work_mode: "Remote", jd_text: ad("example-labs") }, at("2026-01-12"));
updateRecord("job", L.jobFile(b.company_slug, b.id), (j) => { j.scores.sponsor = { value: 20, tier: "Low", reasons: ["no sponsorship signal; ad is silent"] }; });

const c = newJob(ROOT, { company: "Acme Recruiting (client Example University)", title: "AI Developer", url: "https://jobs.example.com/rec/3", source: "pasted", source_site: "Pasted link", location: "Sampletown NSW", jd_text: ad("acme-recruiting") }, at("2026-01-12"));
updateRecord("job", L.jobFile(c.company_slug, c.id), (j) => {
  j.work_rights = { label: "citizen_pr_only", quotes: ["Must be an Australian citizen or permanent resident."], decided_by: "scan" };
});

fs.writeFileSync(path.join(L.inbox, "alex-example-resume.pdf"), samplePdf(["Alex Example", "AI Engineer", "1 Example Street, Sampletown NSW 2000"]));
fileInboxItem(ROOT, "alex-example-resume.pdf", { kind: "me", dir: "resumes" }, "Sample resume", at("2026-01-11"));
fs.writeFileSync(path.join(L.me("history"), "roles.md"), "# Roles\n\n- AI Engineer, Example Labs, 2024 to now (fictional)\n");
appendSearch(ROOT, { site: "Greenhouse", query: "ai engineer", location: "Sampletown NSW", results: 12, kept: 1, notes: "kept Acme Corp" }, at("2026-01-12"));

fs.mkdirSync(path.join(L.learning, "rag-pipelines"), { recursive: true });
fs.writeFileSync(path.join(L.learning, "rag-pipelines", "guide.md"), "# RAG pipelines\n\nA short study guide for Alex Example.\n\n- Chunk the documents\n- Embed and retrieve\n- Cite every source\n");
fs.mkdirSync(path.join(L.jobDir(a.company_slug, a.id), "interview"), { recursive: true });
fs.writeFileSync(path.join(L.jobDir(a.company_slug, a.id), "interview", "questions.md"), "# Interview prep: Acme Corp\n\n1. Tell us about an agent you built.\n2. How do you evaluate retrieval quality?\n");
proposeApproval(ROOT, {
  action: "status_change", title: "Move Example Labs to Interview", summary: "Claude found an interview invite in your notes.",
  steps: ["Set the job status to Interview", "Add a timeline event \"Status: Interview\""],
  payload: { company_slug: b.company_slug, id: b.id, status: "Interview", note: "Invite for Thursday" }, created_by: "claude",
}, at("2026-01-14"));
requestAccess(ROOT, { folder: "me/identity", why: "Need your visa expiry date for the Acme Corp cover letter", field: "visa_expiry" }, at("2026-01-14"));
console.log(`samples written to ${ROOT}`);
