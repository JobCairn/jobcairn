import fs from "node:fs";
import path from "node:path";
import { listJobs, type ListJobsSkip } from "./jobs.js";
import { readSearches } from "./knowledge.js";
import { insideRoot, layout } from "./paths.js";
import { listAccessRequests, listApprovals, type QueueSkip } from "./queue.js";
import { readRecord, RecordError } from "./store.js";
import type { Kind, KindMap } from "./types.js";

export interface Issue { file: string; problems: string[] }

export function validateWorkspace(root: string): Issue[] {
  const L = layout(root);
  const issues: Issue[] = [];
  const rel = (f: string) => path.relative(root, f);
  const add = (file: string, problem: string) => issues.push({ file: rel(file), problems: [problem] });
  function tryRead<K extends Kind>(kind: K, file: string): KindMap[K] | null {
    try { return readRecord(kind, file); }
    catch (e) {
      if (e instanceof RecordError) { issues.push({ file: rel(e.file), problems: e.problems }); return null; }
      throw e;
    }
  }

  tryRead("workspace", L.workspaceFile);
  tryRead("profile", L.profile);
  tryRead("search", L.search);
  tryRead("integrations", L.integrations);
  tryRead("sponsors", L.sponsors);

  if (fs.existsSync(L.companiesDir)) {
    for (const slug of fs.readdirSync(L.companiesDir).sort()) {
      const companyDir = L.companyDir(slug);
      // lstat (not stat): a dangling symlink must be reported, never thrown.
      let lst: fs.Stats;
      try { lst = fs.lstatSync(companyDir); } catch { add(companyDir, "broken link"); continue; }
      if (lst.isSymbolicLink()) {
        let real: fs.Stats;
        try { real = fs.statSync(companyDir); } catch { add(companyDir, "broken link"); continue; }
        if (!real.isDirectory()) { add(companyDir, "not a folder"); continue; }
      } else if (!lst.isDirectory()) {
        add(companyDir, "not a folder");
        continue;
      }
      const f = L.companyFile(slug);
      // Security: never read through a folder that resolves outside the workspace.
      if (!insideRoot(root, companyDir)) { add(companyDir, "outside the workspace"); continue; }
      if (!fs.existsSync(f)) { add(companyDir, "missing company.json"); continue; }
      const c = tryRead("company", f);
      if (c && c.slug !== slug) add(f, `folder name and record disagree (slug "${c.slug}")`);
    }
  }
  // Recruitment agencies: recruiters/<slug>/agency.json, never read through a link.
  if (fs.existsSync(L.recruitersDir)) {
    for (const slug of fs.readdirSync(L.recruitersDir).sort()) {
      const f = L.agencyFile(slug);
      let st: fs.Stats;
      try { st = fs.lstatSync(f); } catch { continue; }
      if (st.isSymbolicLink() || !insideRoot(root, f)) { add(f, "outside the workspace"); continue; }
      const a = tryRead("agency", f);
      if (a && a.slug !== slug) add(f, `folder name and record disagree (slug "${a.slug}")`);
    }
  }
  const jobSkips: ListJobsSkip[] = [];
  for (const ref of listJobs(root, jobSkips)) {
    if (!insideRoot(root, ref.file)) { add(ref.file, "outside the workspace"); continue; }
    const j = tryRead("job", ref.file);
    if (!j) continue;
    if (j.company_slug !== ref.company_slug || j.id !== ref.id) add(ref.file, "folder name and record disagree");
    for (const fr of j.files) {
      const target = path.join(path.dirname(ref.file), fr.path);
      if (!insideRoot(path.dirname(ref.file), target)) { add(ref.file, `listed file is outside the job folder: ${fr.path}`); continue; }
      if (!fs.existsSync(target)) add(ref.file, `listed file is missing: ${fr.path}`);
    }
  }
  for (const s of jobSkips) add(s.file, s.problem);
  const { badLines } = readSearches(root);
  if (badLines.length) issues.push({ file: rel(L.searchLog), problems: badLines.map((n) => `line ${n} is not valid JSON`) });
  for (const kind of ["approvals", "requests"] as const) {
    const dir = path.join(root, ".careeros", kind);
    if (!fs.existsSync(dir)) continue;
    const skipped: QueueSkip[] = [];
    try {
      if (kind === "approvals") listApprovals(root, { skipped }); else listAccessRequests(root, { skipped });
    } catch (e) {
      add(dir, (e as Error).message);
      continue;
    }
    issues.push(...skipped);
  }
  return issues;
}
