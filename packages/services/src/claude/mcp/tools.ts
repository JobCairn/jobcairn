import { addEvent, appendSearch, findDuplicateJob, isWorkspace, mergeAgency, newJob, ranRecently, recordScore, requestAccess, writeFileAtomic } from "@careeros/core";
import fs from "node:fs";
import path from "node:path";
import { ArgError, BROWSABLE_BOARD_IDS, cleanAgencyInput, localDate, checkJobPlace, findBudget, recruiterBudget, jobAdKey, jobBoardBySite, httpsUrl, inboxSuggestArgs, INBOX_SUGGEST_FOLDERS, int, JOB_SOURCES, obj, oneOf, opt, SCORE_ITEM_SCHEMA, SCORE_LIMITS, SCORE_TIERS, scoreRecordArgs, SEARCH_REPORT_MAX_BYTES, searchReportArgs, searchReportRel, slug, str, type ScoreRecordArgs, type V } from "@careeros/contract";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { checkFoundJob, flagFoundJob, readSearchPrefs, scoreSponsorAtImport } from "../../find-jobs.js";
import { captureAdRecruiter, sameAgencyFor } from "../../recruiters-capture.js";

/**
 * The CareerOS operations a Claude Code run may call, as typed MCP tools (spec 2026-10-10, ruling R1). They
 * replace `Bash(careeros:*)`: Claude gets no shell at all. Every argument goes through a contract validator.
 * No tool takes a file path (fix round 2, F1): the job ad comes in as text (`jd_text`), so a tool can never be
 * used to copy one workspace file into another. There is no init, import, migrate, index or workspace-choosing
 * tool: the server is pinned to one workspace, one tool list and (for job_event) one job when it starts, and
 * caps how much one run can add (F10).
 */

/** One server process: the workspace, the allowed tools, the job a job_event may touch, and per-run counts. */
export interface McpSession {
  root: string;
  tools: readonly McpToolName[];
  /** score_job: the only job whose timeline and score may change. Null: job_event and score_record refuse everything. */
  job: { company_slug: string; id: string } | null;
  counts: Partial<Record<McpToolName, number>>;
  /** inbox_suggest: the run's own folder (absolute, .careeros/tmp/ask-<hex>), where its one answer goes. */
  ask?: string | null;
  /** Find jobs: true when the run searches in the person's Chrome (jobcairn-chrome), so its searches log as "chrome". */
  chrome?: boolean;
  /** Find jobs: this run's own search choices (the composer's quick filters), checked when the server starts. */
  search?: import("@careeros/contract").SearchOverride | null;
  /**
   * search_report: the one report file this run writes (workspace-relative, `knowledge/job-searches/<local date>.md`
   * or `knowledge/chrome-checks/<local date>.md`), fixed by main when the run starts. Null: search_report refuses.
   */
  report?: string | null;
  /** Find jobs: how many new jobs the run aims for (filters.max_jobs); job_new and search_add allow more calls for more. */
  jobs?: number | null;
  /** Find recruiters: how many agencies the run aims for (max_agencies); recruiter_add allows more calls for more. */
  agencies?: number | null;
}

/** Per-run caps, so an injected page can't flood the workspace or the person (F10). */
export const MCP_CAPS: Partial<Record<McpToolName, number>> = { job_new: 50, search_add: 100, job_event: 5, request_access: 3, score_record: 2, inbox_suggest: 3, search_report: 3, recruiter_add: 30 };

/**
 * A tool's cap in this session: MCP_CAPS, with job_new and search_add grown for a find-jobs run's jobs (findBudget),
 * and recruiter_add for a find-recruiters run's agencies (recruiterBudget).
 */
export function mcpCap(s: Pick<McpSession, "jobs" | "agencies">, name: McpToolName): number | undefined {
  if (s.agencies && name === "recruiter_add") return Math.max(MCP_CAPS.recruiter_add!, recruiterBudget(s.agencies).recruiterAdd);
  if (s.jobs && name === "job_new") return Math.max(MCP_CAPS.job_new!, findBudget(s.jobs).jobNew);
  if (s.jobs && name === "search_add") return Math.max(MCP_CAPS.search_add!, findBudget(s.jobs).searchAdd);
  return MCP_CAPS[name];
}

export function mcpSession(root: string, tools: readonly McpToolName[], job: McpSession["job"] = null): McpSession {
  return { root, tools: [...tools], job, counts: {} };
}

export interface McpTool {
  name: McpToolName;
  description: string;
  /** JSON Schema shown to Claude. The validator below is what is enforced. */
  inputSchema: Record<string, unknown>;
  validate: V<Record<string, unknown>>;
  run(session: McpSession, args: Record<string, unknown>): unknown;
}

/** The longest job ad accepted, in UTF-8 bytes. */
export const MAX_JD_BYTES = 200 * 1024;

/** Ad text: at most 200 KB, line ends normalised, control characters (other than tab and newline) dropped. */
export const jdText: V<string> = (v, at) => {
  if (typeof v !== "string") throw new ArgError(`${at} must be text`);
  if (Buffer.byteLength(v, "utf8") > MAX_JD_BYTES) throw new ArgError(`${at} must be at most 200 KB`);
  // eslint-disable-next-line no-control-regex
  return v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
};

export const MCP_TOOL_NAMES = ["search_check", "search_add", "job_new", "job_event", "request_access", "score_record", "inbox_suggest", "search_report", "recruiter_add"] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

const line = (max: number) => str({ min: 1, max });
const text = (max: number) => str({ max, multiline: true });
const s = (description: string, maxLength: number) => ({ type: "string", description, maxLength });
const schema = (props: Record<string, unknown>, required: string[]) => ({ type: "object", properties: props, required, additionalProperties: false });

const searchKey = { site: line(80), query: line(200), location: line(120) };
const searchProps = { site: s("Job site, for example Greenhouse or SEEK", 80), query: s("The search words", 200), location: s("Where", 120) };

export const MCP_TOOLS: Record<McpToolName, McpTool> = {
  search_check: {
    name: "search_check",
    description: "Check whether this search already ran in the last 7 days. Run it before every search and skip searches that ran recently.",
    inputSchema: schema(searchProps, ["site", "query", "location"]),
    validate: obj(searchKey),
    run: ({ root }, a) => {
      const hit = ranRecently(root, a.site as string, a.query as string, a.location as string);
      return { ran_recently: !!hit, at: hit?.at ?? null };
    },
  },
  search_add: {
    name: "search_add",
    description: "Log a search you ran, with how many results it had and how many new jobs you added (kept). Jobs job_new said you already had are not kept: put how many in notes.",
    inputSchema: schema({ ...searchProps, results: { type: "integer", minimum: 0 }, kept: { type: "integer", minimum: 0 }, notes: s("Short notes", 500) }, ["site", "query", "location"]),
    validate: obj({ ...searchKey, results: opt(int(0, 100_000)), kept: opt(int(0, 100_000)), notes: opt(text(500)) }),
    run: ({ root, chrome, search }, a) => {
      // A search outside the allowed countries is still logged (so it isn't repeated), with a warning back.
      const place = checkJobPlace(readSearchPrefs(root, search), { location: a.location as string });
      // The mode comes from the run itself (a browser run has its browsing), never from Claude.
      const e = appendSearch(root, { site: a.site as string, query: a.query as string, location: a.location as string, results: a.results as number | undefined, kept: a.kept as number | undefined, notes: a.notes as string | undefined, mode: chrome ? "chrome" : "web" });
      return { logged: true, at: (e as { at?: string }).at ?? null, ...(place.verdict === "refuse" ? { warning: `${place.why.replace(/^This job is/, "This place is")} Jobs found there will be refused.` } : {}) };
    },
  },
  job_new: {
    name: "job_new",
    description: `Add a job you found. Never apply, save, follow or message anyone on a job site. Always pass the ad's own link in url (the address of the ad's page, not the search page; in Chrome, use the "Address of this job ad" line); on a job board in the person's Chrome a job without its link is refused, and if you truly can't get the link, give no_link_reason. Put the whole ad text in jd_text (up to 200 KB); ${identity.name} saves it as the job's ad. Give the location as the ad states it: a job clearly outside the person's allowed countries (and not remote and open to them), or whose stated yearly pay tops out under their minimum, is refused with the reason. A job already in the workspace (same ad, or same company, title and place) comes back with duplicate true and nothing new is added: count it as "already had", not as added.`,
    inputSchema: schema({
      company: s("Company name", 120), title: s("Job title", 200), url: s("https link to the ad", 2000), source: { type: "string", enum: [...JOB_SOURCES] },
      site: s("Job site", 80), location: s("Location", 120), work_mode: s("Remote, hybrid or on-site", 40), job_type: s("Full time, contract…", 40),
      salary: s("Salary as written in the ad", 120), posted: s("When the ad was posted, as the ad shows it: a date (2026-10-12) or the board's words (\"3d ago\", \"30+ days ago\", \"just posted\"). Leave it out when the ad shows none", 40), apply_via: s("How to apply", 300),
      jd_text: { type: "string", description: "The whole job ad as plain text", maxLength: MAX_JD_BYTES },
      no_link_reason: s("Only when you truly can't get the ad's link: why, in one plain sentence", 300),
    }, ["company", "title"]),
    validate: obj({
      company: line(120), title: line(200), url: opt(httpsUrl), source: opt(oneOf(JOB_SOURCES)), site: opt(line(80)), location: opt(line(120)),
      work_mode: opt(line(40)), job_type: opt(line(40)), salary: opt(line(120)), posted: opt(line(40)), apply_via: opt(line(300)), jd_text: opt(jdText),
      no_link_reason: opt(line(300)),
    }),
    run: ({ root, search, chrome }, a) => {
      const jd = typeof a.jd_text === "string" && a.jd_text.trim() ? a.jd_text : undefined;
      // A job already here is "already had" first, whatever today's place and pay rules say about it.
      const input = {
        company: a.company as string, title: a.title as string, url: a.url as string | undefined, source: a.source as (typeof JOB_SOURCES)[number] | undefined,
        source_site: a.site as string | undefined, location: a.location as string | undefined, work_mode: a.work_mode as string | undefined,
        job_type: a.job_type as string | undefined, salary_text: a.salary as string | undefined, posted: a.posted as string | undefined,
        apply_via: a.apply_via as string | undefined, jd_text: jd,
      };
      const known = findDuplicateJob(root, input, { key: jobAdKey }) ? newJob(root, input, undefined, { key: jobAdKey }) : null;
      if (known?.duplicate) return { duplicate: true, company_slug: known.company_slug, id: known.id, filled: known.filled ?? [], note: "Already in the workspace: count it as already had, not added." };
      // A Chrome run reads ads on board pages, so it has each ad's link: without it, the same ad can't be matched later.
      // The run's mode comes from the session (never from Claude); Claude's own source "browser" counts too.
      if (!a.url && !a.no_link_reason && (chrome || a.source === "browser") && boardHasAdPages(a.site as string | undefined)) {
        throw new Error("Not saved: pass the ad's own link in url (the address of the ad's page). If you truly can't get it, give no_link_reason and say so in the report.");
      }
      // Never save a wrong-country (or under-paid) job silently: refuse it with the reason, or save and flag it.
      const check = checkFoundJob(root, { location: a.location as string | undefined, work_mode: a.work_mode as string | undefined, salary: a.salary as string | undefined, jd_text: jd }, search);
      if (check.refuse) throw new Error(check.refuse);
      const made = newJob(root, input, undefined, { key: jobAdKey });
      if (a.no_link_reason) addEvent(root, made.company_slug, made.id, "No link to the ad", a.no_link_reason as string);
      if (made.created) {
        scoreSponsorAtImport(root, made.company_slug, made.id);
        captureAdRecruiter(root, made.company_slug, made.id);
        if (check.flag) flagFoundJob(root, made.company_slug, made.id, check.flag);
      }
      return check.flag ? { ...made, check: check.flag } : made;
    },
  },
  job_event: {
    name: "job_event",
    description: "Add an event to this job's timeline, for example \"Scored\". Only the job this request is about.",
    inputSchema: schema({ company_slug: s("The company's folder name", 120), id: s("The job's folder name", 120), event: s("What happened", 200), note: s("Optional note", 500) }, ["company_slug", "id", "event"]),
    validate: obj({ company_slug: slug, id: slug, event: line(200), note: opt(text(500)) }),
    run: ({ root, job }, a) => {
      if (!job || job.company_slug !== a.company_slug || job.id !== a.id) throw new Error("This request may only add events to the job it is about.");
      return addEvent(root, job.company_slug, job.id, a.event as string, (a.note as string | undefined) ?? "");
    },
  },
  score_record: {
    name: "score_record",
    description: "Save this job's score once, at the end, with the same result as score.md. Write every text in plain words: name evidence as your resume, your profile or the job ad, never a file path or an internal label.",
    inputSchema: schema({
      fit: { type: "integer", minimum: 0, maximum: 100, description: "How well the job fits, 0 to 100" },
      interview_odds: { type: "integer", minimum: 0, maximum: 100, description: "Realistic chance of an interview, 0 to 100" },
      tier: { type: "string", enum: [...SCORE_TIERS] },
      recommendation: s("One or two plain sentences: apply or not, and why", SCORE_LIMITS.recommendation),
      must_haves: { type: "array", items: SCORE_ITEM_SCHEMA, maxItems: SCORE_LIMITS.items },
      nice_to_haves: { type: "array", items: SCORE_ITEM_SCHEMA, maxItems: SCORE_LIMITS.items },
      changes: { type: "array", items: s("One thing that would change this score", SCORE_LIMITS.change), maxItems: SCORE_LIMITS.changes },
      summary: { type: "string", description: "Two to four plain sentences", maxLength: SCORE_LIMITS.summary },
    }, ["fit", "interview_odds", "tier", "recommendation", "must_haves"]),
    validate: (v, at) => scoreRecordArgs(v, at) as unknown as Record<string, unknown>,
    run: ({ root, job }, a) => {
      if (!job) throw new Error("This request may only score the job it is about.");
      const r = recordScore(root, job.company_slug, job.id, a as unknown as ScoreRecordArgs);
      return { saved: true, fit: r.fit, tier: r.tier };
    },
  },
  search_report: {
    name: "search_report",
    description: `Save this run's report, in Markdown. ${identity.name} writes it to today's report file for you; don't write the report file yourself. Call it once at the end (calling again replaces the report).`,
    inputSchema: schema({ markdown: { type: "string", description: "The whole report in Markdown", maxLength: SEARCH_REPORT_MAX_BYTES } }, ["markdown"]),
    validate: searchReportArgs as unknown as V<Record<string, unknown>>,
    run: ({ root, report }, a) => {
      if (!report || !searchReportRel(report)) throw new Error("This request has no report to save.");
      writeReport(root, report, a.markdown as string);
      return { saved: true, file: report };
    },
  },
  inbox_suggest: {
    name: "inbox_suggest",
    description: `Say which folder the one drop box file in this request belongs in. Call it once. ${identity.name} shows it as a suggestion; the person decides.`,
    inputSchema: schema({
      folder: { type: "string", enum: [...INBOX_SUGGEST_FOLDERS], description: "resumes, history, projects, education: the person's own files. job_ad: a job advertisement. job_application, job_emails, job_interview: a file about one job. unsure: none fits." },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reason: s("One plain sentence on why", 300), job_title: s("The job title, if the file is about one job", 200), company: s("The company, if the file is about one job", 120),
    }, ["folder", "confidence", "reason"]),
    validate: inboxSuggestArgs as unknown as V<Record<string, unknown>>,
    run: ({ ask }, a) => {
      if (!ask) throw new Error("This request has no drop box file to sort.");
      const tmp = path.join(ask, `answer.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(a), { mode: 0o600 });
      fs.renameSync(tmp, path.join(ask, "answer.json"));
      return { saved: true };
    },
  },
  recruiter_add: {
    name: "recruiter_add",
    description: "Save one recruitment agency and what it publishes. Only contact details from the agency's own pages, each with the https page it appears on; never a guessed address and nothing from LinkedIn profiles. Saving the same agency again adds to it.",
    inputSchema: schema({
      name: s("The agency's name", 200), website: s("Its own site (https)", 500), since: { type: "integer", minimum: 1800, maximum: 2100, description: "The year it started, if its site says" },
      specialties: { type: "array", items: s("A specialty, like Technology or Government", 60), maxItems: 20 },
      tags: { type: "array", items: s("A short tag, like IT specialist, Contract or Data", 40), maxItems: 20 },
      cities: { type: "array", items: s("A city it recruits in", 80), maxItems: 20 },
      hiring_summary: s("One line: what it is hiring for now, from its live ads", 400),
      about_url: s("Its about or team page (https)", 500),
      city_links: { type: "array", maxItems: 20, items: { type: "object", properties: { city: s("City", 80), url: s("That city's contact page (https)", 500) }, required: ["city", "url"], additionalProperties: false } },
      linkedin_url: s("Its LinkedIn company page (linkedin.com/company/...), only if its own site links to it", 500),
      team_note: { type: "object", properties: { text: s("Who its team page names, in a line", 400), source_url: s("That team page (https)", 500) }, required: ["text", "source_url"], additionalProperties: false },
      best_contact: { type: "object", properties: { name: s("The person the agency itself names as its contact", 120), source_url: s("The page that says so (https)", 500) }, required: ["name", "source_url"], additionalProperties: false },
      contacts: { type: "array", maxItems: 40, items: { type: "object", properties: {
        kind: { type: "string", enum: ["email", "phone"] }, value: s("The address or number as published", 254), label: s("For example Brisbane office", 80),
        source_url: s("The https page it appears on", 500), confirmed: { type: "boolean" },
      }, required: ["kind", "value", "source_url"], additionalProperties: false } },
      people: { type: "array", maxItems: 40, items: { type: "object", properties: {
        name: s("Name as the agency publishes it", 120), title: s("Their title", 120), email: s("Only if published on the source page", 254), phone: s("Only if published on the source page", 40),
        source_url: s("The agency's own page that names them (https)", 500), specialties: { type: "array", items: s("Specialty", 60), maxItems: 20 },
      }, required: ["name", "source_url"], additionalProperties: false } },
      sources: { type: "array", maxItems: 20, description: "Every place you found this agency. Saving it again adds new ones.", items: { type: "object", properties: {
        name: s("Where: SEEK, Indeed or LinkedIn (a job ad), Web search, a directory or panel's name (RCSA directory), Saved job, or Agency website", 60),
        url: s("That page (https): the ad, the search result's page, the directory entry or the agency's own page", 500),
      }, required: ["name", "url"], additionalProperties: false } },
    }, ["name"]),
    // Throws when there is no name; every other field is checked (and dropped when it breaks a rule) in run.
    validate: (v, at) => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new ArgError(`${at} must be an object`); cleanAgencyInput(v); return v as Record<string, unknown>; },
    run: ({ root }, a) => {
      const { agency, dropped } = cleanAgencyInput(a, localDate(new Date()));
      // The same agency already saved (by slug, else by its website's host) gets this save, so an agency the person
      // added isn't saved twice; Claude's save is the check (needs_check cleared, its checked name kept).
      const same = sameAgencyFor(root, agency.slug, agency.website);
      const saved = mergeAgency(root, { ...agency, slug: same.slug, rename: same.rename, needs_check: false }, { event: same.rename ? "Checked by Claude" : "Found by Claude", note: agency.hiring_summary }, undefined);
      return { saved: true, slug: saved.slug, contacts: agency.contacts.length, people: agency.people.length, sources: (saved.sources ?? []).length, left_out: dropped };
    },
  },
  request_access: {
    name: "request_access",
    description: `Ask the person to open a locked folder (identity or employment) for one fact. Give a plain reason with no file paths. They answer in the ${identity.name} app.`,
    inputSchema: schema({ folder: { type: "string", enum: ["identity", "employment"] }, why: s("Plain reason", 300), minutes: { type: "integer", minimum: 1, maximum: 240 } }, ["folder", "why"]),
    validate: obj({ folder: oneOf(["identity", "employment"] as const), why: line(300), minutes: opt(int(1, 240)) }),
    run: ({ root }, a) => {
      const r = requestAccess(root, { folder: `me/${a.folder as string}`, why: a.why as string, minutes: a.minutes as number | undefined });
      return { requested: true, id: r.id, status: r.status };
    },
  },
};

/** Whether the named site is a job board whose ads have their own pages (SEEK, LinkedIn, Indeed…). Unknown: yes. */
function boardHasAdPages(site: string | undefined): boolean {
  const board = site?.trim() ? jobBoardBySite(site) : undefined;
  return !board || (BROWSABLE_BOARD_IDS as readonly string[]).includes(board.id);
}

/**
 * Writes the report file inside the workspace: every folder on the way must be a real folder (never a link), the
 * file itself is never a link, and the write is atomic (a reader never sees half a report).
 */
function writeReport(root: string, rel: string, markdown: string): void {
  const base = path.resolve(root);
  let cur = base;
  for (const part of rel.split("/").slice(0, -1)) {
    cur = path.join(cur, part);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(cur); } catch { st = null; }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error("The report folder isn't a plain folder, so the report wasn't saved.");
    if (!st) fs.mkdirSync(cur);
  }
  const file = path.join(base, rel);
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("The report file is a link, so the report wasn't saved."); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  writeFileAtomic(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`, 0o644);
}

/** The tools each action gets: only what it needs. Every action may ask for access to a locked folder. */
export function mcpToolsFor(action: string): McpToolName[] {
  if (action === "find_jobs") return ["search_check", "search_add", "job_new", "search_report", "request_access"];
  if (action === "chrome_check") return ["search_report", "request_access"];
  if (action === "score_job") return ["job_event", "score_record", "request_access"];
  if (action === "inbox_suggest") return ["inbox_suggest"];
  if (action === "find_recruiters" || action === "check_recruiters") return ["recruiter_add", "request_access"];
  return ["request_access"];
}

/** Claude Code's name for one of our tools. */
export const mcpToolId = (n: McpToolName) => `mcp__careeros__${n}`;

export function assertServable(root: string): void {
  if (!isWorkspace(root)) throw new Error(`not a ${identity.name} workspace`);
}
