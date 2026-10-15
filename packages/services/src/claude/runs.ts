import fs from "node:fs";
import path from "node:path";
import { careerosDir, writeFileAtomic } from "@careeros/core";
import { isActiveRun, type ClaudeRunView } from "@careeros/contract";

/** Run records: `.careeros/runs/<id>.json`, one per run, so the UI shows history and survives restarts. */
export const KEEP_RUNS = 50;
const MAX_RECORD_BYTES = 256 * 1024;
const ID = /^r-[0-9a-z]{6,20}-[0-9a-f]{8}$/;

function runsDir(root: string, create: boolean): string | null {
  const dir = path.join(root, ".careeros", "runs");
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(dir); } catch { st = undefined; }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(".careeros/runs must be a plain folder.");
  if (!st) {
    if (!create) return null;
    careerosDir(root);
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function saveRun(root: string, run: ClaudeRunView): void {
  if (!ID.test(run.id)) throw new Error("bad run id");
  const dir = runsDir(root, true)!;
  writeFileAtomic(path.join(dir, `${run.id}.json`), JSON.stringify(run, null, 2) + "\n");
}

function readOne(file: string): ClaudeRunView | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RECORD_BYTES) return null;
    const j = JSON.parse(fs.readFileSync(fd, "utf8")) as ClaudeRunView;
    return j && typeof j === "object" && typeof j.id === "string" && ID.test(j.id) && typeof j.status === "string" && Array.isArray(j.steps) ? j : null;
  } catch { return null; } finally { fs.closeSync(fd); }
}

/** Newest first. Drops records past KEEP_RUNS (finished ones only). */
export function listRuns(root: string): ClaudeRunView[] {
  const dir = runsDir(root, false);
  if (!dir) return [];
  const runs: ClaudeRunView[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
    const r = readOne(path.join(dir, name));
    if (r && r.id === name.slice(0, -5)) runs.push(r);
  }
  runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
  for (const old of runs.slice(KEEP_RUNS)) {
    if (!isActiveRun(old.status)) { try { fs.unlinkSync(path.join(dir, `${old.id}.json`)); } catch { /* already gone */ } }
  }
  return runs.slice(0, KEEP_RUNS);
}

/**
 * This month's cost total. Run records are pruned to KEEP_RUNS, so totals live in their own small ledger,
 * `.careeros/runs/costs.json`: { "YYYY-MM": { usd, runs } }, months in local time. The figures are Claude Code's
 * own estimates (`total_cost_usd`); on a subscription plan they are not a bill.
 */
type Ledger = Record<string, { usd: number; runs: number }>;
const MONTH = /^\d{4}-\d{2}$/;
const KEEP_MONTHS = 24;

export const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/** null: the ledger is there but unreadable (too big, not JSON, not a file); {} when there is none yet. */
function readLedger(dir: string): Ledger | null {
  const file = path.join(dir, "costs.json");
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const j = JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
    const out: Ledger = {};
    if (j && typeof j === "object" && !Array.isArray(j)) {
      for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
        const e = v as { usd?: unknown; runs?: unknown };
        if (MONTH.test(k) && e && typeof e.usd === "number" && Number.isFinite(e.usd) && e.usd >= 0 && Number.isInteger(e.runs) && (e.runs as number) >= 0) out[k] = { usd: e.usd, runs: e.runs as number };
      }
    }
    return out;
  } catch { return null; } finally { fs.closeSync(fd); }
}

export function addCost(root: string, at: Date, usd: number): void {
  if (!Number.isFinite(usd) || usd < 0) return;
  const dir = runsDir(root, true)!;
  let ledger = readLedger(dir);
  if (ledger === null) {
    // Keep a bad ledger aside instead of overwriting the history in it (F12).
    try { fs.renameSync(path.join(dir, "costs.json"), path.join(dir, `costs.bad-${Date.now()}.json`)); } catch { /* gone already */ }
    ledger = {};
  }
  const m = monthOf(at);
  const cur = ledger[m] ?? { usd: 0, runs: 0 };
  ledger[m] = { usd: Math.round((cur.usd + usd) * 1e6) / 1e6, runs: cur.runs + 1 };
  const keep = Object.keys(ledger).sort().slice(-KEEP_MONTHS);
  writeFileAtomic(path.join(dir, "costs.json"), JSON.stringify(Object.fromEntries(keep.map((k) => [k, ledger[k]])), null, 2) + "\n");
}

export function monthCost(root: string | null, at: Date): { month: string; usd: number; runs: number } {
  const month = monthOf(at);
  if (!root) return { month, usd: 0, runs: 0 };
  let dir: string | null;
  try { dir = runsDir(root, false); } catch { dir = null; }
  const e = dir ? readLedger(dir)?.[month] : undefined;
  return { month, usd: e?.usd ?? 0, runs: e?.runs ?? 0 };
}
