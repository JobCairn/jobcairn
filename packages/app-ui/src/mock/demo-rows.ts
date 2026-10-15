// Preview and test data for long lists: `?rows=N` (dev preview) adds N fictional companies, each with one job,
// and N logged searches, so the tables can be checked with 0, 1, 50, 127 or 1000 rows. Fictional names only.
import type { Fixture, FixtureJob } from "./fixture-types";

const SITES = ["SEEK", "LinkedIn", "Indeed", "Greenhouse"] as const;
const PLACES = ["Sampletown NSW", "Brisbane QLD", "Remote, Australia", "Melbourne VIC"] as const;
const ROLES = ["AI Engineer", "Applied AI Engineer", "Software Engineer, GenAI", "Backend Engineer, LLM"] as const;
const STATUSES = ["Found", "Saved", "Applied", "Found"] as const;
const pad = (n: number) => String(n).padStart(4, "0");
/** A day `i` days before 2026-10-10, as an ISO date. */
const day = (i: number) => new Date(Date.UTC(2026, 9, 10) - (i % 300) * 86_400_000).toISOString();

/** Adds `n` companies (one job each) and `n` searches to a fixture, cloned from its first job's shape. */
export function withManyRows(f: Fixture, n: number): Fixture {
  const count = Math.max(0, Math.min(5000, Math.floor(n)));
  const base = f.jobs[0];
  if (!base) return f;
  const jobs: FixtureJob[] = [];
  for (let i = 1; i <= count; i++) {
    const name = `Example Company ${pad(i)}`;
    const slug = `example-company-${pad(i)}`;
    const at = day(i);
    const id = `${at.slice(0, 10)}-${ROLES[i % ROLES.length]!.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`;
    const status = STATUSES[i % STATUSES.length]!;
    jobs.push({
      ...base,
      job: {
        ...base.job, id, company_slug: slug, title: ROLES[i % ROLES.length]!, found_at: at, location: PLACES[i % PLACES.length]!,
        url: `https://jobs.example.com/example-${i}`, status,
        timeline: [{ at, event: "Found", note: SITES[i % SITES.length]! }],
        scores: { ...base.job.scores, fit: { ...base.job.scores.fit, value: (i * 37) % 101 } },
        files: [],
      },
      company: { name, slug, website: "", sponsor_status: "unknown" },
      description: `# ${ROLES[i % ROLES.length]} at ${name}\n\nFictional job for previewing long lists.\n`,
      interview: [],
    });
    f.companies.push({ name, slug, sponsor: { status: "unknown", evidence: [], last_checked: "" } });
    f.searches.push({
      at: at.slice(0, 10), site: SITES[i % SITES.length]!, query: `${ROLES[i % ROLES.length]!.toLowerCase()} ${i}`, location: PLACES[i % PLACES.length]!,
      results: String((i * 7) % 90), kept: String(i % 4), notes: i % 5 ? "" : "Fictional search for previewing long lists.",
    });
  }
  f.jobs.push(...jobs);
  return f;
}
