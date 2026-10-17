import fs from "node:fs";
import path from "node:path";
import { insideRoot, layout, readRecord } from "@careeros/core";
import {
  buildCompanyDetail, buildCompanyRows, COMPANY_SKIP, CONTACTS_FILE, CONTACTS_MAX_BYTES, fileKind, readCompanyContacts, type CompanyContacts, type CompanyDetail, type CompanyFile, type CompanyInput, type CompanyMailStat,
  type CompanyRow, type JobRecord, researchAgeAt,
} from "@careeros/contract";
import { companyResearchAt } from "./research.js";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { jobRows, query, sponsors } from "./read.js";

function companyInputs(root: string): CompanyInput[] {
  const L = layout(root);
  const out: CompanyInput[] = [];
  for (const slug of fs.existsSync(L.companiesDir) ? fs.readdirSync(L.companiesDir).sort() : []) {
    try {
      const c = readRecord("company", L.companyFile(slug));
      out.push({ slug, name: c.name, website: c.website });
    } catch { /* an unreadable company is reported by validate */ }
  }
  return out;
}

function mailStats(root: string): CompanyMailStat[] {
  try {
    return query<CompanyMailStat>(root, "SELECT company_slug, COUNT(*) AS count, MAX(date) AS last FROM emails GROUP BY company_slug")
      .map((r) => ({ company_slug: r.company_slug, count: Number(r.count) || 0, last: r.last ?? "" }));
  } catch { return []; }
}

function rows(ctx: ServiceContext): CompanyRow[] {
  const root = ctx.requireRoot();
  return buildCompanyRows(sponsors(ctx), companyInputs(root), jobRows(root), mailStats(root));
}

const LABELS: Record<string, string> = { "research.md": "Company research", "notes.md": "Notes" };
const MAX_FILES = 100;

/**
 * Research and notes in the company folder: regular files at the top level and one folder down, skipping jobs,
 * emails, videos, the record itself, dot files and anything that isn't really inside the workspace (symlinks).
 */
export function companyFiles(root: string, slug: string): CompanyFile[] {
  const dir = layout(root).companyDir(slug);
  const out: CompanyFile[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    let names: string[];
    try { names = fs.readdirSync(abs).sort(); } catch { return; }
    for (const name of names) {
      if (out.length >= MAX_FILES) return;
      if (name.startsWith(".") || (depth === 0 && COMPANY_SKIP.has(name))) continue;
      const p = path.join(abs, name);
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink() || !insideRoot(root, p)) continue;
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) { if (depth < 1) walk(p, r, depth + 1); continue; }
      if (!st.isFile()) continue;
      out.push({ path: r, rel: `companies/${slug}/${r}`, label: LABELS[r] ?? "", at: st.mtime.toISOString(), size: st.size, kind: fileKind(name) });
    }
  };
  walk(dir, "", 0);
  return out;
}

/**
 * The company's contacts.json (written by Research company), read leniently: missing, too big, a symlink, not JSON
 * or not an object all mean "no contacts yet"; bad entries inside are dropped by readCompanyContacts.
 */
export function companyContacts(root: string, slug: string): CompanyContacts | null {
  const p = path.join(layout(root).companyDir(slug), CONTACTS_FILE);
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > CONTACTS_MAX_BYTES || !insideRoot(root, p)) return null;
    return readCompanyContacts(fs.readFileSync(p, "utf8"));
  } catch { return null; }
}

function detail(ctx: ServiceContext, key: string): CompanyDetail {
  const root = ctx.requireRoot();
  const all = rows(ctx);
  const row = all.find((r) => r.slug === key) ?? all.find((r) => r.key === key);
  if (!row) throw new Error("That company isn't in this workspace.");
  const jobs = row.slug ? jobRows(root).filter((j) => j.company_slug === row.slug) : [];
  const records = row.slug
    ? query<{ json: string }>(root, "SELECT json FROM jobs").map((r) => JSON.parse(r.json) as JobRecord).filter((j) => j.company_slug === row.slug)
    : [];
  const d = buildCompanyDetail(row, jobs, records, row.slug ? companyFiles(root, row.slug) : [], row.slug ? companyContacts(root, row.slug) : null);
  const at = row.slug ? companyResearchAt(root, row.slug) : "";
  return { ...d, research: at ? researchAgeAt(at, ctx.now()) : null };
}

export const companyHandlers = {
  "companies.list": rows,
  "companies.get": detail,
} satisfies Partial<HandlerTable>;
