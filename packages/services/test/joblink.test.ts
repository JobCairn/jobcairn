import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JobAdded, JobDraft, JobPreviewResult } from "@careeros/contract";
import { layout, readRecord, updateRecord } from "@careeros/core";
import { dispatch } from "../src/dispatch.js";
import { atsRequest, parseAts } from "../src/joblink/ats.js";
import { htmlToText } from "../src/joblink/html.js";
import { openSample, tmpDir } from "./helpers.js";

/**
 * "Add a job". Every answer here is a fictional fixture: nothing reaches a real job site, applicant system or Chrome.
 * The fixtures follow the shapes in each system's public docs; the live answers haven't been checked against them.
 */
const FIX = path.join(import.meta.dirname, "fixtures", "ats");
const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.json`), "utf8")) as unknown;

const LINKS = {
  greenhouse: "https://boards.greenhouse.io/examplelabs/jobs/4012345?gh_src=x",
  lever: "https://jobs.lever.co/acme/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
  ashby: "https://jobs.ashbyhq.com/example-labs/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
  workable: "https://apply.workable.com/acme/j/AB12CD34EF/",
  smartrecruiters: "https://jobs.smartrecruiters.com/AcmeCorp/744000012345678-conversational-ai-developer",
  workday: "https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/Sampletown/GenAI-Engineer_R-1234",
} as const;
const APIS: Record<string, keyof typeof LINKS> = {
  "https://boards-api.greenhouse.io/v1/boards/examplelabs/jobs/4012345?pay_transparency=true": "greenhouse",
  "https://api.lever.co/v0/postings/acme/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b": "lever",
  "https://api.ashbyhq.com/posting-api/job-board/example-labs?includeCompensation=true": "ashby",
  "https://apply.workable.com/api/v2/accounts/acme/jobs/AB12CD34EF": "workable",
  "https://api.smartrecruiters.com/v1/companies/AcmeCorp/postings/744000012345678": "smartrecruiters",
  "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/Careers/job/Sampletown/GenAI-Engineer_R-1234": "workday",
};

function setup(o: { fetch?: false; answer?: (url: string) => Response } = {}) {
  const s = openSample();
  const fetched: { url: string; init: Record<string, unknown> }[] = [];
  if (o.fetch !== false) {
    s.host.jobFetch = async (url, init) => {
      fetched.push({ url, init: init as unknown as Record<string, unknown> });
      if (o.answer) return o.answer(url);
      const name = APIS[url];
      if (!name) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
      return new Response(JSON.stringify(fixture(name)), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    };
  }
  const call = <T>(m: string, ...args: unknown[]) => dispatch(s.ctx, m, args) as Promise<T>;
  return { ...s, fetched, call };
}

const ok = (r: JobPreviewResult) => { if (!r.ok) throw new Error(`not ok: ${r.need} ${r.text}`); return r.preview; };

describe("applicant systems: the API address comes from the link's ids, on a fixed host", () => {
  it("builds each system's public address and never the pasted one", () => {
    for (const [ats, link] of Object.entries(LINKS)) {
      const req = atsRequest(ats as keyof typeof LINKS, link)!;
      expect(APIS[req.api]).toBe(ats);
    }
    expect(atsRequest("greenhouse", "https://boards.greenhouse.io/examplelabs")).toBeNull();
    expect(atsRequest("lever", "https://jobs.lever.co/acme/not-a-uuid")).toBeNull();
    expect(atsRequest("workable", "https://apply.workable.com/acme/")).toBeNull();
    expect(atsRequest("workday", "https://evil.example/wday/job/x")).toBeNull();
    expect(atsRequest("workday", "https://acme.wd3.myworkdayjobs.com/Careers/job/%2e%2e/x_R-1")).toBeNull();
    expect(atsRequest("greenhouse", "https://boards.greenhouse.io/embed/job_app?for=examplelabs&token=4012345")!.api)
      .toBe("https://boards-api.greenhouse.io/v1/boards/examplelabs/jobs/4012345?pay_transparency=true");
  });

  it("parses each fixture into the preview's fields", () => {
    const p = (ats: keyof typeof LINKS) => parseAts(atsRequest(ats, LINKS[ats])!, fixture(ats))!;
    expect(p("greenhouse")).toMatchObject({ company: "Example Labs", title: "Applied AI Engineer", location: "Sampletown, NSW", salary: "$150k–$170k per year", posted: "2026-01-10" });
    expect(p("greenhouse").jd_text).toBe("About us\n\nExample Labs builds writing tools.\n\n- Ship LLM features\n- Own evaluation\n\nVisa sponsorship is available for the right candidate.");
    expect(p("lever")).toMatchObject({ company: "Acme", title: "Senior AI Engineer", location: "Sampletown", work_mode: "Hybrid", job_type: "Full-time", salary: "$160k–$180k per year" });
    expect(p("lever").jd_text).toContain("What you'll do\n\n- Build agents\n- Write evals");
    expect(p("ashby")).toMatchObject({ company: "Example Labs", title: "AI Platform Engineer", work_mode: "Remote", job_type: "Full time", salary: "$140K – $165K • Offers Equity" });
    expect(p("workable")).toMatchObject({ title: "Machine Learning Engineer", location: "Sampletown, New South Wales, Australia", work_mode: "On-site" });
    expect(p("workable").jd_text).toContain("Requirements\n\n- Python\n- PyTorch");
    expect(p("smartrecruiters")).toMatchObject({ company: "Acme Corp", title: "Conversational AI Developer", location: "Sampletown, NSW, AU", work_mode: "Remote", job_type: "Full-time" });
    expect(p("workday")).toMatchObject({ company: "Acme Corp", title: "GenAI Engineer", work_mode: "Hybrid", job_type: "Full time" });
  });

  it("refuses an answer for another job (Ashby lists the whole board)", () => {
    const req = atsRequest("ashby", "https://jobs.ashbyhq.com/example-labs/99999999-2222-3333-4444-555555555555")!;
    expect(parseAts(req, fixture("ashby"))).toBeNull();
    expect(parseAts(atsRequest("greenhouse", LINKS.greenhouse)!, { id: 1, title: "x" })).toBeNull();
  });

  it("turns ad HTML into plain text without scripts or styles", () => {
    expect(htmlToText("<p>Hi&nbsp;there</p><script>alert(1)</script><style>p{}</style><ul><li>One</li><li>Two &amp; three</li></ul>")).toBe("Hi there\n\n- One\n- Two & three");
  });
});

describe("jobs.preview and jobs.add", () => {
  it("reads an applicant-system link: no cookies, no redirects, the work-rights sentence found", async () => {
    const x = setup();
    const p = ok(await x.call<JobPreviewResult>("jobs.preview", { url: LINKS.greenhouse }));
    expect(p.via).toBe("ats");
    expect(p.draft).toMatchObject({ company: "Example Labs", title: "Applied AI Engineer", source_site: "Greenhouse", rights: "sponsorship_offered", rights_quotes: ["Visa sponsorship is available for the right candidate."] });
    expect(p.duplicate).toBeNull();
    expect(x.fetched).toHaveLength(1);
    expect(x.fetched[0]!.init).toMatchObject({ redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("each system's link previews from its fixture", async () => {
    const x = setup();
    for (const link of Object.values(LINKS)) expect(ok(await x.call<JobPreviewResult>("jobs.preview", { url: link })).draft.title).not.toBe("");
    expect(x.fetched.map((f) => APIS[f.url])).toEqual(Object.keys(LINKS));
  });

  it("says plainly when the job is gone, the answer is odd, a redirect comes back, or reading links isn't available", async () => {
    const gone = setup({ answer: () => new Response("", { status: 404 }) });
    expect(await gone.call("jobs.preview", { url: LINKS.lever })).toMatchObject({ ok: false, need: "not_found" });
    const html = setup({ answer: () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }) });
    expect(await html.call("jobs.preview", { url: LINKS.lever })).toMatchObject({ ok: false, need: "failed" });
    const moved = setup({ answer: () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) });
    expect(await moved.call("jobs.preview", { url: LINKS.lever })).toMatchObject({ ok: false, need: "failed" });
    expect(moved.fetched).toHaveLength(1);
    const big = setup({ answer: () => new Response("x".repeat(10), { status: 200, headers: { "content-type": "application/json", "content-length": String(50 * 1024 * 1024) } }) });
    expect(await big.call("jobs.preview", { url: LINKS.lever })).toMatchObject({ ok: false, need: "failed" });
    const none = setup({ fetch: false });
    expect(await none.call("jobs.preview", { url: LINKS.lever })).toMatchObject({ ok: false, need: "paste" });
  });

  it("asks for the ad's text for sites it doesn't read, and never fetches them", async () => {
    const x = setup();
    expect(await x.call("jobs.preview", { url: "https://careers.example.com/jobs/42" })).toMatchObject({ ok: false, need: "paste" });
    expect(await x.call("jobs.preview", { url: "https://www.adzuna.com.au/details/123" })).toMatchObject({ ok: false, need: "paste", site: "Adzuna" });
    // A board without Search in my Chrome: never fetched from here.
    expect(await x.call("jobs.preview", { url: "https://www.seek.com.au/job/81234567" })).toMatchObject({ ok: false, need: "set_up_chrome", site: "SEEK" });
    expect(x.fetched).toEqual([]);
  });

  it("previews pasted text with the link it came from, and keeps the board's key", async () => {
    const x = setup();
    const p = ok(await x.call<JobPreviewResult>("jobs.preview", { url: "https://www.linkedin.com/jobs/search/?currentJobId=4012345678", text: "Senior AI Engineer\nAcme Corp\nHybrid\n\nYou must have full working rights in Australia." }));
    expect(p.via).toBe("text");
    expect(p.draft).toMatchObject({ url: "https://www.linkedin.com/jobs/view/4012345678/", title: "Senior AI Engineer", company: "Acme Corp", work_mode: "Hybrid", source_site: "LinkedIn", rights: "citizen_pr_only" });
  });

  it("warns, without refusing, about a link from a look-alike or unknown host, and not about the company's own site", async () => {
    const x = setup();
    const text = "Senior AI Engineer\nAcme Corp\nHybrid\n\nBuild agents.";
    const fake = ok(await x.call<JobPreviewResult>("jobs.preview", { url: "https://seek-jobs.com.au/job/81234567", text }));
    expect(fake.warnings[0]).toMatch(/^This link is on seek-jobs\.com\.au, which looks like SEEK but isn't SEEK's own address \(seek\.com\.au\)\./);
    const unknown = ok(await x.call<JobPreviewResult>("jobs.preview", { url: "https://jobs.example.net/role/9", text }));
    expect(unknown.warnings[0]).toBe("This link is on jobs.example.net, which isn't a job board we know or Acme Corp's own site. Check the ad is real before you apply or share any details.");
    const own = ok(await x.call<JobPreviewResult>("jobs.preview", { url: "https://careers.acme.com.au/role/9", text }));
    expect(own.warnings.join(" ")).not.toMatch(/This link is on/);
    const board = ok(await x.call<JobPreviewResult>("jobs.preview", { url: "https://www.linkedin.com/jobs/view/4012345678/", text }));
    expect(board.warnings.join(" ")).not.toMatch(/This link is on/);
  });

  it("reads a LinkedIn ad's layout: company first, then title, then 'Place · posted · applicants'", async () => {
    const x = setup();
    x.host.now = () => new Date(2026, 9, 11, 10, 0);
    const text = "Acme Corp\n\nAI Engineer\n\nSampletown NSW · 1 week ago · 44 people clicked apply\n\nTry Premium for A$0\nAbout the job\nBuild agents.";
    const p = ok(await x.call<JobPreviewResult>("jobs.preview", { url: "https://www.linkedin.com/jobs/view/4012345678/", text }));
    expect(p.draft).toMatchObject({ title: "AI Engineer", company: "Acme Corp", location: "Sampletown NSW", salary: "", work_mode: "", posted: "2026-10-04", source_site: "LinkedIn" });
  });

  it("previews a dropped file from its text", async () => {
    const x = setup();
    const dir = tmpDir();
    const f = path.join(dir, "ad.txt");
    fs.writeFileSync(f, "Data Engineer at Example Labs\n\nWorking holiday visa holders welcome.");
    const p = ok(await x.call<JobPreviewResult>("jobs.previewFile", f));
    expect(p).toMatchObject({ via: "file", draft: { title: "Data Engineer", company: "Example Labs", rights: "visa_ok" } });
  });

  it("finds a duplicate by the ad's key and by company and title, and never saves it twice", async () => {
    const x = setup();
    // The sample's Acme Corp "AI Engineer".
    const dup = ok(await x.call<JobPreviewResult>("jobs.preview", { text: "AI Engineer\nAcme Corp\n\nBuild things." })).duplicate;
    expect(dup).toMatchObject({ company_slug: "acme-corp", id: "2026-01-12-ai-engineer", company_name: "Acme Corp", by: "title" });
    const first = await x.call<JobAdded>("jobs.add", draftOf({ url: "https://www.seek.com.au/job/81234567?ref=a", title: "Prompt Engineer" }), "Found");
    expect(first.created).toBe(true);
    const again = ok(await x.call<JobPreviewResult>("jobs.preview", { url: "https://au.seek.com/job/81234567#x", text: "Something else entirely\nOther Co" }));
    expect(again.duplicate).toMatchObject({ company_slug: first.company_slug, id: first.id, by: "link" });
    const second = await x.call<JobAdded>("jobs.add", draftOf({ url: "https://au.seek.com/job/81234567" }), "Found");
    expect(second).toEqual({ ...first, created: false });
  });

  it("a preview never changes the job it duplicates; saving it again fills in only what the job lacked", async () => {
    const x = setup();
    const file = layout(x.root).jobFile("acme-corp", "2026-01-12-ai-engineer");
    const before = fs.readFileSync(file, "utf8");
    const p = ok(await x.call<JobPreviewResult>("jobs.preview", { text: "AI Engineer\nAcme Corp\n\nBuild things." }));
    expect(p.duplicate).toMatchObject({ id: "2026-01-12-ai-engineer", by: "title" });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    const old = readRecord("job", file);
    const r = await x.call<JobAdded>("jobs.add", draftOf({ company: "Acme Corp", title: "AI Engineer", location: old.location, url: "https://www.seek.com.au/job/81234599", salary: "$1", source_site: "SEEK" }), "Found");
    expect(r).toMatchObject({ company_slug: "acme-corp", id: "2026-01-12-ai-engineer", created: false });
    const job = readRecord("job", file);
    expect(job.url).toBe(old.url || "https://www.seek.com.au/job/81234599");
    expect(job.salary.text).toBe(old.salary.text || "$1");
    expect(job.timeline.at(-1)?.event).toBe("Seen again");
  });

  it("saves the checked preview: Saved status, the person's work-rights wording, the ad, a sponsor score, and a flag for the place", async () => {
    const x = setup();
    updateRecord("search", layout(x.root).search, (s) => { s.filters = { ...(s.filters ?? {}), countries: ["Australia"] }; });
    const r = await x.call<JobAdded>("jobs.add", draftOf({ location: "Toronto, Canada", work_mode: "On-site", rights: "sponsorship_offered", rights_quotes: ["We sponsor visas."] }), "Saved");
    expect(r).toMatchObject({ created: true, title: "Prompt Engineer", company_name: "Example Studio" });
    const job = readRecord("job", layout(x.root).jobFile(r.company_slug, r.id));
    expect(job).toMatchObject({ status: "Saved", source: "pasted", location: "Toronto, Canada", work_rights: { label: "sponsorship_offered", quotes: ["We sponsor visas."], decided_by: "user" } });
    expect(job.scores.sponsor.value).toBe(20);
    expect(job.timeline.map((e) => e.event)).toEqual(expect.arrayContaining(["Found", "Check the location"]));
    expect(fs.readFileSync(path.join(layout(x.root).jobDir(r.company_slug, r.id), "jd.md"), "utf8")).toBe("Ad text here.\n");
  });

  it("refuses a draft with no title, and a link that isn't https", async () => {
    const x = setup();
    await expect(x.call("jobs.add", draftOf({ title: "" }), "Found")).rejects.toThrow(/required/);
    await expect(x.call("jobs.add", draftOf({ url: "http://example.com/job" }), "Found")).rejects.toThrow(/https/);
  });
});

function draftOf(o: Partial<JobDraft> = {}): JobDraft {
  return {
    url: "", company: "Example Studio", title: "Prompt Engineer", location: "", work_mode: "", job_type: "", salary: "", posted: "", apply_via: "",
    source_site: "", jd_text: "Ad text here.", rights: "silent", rights_quotes: [], ...o,
  };
}
