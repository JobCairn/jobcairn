import { useState } from "react";
import { Button, Checkbox, Input, Text } from "@careeros/brand";
import {
  FIT_PRESETS, JOB_STATUSES, JOB_TYPE_WORDS, JOB_TYPES, JOB_WORK_MODES, POSTED_PRESETS, POSTED_WORDS, postedWords, SALARY_PRESETS, SPONSOR_TIER_WORDS, SPONSOR_TIERS,
  WORK_MODE_WORDS, WR_LABEL_TEXT, type JobFacets, type JobType, type SponsorTier, type WorkRightsLabel,
} from "@careeros/contract";
import { chipValue, FilterChip, ManyChoices, OneChoice, QuickFilterBar, type ChoiceTone } from "../filters/FilterChip";
import { activeFilters, NO_FILTERS, type JobFilters } from "./filters";

const TIER_TONE: Record<SponsorTier, ChoiceTone> = { confirmed: "success", likely: "success", possible: "warning", low: "danger", unknown: "neutral" };
/** The Sponsor column's words for each tier, so the two read as one scale. */
const TIER_SUB: Record<SponsorTier, string> = { confirmed: "the ad offers it", likely: "High, 65+", possible: "Medium, 45 to 64", low: "Low or ruled out", unknown: "no score yet" };
const TIER_HINT: Record<SponsorTier, string> = {
  confirmed: "The ad says sponsorship is available.",
  likely: "Sponsor score 65 or more.",
  possible: "Sponsor score 45 to 64.",
  low: "Sponsor score under 45, or the ad rules sponsorship out.",
  unknown: "No sponsor score saved with the job yet.",
};
/** "$100k" */
export const money = (n: number) => (n % 1000 === 0 ? `$${(n / 1000).toLocaleString("en-AU")}k` : `$${n.toLocaleString("en-AU")}`);
const FIT_WORDS: Record<number, string> = { 50: "50 or more", 70: "70 or more, good match", 85: "85 or more, strong match" };
const TYPE_WORD = (t: JobType | "") => (t ? JOB_TYPE_WORDS[t] : "Not stated");

export interface JobQuickFiltersProps {
  filters: JobFilters;
  onChange(f: JobFilters): void;
  facets: JobFacets | undefined;
  /** The Sponsorship chip exists only for someone sponsorship is relevant to. */
  showSponsorship: boolean;
  /** Work-rights labels that can matter to this person (empty: no Work rights chip). */
  rights: readonly WorkRightsLabel[];
  /** The Apply view fixes the status, so it has no Status chip. */
  hideStatus?: boolean;
  /** Clear all also clears the search box: true when there's text in it. */
  searching?: boolean;
  onClearAll?(): void;
}

/** Location: type a place, or pick one of the places in the list with its count. */
function LocationPanel({ value, places, onPick }: { value: string; places: JobFacets["locations"]; onPick(v: string): void }) {
  const [typed, setTyped] = useState(value);
  const q = typed.trim().toLowerCase();
  const shown = places.filter((p) => !q || p.name.toLowerCase().includes(q));
  return (
    <>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onPick(typed.trim()); }}>
        <Input label="Place contains" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="For example: Sydney or Remote" />
      </form>
      {shown.length ? (
        <ul className="qf-places list-plain" aria-label="Places in your jobs">
          {shown.map((p) => (
            <li key={p.name}>
              <button type="button" className="qf-place" onClick={() => onPick(p.name)}>
                <span>{p.name}</span><span className="qf-count" aria-label={`${p.count} ${p.count === 1 ? "job" : "jobs"}`}>{p.count}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <Text role="body-sm" muted className="qf-panel__hint">{places.length ? "No job's place matches that yet. Press Enter to filter by it anyway." : "No places recorded on these jobs."}</Text>}
      <div className="qf-panel__foot">
        <Button size="sm" variant="primary" onClick={() => onPick(typed.trim())}>Apply</Button>
      </div>
    </>
  );
}

/** Salary at least: a few amounts, or type one. Ads that don't state pay stay in the list. */
function SalaryPanel({ value, counts, onPick }: { value: number | null; counts: Record<string, number> | undefined; onPick(v: number | null): void }) {
  const [typed, setTyped] = useState(value !== null && !(SALARY_PRESETS as readonly number[]).includes(value) ? String(value) : "");
  const n = Number(typed.replace(/[$,\s]/g, "").replace(/k$/i, "000"));
  const ok = typed.trim() !== "" && Number.isFinite(n) && n > 0;
  return (
    <>
      <OneChoice name="Salary at least" value={value} onChange={onPick} anyLabel="Any pay"
        choices={SALARY_PRESETS.map((v) => ({ value: v, label: `${money(v)} or more`, count: counts?.[String(v)] }))} />
      <form className="qf-panel__foot" onSubmit={(e) => { e.preventDefault(); if (ok) onPick(n); }}>
        <Input label="Or type an amount" hideLabel placeholder="Or type an amount, like 130000" value={typed} inputMode="decimal" onChange={(e) => setTyped(e.target.value)}
          error={typed.trim() && !ok ? "Type a yearly amount, like 130000." : undefined} />
        <Button size="sm" type="submit" disabled={!ok} title={ok ? undefined : "Type an amount first."}>Apply</Button>
      </form>
      <Text role="body-sm" muted className="qf-panel__hint">Ads that don't state pay stay in the list.</Text>
    </>
  );
}

/**
 * The Jobs list's quick filters: one chip per filter with its choices and live counts, active chips showing
 * their value and an x, and Clear all. State lives in the screen (address and per-workspace memory).
 */
export function JobQuickFilters({ filters: f, onChange, facets, showSponsorship, rights, hideStatus, searching, onClearAll }: JobQuickFiltersProps) {
  const set = <K extends keyof JobFilters>(k: K, v: JobFilters[K]) => onChange({ ...f, [k]: v });
  const sites = facets?.sites ?? [];
  const siteChoices = [...sites, ...f.sites.filter((s) => !sites.some((x) => x.name.toLowerCase() === s.toLowerCase())).map((name) => ({ name, count: 0 }))];
  const tiers = SPONSOR_TIERS.filter((t) => t !== "unknown" || (facets?.sponsor.unknown ?? 0) > 0 || f.sponsor.includes(t));
  const types = [...JOB_TYPES, ""].filter((t) => t !== "" || (facets?.jobTypes[""] ?? 0) > 0 || f.jobTypes.includes("")) as (JobType | "")[];
  const active = activeFilters({ ...f, statuses: hideStatus ? [] : f.statuses }) + (searching ? 1 : 0);
  return (
    <QuickFilterBar label="Quick filters" active={active} data-tour="jobs-filters"
      onClearAll={onClearAll ?? (() => onChange({ ...NO_FILTERS, statuses: hideStatus ? f.statuses : [] }))}>
      {showSponsorship ? (
        <FilterChip label="Sponsorship" value={chipValue(f.sponsor.map((t) => SPONSOR_TIER_WORDS[t]))} onClear={() => set("sponsor", [])}>
          {() => <ManyChoices name="Sponsorship" value={f.sponsor} onChange={(v) => set("sponsor", v)}
            choices={tiers.map((t) => ({ value: t, label: SPONSOR_TIER_WORDS[t], tone: TIER_TONE[t], count: facets?.sponsor[t], hint: TIER_HINT[t], sub: TIER_SUB[t] }))} />}
        </FilterChip>
      ) : null}
      <FilterChip label="Work mode" value={chipValue(f.modes.map((m) => WORK_MODE_WORDS[m]), 3)} onClear={() => set("modes", [])}>
        {() => <ManyChoices name="Work mode" value={f.modes} onChange={(v) => set("modes", v)}
          choices={JOB_WORK_MODES.map((m) => ({ value: m, label: WORK_MODE_WORDS[m], count: facets?.modes[m] }))} />}
      </FilterChip>
      <FilterChip label="Location" value={f.location.trim()} onClear={() => set("location", "")}>
        {(close) => <LocationPanel value={f.location} places={facets?.locations ?? []} onPick={(v) => { set("location", v); close(); }} />}
      </FilterChip>
      <FilterChip label="Salary" value={f.salaryMin === null ? "" : `${money(f.salaryMin)}+`} onClear={() => set("salaryMin", null)}>
        {(close) => <SalaryPanel value={f.salaryMin} counts={facets?.salaryMin} onPick={(v) => { set("salaryMin", v); close(); }} />}
      </FilterChip>
      <FilterChip label="Posted" value={postedWords(f.postedDays)} onClear={() => set("postedDays", null)}>
        {(close) => (
          <>
            <OneChoice name="Posted" value={f.postedDays} onChange={(v) => { set("postedDays", v); close(); }} anyLabel="Any time"
              choices={POSTED_PRESETS.map((d) => ({ value: d, label: POSTED_WORDS[d]!, count: facets?.postedDays[String(d)] }))} />
            <div className="qf-panel__section">
              <Checkbox label={`Include jobs with no posted date${facets ? ` (${facets.postedUnknown})` : ""}`} checked={f.postedUndated}
                onChange={(e) => set("postedUndated", e.target.checked)} />
            </div>
            <Text role="body-sm" muted className="qf-panel__hint">Uses the date on the ad. "About" dates were worked out from what the board said, like "3d ago".</Text>
          </>
        )}
      </FilterChip>
      <FilterChip label="Fit" value={f.fitMin === null ? "" : `${f.fitMin}+`} onClear={() => set("fitMin", null)}>
        {(close) => (
          <>
            <OneChoice name="Fit at least" value={f.fitMin} onChange={(v) => { set("fitMin", v); close(); }} anyLabel="Any fit"
              choices={FIT_PRESETS.map((n) => ({ value: n, label: FIT_WORDS[n]!, count: facets?.fitMin[String(n)] }))} />
            <Text role="body-sm" muted className="qf-panel__hint">Jobs Claude hasn't scored yet are left out.</Text>
          </>
        )}
      </FilterChip>
      {hideStatus ? null : (
        <FilterChip label="Status" value={chipValue(f.statuses)} onClear={() => set("statuses", [])}>
          {() => <ManyChoices name="Status" value={f.statuses} onChange={(v) => set("statuses", v)}
            choices={JOB_STATUSES.map((s) => ({ value: s, label: s, count: facets?.statuses[s] }))} />}
        </FilterChip>
      )}
      <FilterChip label="Board" value={chipValue(f.sites)} onClear={() => set("sites", [])}>
        {() => siteChoices.length ? (
          <ManyChoices name="Board" value={f.sites} onChange={(v) => set("sites", v)} choices={siteChoices.map((s) => ({ value: s.name, label: s.name, count: s.count }))} />
        ) : <Text role="body-sm" muted className="qf-panel__hint">No boards recorded on these jobs yet.</Text>}
      </FilterChip>
      <FilterChip label="Job type" value={chipValue(f.jobTypes.map(TYPE_WORD))} onClear={() => set("jobTypes", [])}>
        {() => <ManyChoices name="Job type" value={f.jobTypes} onChange={(v) => set("jobTypes", v)}
          choices={types.map((t) => ({ value: t, label: TYPE_WORD(t), count: facets?.jobTypes[t] }))} />}
      </FilterChip>
      {rights.length ? (
        <FilterChip label="Work rights" value={chipValue(f.labels.map((l) => WR_LABEL_TEXT[l]), 1)} onClear={() => set("labels", [])} data-tour="jobs-rights">
          {() => <ManyChoices name="Work rights" value={f.labels} onChange={(v) => set("labels", v)}
            choices={rights.map((l) => ({ value: l, label: WR_LABEL_TEXT[l], count: facets?.labels[l] ?? 0 }))} />}
        </FilterChip>
      ) : null}
    </QuickFilterBar>
  );
}
