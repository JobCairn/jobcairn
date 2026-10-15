// Salary benchmark: how a job's stated pay compares with the other ads the person saved for the same kind of role
// in the same city. Pure, local and only as good as the ads saved: it is a benchmark of their own search, not the
// market.
import { rowSalary, SUPER_RATE, YEARLY_PLAUSIBLE } from "./analytics.js";
import type { JobRow } from "./types.js";

/**
 * Pay stated by the day or hour, made yearly. ASSUMPTION: a full-time year is 220 working days (52 weeks less leave,
 * public holidays and a few sick days) and 1,760 working hours (220 days of 8 hours). Contract rates usually carry
 * no paid leave, so this flatters them a little; that is the usual rule of thumb in Australian contracting.
 */
export const ANNUALISE = { year: 1, day: 220, hour: 1_760 } as const;
/** A bucket needs at least this many ads (besides the job being compared) before it says anything. */
export const BENCHMARK_MIN_ADS = 5;
/** Within this fraction of the median counts as "about the median". */
const NEAR = 0.025;

/** A row's pay as a yearly base salary: the middle of a range, made yearly, super taken out of a package. */
export function annualPay(r: Pick<JobRow, "salary_min" | "salary_max" | "salary_text">): number | null {
  const s = rowSalary(r);
  if (!s) return null;
  const mid = s.min !== null && s.max !== null ? (s.min + s.max) / 2 : s.min ?? s.max;
  if (mid === null || !Number.isFinite(mid) || mid <= 0) return null;
  let yearly = mid * ANNUALISE[s.period];
  if (s.includesSuper) yearly /= 1 + SUPER_RATE;
  // Checked after converting, so a typo'd "$95 per day" or "$1,200 per hour" never skews the numbers.
  return yearly >= YEARLY_PLAUSIBLE.min && yearly <= YEARLY_PLAUSIBLE.max ? Math.round(yearly) : null;
}

const SENIORITY = new Set([
  "senior", "snr", "sr", "junior", "jnr", "jr", "lead", "principal", "staff", "mid", "level", "graduate", "grad", "entry", "intermediate",
  "associate", "experienced", "trainee", "intern", "i", "ii", "iii", "iv", "1", "2", "3", "4",
]);

/**
 * The kind of role, from the title: case, punctuation, anything in brackets and seniority words go ("Senior Data
 * Analyst (Contract)" and "Data Analyst II" are both "data analyst"). Empty when nothing is left.
 */
export function roleFamily(title: string): string {
  return (title ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .split(/\s+[-–—|]\s+/)[0]!.replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter((w) => w && !SENIORITY.has(w)).join(" ");
}

/** Australian and New Zealand cities, longest names first so "Gold Coast" wins over "Coast". */
const CITIES = [
  "Sunshine Coast", "Gold Coast", "Newcastle", "Wollongong", "Geelong", "Townsville", "Cairns", "Toowoomba", "Darwin", "Hobart", "Canberra",
  "Adelaide", "Perth", "Brisbane", "Melbourne", "Sydney", "Auckland", "Wellington", "Christchurch",
];

/** The city of a job's place ("Sydney NSW" → "Sydney"), "Remote" for remote-only roles, or "" when unknown. */
export function cityOf(location: string, workMode = ""): string {
  const l = ` ${(location ?? "").toLowerCase().replace(/[^a-z]+/g, " ")} `;
  const hit = CITIES.find((c) => l.includes(` ${c.toLowerCase()} `));
  if (hit) return hit;
  return /\bremote\b/.test(l) || /\bremote\b/i.test(workMode) ? "Remote" : "";
}

/** The p-th percentile (0-1) of sorted numbers, interpolating between ranks (the same as Excel's PERCENTILE.INC). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const at = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export interface SalaryBenchmarkRow {
  /** Role family words ("data analyst") and a display form ("Data analyst"). */
  family: string; label: string;
  city: string;
  count: number; p25: number; p50: number; p75: number;
}

const bucketKey = (family: string, city: string) => `${family}|${city}`;
const display = (family: string) => family.charAt(0).toUpperCase() + family.slice(1);

interface Paid { row: JobRow; pay: number; family: string; city: string }
function paidRows(rows: JobRow[]): Paid[] {
  return rows.flatMap((row) => {
    const pay = annualPay(row);
    const family = roleFamily(row.title);
    const city = cityOf(row.location, row.work_mode);
    return pay !== null && family && city ? [{ row, pay, family, city }] : [];
  });
}

function stats(pays: number[]): { p25: number; p50: number; p75: number } {
  const s = [...pays].sort((a, b) => a - b);
  return { p25: Math.round(percentile(s, 0.25)), p50: Math.round(percentile(s, 0.5)), p75: Math.round(percentile(s, 0.75)) };
}

/** Every role family and city with at least BENCHMARK_MIN_ADS ads stating pay, most ads first. */
export function salaryBenchmarks(rows: JobRow[]): SalaryBenchmarkRow[] {
  const groups = new Map<string, Paid[]>();
  for (const p of paidRows(rows)) {
    const k = bucketKey(p.family, p.city);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  }
  return [...groups.values()].filter((g) => g.length >= BENCHMARK_MIN_ADS).map((g) => ({
    family: g[0]!.family, label: display(g[0]!.family), city: g[0]!.city, count: g.length, ...stats(g.map((p) => p.pay)),
  })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.city.localeCompare(b.city));
}

export interface SalaryComparison extends SalaryBenchmarkRow {
  /** This job's yearly pay as compared. */
  pay: number;
  position: "above" | "about" | "below";
  /** "Above the median of 14 similar ads you've saved" */
  text: string;
}

/**
 * How one job's pay compares with the other saved ads for the same role family and city (the job itself left out).
 * Null when the job states no usable pay, or fewer than BENCHMARK_MIN_ADS other ads are in its bucket.
 */
export function compareSalary(job: Pick<JobRow, "company_slug" | "id" | "title" | "location" | "work_mode" | "salary_min" | "salary_max" | "salary_text">, rows: JobRow[]): SalaryComparison | null {
  const pay = annualPay(job);
  const family = roleFamily(job.title);
  const city = cityOf(job.location, job.work_mode);
  if (pay === null || !family || !city) return null;
  const others = paidRows(rows).filter((p) => p.family === family && p.city === city && !(p.row.company_slug === job.company_slug && p.row.id === job.id));
  if (others.length < BENCHMARK_MIN_ADS) return null;
  const st = stats(others.map((p) => p.pay));
  const position = Math.abs(pay - st.p50) <= st.p50 * NEAR ? "about" : pay > st.p50 ? "above" : "below";
  const lead = position === "about" ? "About the median" : position === "above" ? "Above the median" : "Below the median";
  return { family, label: display(family), city, count: others.length, ...st, pay, position, text: `${lead} of ${others.length} similar ads you've saved` };
}
