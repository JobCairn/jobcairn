// Builds src/mock/alex-fixture.json from the fictional sample workspace.
// The renderer never imports core; only this dev script does.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fieldsFor, layout, listAccessRequests, listAgencies, listApprovals, listJobs, readRecord, readSearches, type Company,
} from "../../core/src/index.js";
import type { AgencyRecordView, LearnItem } from "@careeros/contract";
import type { Fixture, FixtureCompany, FixtureJob } from "../src/mock/fixture-types";

export const SAMPLE = path.resolve(import.meta.dirname, "../../../samples/alex-example");
export const FIXTURE_ROOT = "/fictional/alex-example/CareerOS";
const OUT = path.resolve(import.meta.dirname, "../src/mock/alex-fixture.json");

const titleOf = (text: string, fallback: string) => text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;

export function buildFixture(root = SAMPLE): Fixture {
  const L = layout(root);
  const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");
  const texts: Record<string, string> = {};
  const read = (p: string) => { const t = fs.readFileSync(p, "utf8"); texts[rel(p)] = t; return t; };

  const companies = new Map<string, Company>();
  for (const slug of fs.readdirSync(L.companiesDir).sort()) {
    companies.set(slug, readRecord("company", L.companyFile(slug)));
    // Published contacts from Research company, so the mock's company page has a Contacts tab to show.
    const contacts = path.join(L.companyDir(slug), "contacts.json");
    if (fs.existsSync(contacts)) read(contacts);
  }

  const jobs: FixtureJob[] = listJobs(root).map((ref) => {
    const job = readRecord("job", ref.file);
    const c = companies.get(ref.company_slug)!;
    const dir = L.jobDir(ref.company_slug, ref.id);
    const jd = path.join(dir, "jd.md");
    const idir = path.join(dir, "interview");
    const interview = fs.existsSync(idir)
      ? fs.readdirSync(idir).filter((n) => n.endsWith(".md")).sort().map((n) => {
          const p = path.join(idir, n);
          return { path: rel(p), title: titleOf(read(p), n), kind: "guide" as const };
        })
      : [];
    return { job, company: { name: c.name, slug: c.slug, website: c.website, sponsor_status: c.sponsor.status }, description: fs.existsSync(jd) ? read(jd) : "", interview };
  });

  const topics = fs.readdirSync(L.learning).sort().filter((n) => fs.lstatSync(path.join(L.learning, n)).isDirectory()).map((slug) => {
    const dir = path.join(L.learning, slug);
    const items = fs.readdirSync(dir).sort().flatMap((n): LearnItem[] => {
      const p = path.join(dir, n);
      if (n.endsWith(".md")) return [{ path: rel(p), title: titleOf(read(p), n), kind: "guide" }];
      if (/\.(mp4|webm|m4v)$/i.test(n)) return [{ path: rel(p), title: n, kind: "video" }];
      return [];
    });
    return { slug, title: items.find((i) => i.kind === "guide")?.title ?? slug, items };
  });

  const meta = readRecord("workspace", L.workspaceFile);
  const profile = readRecord("profile", L.profile);
  const fixtureCompanies: FixtureCompany[] = [...companies.values()].map((c) => ({
    name: c.name, slug: c.slug,
    sponsor: { status: c.sponsor.status, evidence: c.sponsor.evidence.map((e) => ({ date: e.date, note: e.note, url: e.url })), last_checked: c.sponsor.last_checked },
  }));
  return {
    workspace: { root: FIXTURE_ROOT, name: profile.contact.name, dataVersion: meta.data_version, locked: meta.privacy.locked },
    profile, search: readRecord("search", L.search), integrations: readRecord("integrations", L.integrations),
    fields: { profile: fieldsFor("profile"), search: fieldsFor("search"), integrations: fieldsFor("integrations") },
    jobs, companies: fixtureCompanies, employers: readRecord("sponsors", L.sponsors).employers,
    searches: readSearches(root).entries,
    learning: { topics },
    texts,
    approvals: listApprovals(root).map(({ schema: _s, custom: _c, ...a }) => a),
    requests: listAccessRequests(root).map(({ schema: _s, custom: _c, ...r }) => r),
    agencies: listAgencies(root).map(({ schema: _s, custom: _c, ...a }) => a as unknown as AgencyRecordView),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(OUT, JSON.stringify(buildFixture(), null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}
