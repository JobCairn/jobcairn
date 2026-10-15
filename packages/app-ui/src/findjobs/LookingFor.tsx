import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Input, Text, useToast } from "@careeros/brand";
import {
  EXPERIENCE_LEVELS, EXPERIENCE_WORDS, JOB_TYPE_WORDS, JOB_TYPES, MAX_JOBS, POSTED_PRESETS, postedWords, RADIUS_PRESETS, SEARCH_SORTS, SORT_WORDS, POSTED_WORDS, SEARCH_BREADTHS, WORK_MODES, prefsDefaults, prefsMissing, prefsMissingText,
  profileLocationsFor, searchPrefsFrom, type ExperienceLevel, type JobType, type ProfileLocation, type SearchBreadth, type SearchSort, type SearchPrefs, type SettingsChange, type WorkMode,
} from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { navigate } from "../router";
import { chipValue, FilterChip, ManyChoices, OneChoice } from "../filters/FilterChip";
import { TagInput } from "../filters/TagInput";
import "../filters/filters.css";
import "./looking-for.css";

const MODE_WORDS: Record<WorkMode, string> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
const money = (n: number) => (n % 1000 === 0 ? `$${(n / 1000).toLocaleString("en-AU")}k` : `$${n.toLocaleString("en-AU")}`);

/** "Sampletown NSW, then Remote Australia" */
export function placesLine(p: Pick<SearchPrefs, "locations">): string {
  const [first, ...rest] = p.locations;
  if (!first) return "";
  return rest.length ? `${first}, then ${rest.join(", then ")}` : first;
}

/** "$100k+", "$100k to $140k", "Up to $140k", or "". */
export function payLine(p: Pick<SearchPrefs, "salary_min" | "salary_max">): string {
  if (p.salary_min !== null && p.salary_max !== null) return `${money(p.salary_min)} to ${money(p.salary_max)}`;
  if (p.salary_min !== null) return `${money(p.salary_min)}+`;
  if (p.salary_max !== null) return `Up to ${money(p.salary_max)}`;
  return "";
}

/** What the composer needs back: why the run can't start yet ("" when it can), and the saved breadth, sponsorship and jobs choices. */
export interface LookingForState {
  why: string; breadth: SearchBreadth; sponsor_only: boolean; max_jobs: number;
  /** The person's own places (preferred, then fallback), for reading places in "Describe the jobs you want". */
  places: string[];
}

export const BREADTH_WORDS: Record<SearchBreadth, { label: string; hint: string }> = {
  focused: { label: "Focused", hint: "Up to 5 searches on your closest roles" },
  broad: { label: "Broad", hint: "Up to 12 searches, with related titles" },
};

/** Pay: a minimum and an optional top, in whole dollars a year. */
function PayPanel({ min, max, currency, onApply }: { min: number | null; max: number | null; currency: string; onApply(min: number | null, max: number | null): void }) {
  const [lo, setLo] = useState(min === null ? "" : String(min));
  const [hi, setHi] = useState(max === null ? "" : String(max));
  const read = (s: string): number | null | false => {
    const t = s.replace(/[$,\s]/g, "").replace(/k$/i, "000");
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : false;
  };
  const a = read(lo), b = read(hi);
  const bad = a === false || b === false ? "Type a yearly amount, like 120000." : a !== null && b !== null && b < a ? "The top is under the minimum." : "";
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!bad) onApply(a as number | null, b as number | null); }}>
      <div className="qf-range">
        <Input label={`Minimum (${currency} a year)`} inputMode="decimal" value={lo} onChange={(e) => setLo(e.target.value)} placeholder="For example: 100000" />
        <Input label="Top (optional)" inputMode="decimal" value={hi} onChange={(e) => setHi(e.target.value)} placeholder="For example: 160000" />
      </div>
      {bad
        ? <Text role="body-sm" className="looking__error qf-panel__hint" aria-live="polite">{bad}</Text>
        : <Text role="body-sm" muted className="qf-panel__hint">Ads whose stated pay tops out under the minimum are skipped. Ads that don't state pay are kept.</Text>}
      <div className="qf-panel__foot"><Button size="sm" variant="primary" type="submit" disabled={!!bad} title={bad || undefined}>Apply</Button></div>
    </form>
  );
}

const WEEK = -1;
/** Posted within: any time, the presets, this week (since Monday), or a number of days typed in. */
export function PostedPanel({ days, week, onApply }: { days: number | null; week: boolean; onApply(days: number | null, week: boolean): void }) {
  const custom = !week && days !== null && !(POSTED_PRESETS as readonly number[]).includes(days);
  const [typed, setTyped] = useState(custom ? String(days) : "");
  const n = Number(typed.trim());
  const bad = typed.trim() && !(Number.isInteger(n) && n >= 1 && n <= 365) ? "Type a whole number of days from 1 to 365." : "";
  return (
    <div className="stack">
      <OneChoice<number> name="Posted" value={week ? WEEK : custom ? null : days} anyLabel="Any time"
        onChange={(v) => onApply(v === WEEK ? null : v, v === WEEK)}
        choices={[...POSTED_PRESETS.map((d) => ({ value: d as number, label: POSTED_WORDS[d]! })), { value: WEEK, label: "This week", hint: "Since Monday" }]} />
      <form className="qf-range" onSubmit={(e) => { e.preventDefault(); if (typed.trim() && !bad) onApply(n, false); }}>
        <Input label="Or the last (days)" inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="For example: 10" />
        <Button size="sm" variant="primary" type="submit" disabled={!typed.trim() || !!bad} title={bad || undefined}>Apply</Button>
      </form>
      {bad ? <Text role="body-sm" className="looking__error qf-panel__hint" aria-live="polite">{bad}</Text> : null}
    </div>
  );
}

/** Jobs to find: any whole number from MAX_JOBS.min to MAX_JOBS.max, typed (no slider: 1 to 200 is too wide to drag). */
function JobsPanel({ value, onApply }: { value: number; onApply(n: number): void }) {
  const [text, setText] = useState(String(value));
  const n = Number(text.trim());
  const bad = /^\d+$/.test(text.trim()) && n >= MAX_JOBS.min && n <= MAX_JOBS.max ? "" : `Type a whole number from ${MAX_JOBS.min} to ${MAX_JOBS.max}.`;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!bad) onApply(n); }}>
      <Input label="Jobs to find" type="number" inputMode="numeric" min={MAX_JOBS.min} max={MAX_JOBS.max} step={1} value={text} onChange={(e) => setText(e.target.value)}
        error={bad || undefined} help="Bigger searches take longer and use more of your Claude plan." />
      <div className="qf-panel__foot"><Button size="sm" variant="primary" type="submit" disabled={!!bad} title={bad || undefined}>Apply</Button></div>
    </form>
  );
}

/** A change from the chips: search preferences, the places with their work modes, and the big-tech switch. */
type Patch = Partial<SearchPrefs> & { places?: ProfileLocation[]; skip_big_tech?: boolean };

/** The settings changes that store a patch of search preferences: each filter in its one saved field. */
export function changesFor(patch: Patch, cur: SearchPrefs, stored: { profile: unknown; search: unknown }) {
  const profile: SettingsChange[] = [];
  const search: SettingsChange[] = [];
  const f = ((stored.search as { filters?: Record<string, unknown> } | null)?.filters ?? {});
  if (patch.roles) profile.push({ path: "targets.roles", value: patch.roles });
  if (patch.places) profile.push({ path: "locations", value: patch.places });
  else if (patch.locations) profile.push({ path: "locations", value: profileLocationsFor(patch.locations, (stored.profile as { locations?: unknown } | null)?.locations, cur.work_modes) });
  // An older workspace's own places list is read first; it's folded into the profile's, so it's emptied on any change.
  if ((patch.places || patch.locations) && Array.isArray(f.locations) && f.locations.length) search.push({ path: "filters.locations", value: [] });
  if (patch.places && Array.isArray(f.work_modes) && f.work_modes.length) search.push({ path: "filters.work_modes", value: [] });
  if (patch.fallback_locations) search.push({ path: "filters.fallback_locations", value: patch.fallback_locations });
  if (patch.countries_from !== undefined) search.push({ path: "filters.countries", value: patch.countries_from === "settings" ? patch.countries ?? [] : [] });
  if ("salary_min" in patch) profile.push({ path: "salary.min", value: patch.salary_min ?? null });
  if ("salary_max" in patch) search.push({ path: "filters.salary_max", value: patch.salary_max ?? null });
  if (patch.job_types) profile.push({ path: "targets.job_types", value: patch.job_types });
  if ("posted_days" in patch && !patch.posted_week) search.push({ path: "filters.posted_within_days", value: patch.posted_days ?? null });
  if ("posted_week" in patch || "posted_days" in patch) search.push({ path: "filters.posted_this_week", value: patch.posted_week === true });
  if (patch.exclude_companies) profile.push({ path: "skip_companies", value: patch.exclude_companies });
  if (patch.skip_big_tech !== undefined) profile.push({ path: "skip_big_tech", value: patch.skip_big_tech });
  if (patch.exclude_keywords) search.push({ path: "filters.exclude_keywords", value: patch.exclude_keywords });
  if (patch.sponsor_only !== undefined) search.push({ path: "filters.sponsor_only", value: patch.sponsor_only });
  if (patch.breadth) search.push({ path: "filters.breadth", value: patch.breadth });
  if (patch.sort) search.push({ path: "filters.sort", value: patch.sort });
  if (patch.experience) search.push({ path: "filters.experience", value: patch.experience });
  if (patch.easy_apply !== undefined) search.push({ path: "filters.easy_apply", value: patch.easy_apply });
  if ("radius_km" in patch) search.push({ path: "filters.radius_km", value: patch.radius_km ?? null });
  if (patch.max_jobs) search.push({ path: "filters.max_jobs", value: patch.max_jobs });
  return { profile, search };
}

/** Work mode: per place, as Settings › Search stores it. One place shows just its three choices. */
function ModesPanel({ places, onChange }: { places: ProfileLocation[]; onChange(next: ProfileLocation[]): void }) {
  if (!places.length) return <Text role="body-sm" muted className="qf-panel__hint">Add a place under Where first. Each place has its own work modes.</Text>;
  const set = (i: number, m: WorkMode, on: boolean) => onChange(places.map((p, j) => {
    if (j !== i) return p;
    const modes = WORK_MODES.filter((x) => (x === m ? on : p.modes.includes(x)));
    return { ...p, modes: modes.length ? modes : p.modes };
  }));
  return (
    <div className="looking__modes">
      {places.map((p, i) => (
        <fieldset key={p.place} className="looking__modes-row">
          <legend className={places.length > 1 ? "qf-panel__label" : "sr-only"}>{p.place}</legend>
          <div className="looking__modes-choices">
            {WORK_MODES.map((m) => (
              <Checkbox key={m} label={MODE_WORDS[m]} checked={p.modes.includes(m)} disabled={p.modes.length === 1 && p.modes.includes(m)}
                aria-label={places.length > 1 ? `${MODE_WORDS[m]} in ${p.place}` : undefined} onChange={(e) => set(i, m, e.target.checked)} />
            ))}
          </div>
        </fieldset>
      ))}
      <Text role="body-sm" muted className="qf-panel__hint">Each place needs at least one work mode. Willing to relocate is in Search settings.</Text>
    </div>
  );
}

/** Breadth: two choices, each with what it means. */
function BreadthPanel({ value, onChange }: { value: SearchBreadth; onChange(v: SearchBreadth): void }) {
  const group = useId();
  return (
    <fieldset className="qf-choices">
      <legend className="sr-only">Search breadth</legend>
      {SEARCH_BREADTHS.map((b) => (
        <label key={b} className="qf-choice looking__breadth">
          <input type="radio" name={group} checked={value === b} onChange={() => onChange(b)} />
          <span className="qf-choice__label">{BREADTH_WORDS[b].label}<span className="looking__breadth-hint">{BREADTH_WORDS[b].hint}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Find jobs › "What you're looking for": the search's filters as chips (roles, places in order with fallbacks and
 * country, work mode, pay, job type, posted within, sponsorship, what to skip, breadth, jobs to find). They are the saved search
 * settings themselves, not a copy: a change saves at once and shows in Settings › Search, and a change made there
 * shows here. When roles or a place are missing the search can't start, and one click fills them from the profile
 * or resume (never invented).
 */
export function LookingFor({ onState, sponsorOffered = false }: { onState(s: LookingForState): void; sponsorOffered?: boolean }) {
  const bridge = useBridge();
  const toast = useToast();
  const data = useLoad(async (b) => {
    const [profile, search, suggested] = await Promise.all([b.settings.get("profile"), b.settings.get("search"), b.profile.suggestions().catch(() => null)]);
    return { profile: profile.values, search: search.values, suggested: suggested?.roles ?? [] };
  }, [], ["settings"]);
  // What was just changed here, shown until the saved settings reload with it (so an open panel never flickers back).
  const [shown, setShown] = useState<Patch>({});
  const inFlight = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const headId = useId();
  const d = data.data;
  useEffect(() => { if (!inFlight.current) setShown({}); }, [d]);
  const saved = useMemo(() => (d ? searchPrefsFrom(d.profile, d.search) : null), [d]);
  const cur: SearchPrefs | null = saved ? { ...saved, ...shown } : null;
  const missing = cur ? prefsMissing(cur) : [];
  const why = cur ? prefsMissingText(missing) : "";
  const breadth = cur?.breadth ?? "focused";
  const sponsorOnly = cur?.sponsor_only ?? false;
  const maxJobs = cur?.max_jobs ?? MAX_JOBS.default;
  const placeKey = cur ? JSON.stringify([...cur.locations, ...cur.fallback_locations]) : "[]";
  useEffect(() => { onState({ why, breadth, sponsor_only: sponsorOnly, max_jobs: maxJobs, places: JSON.parse(placeKey) as string[] }); }, [why, breadth, sponsorOnly, maxJobs, placeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d || !saved || !cur) return null;
  const defaults = prefsDefaults(d.profile, d.suggested);
  const stored = { profile: d.profile, search: d.search };
  const places = shown.places ?? profileLocationsFor(cur.locations, (d.profile as { locations?: unknown }).locations);
  /** Saves a change straight to the search settings, in order, one at a time. */
  const set = (patch: Patch) => {
    const { profile, search } = changesFor(patch, cur, stored);
    const placesPatch = patch.places ? { places: patch.places, locations: patch.places.map((p) => p.place),
      work_modes: ((m) => (m.length === WORK_MODES.length ? [] : m))(WORK_MODES.filter((m) => patch.places!.some((p) => p.modes.includes(m)))) } : patch.locations ? { places: undefined } : {};
    setShown((s) => ({ ...s, ...patch, ...placesPatch }));
    inFlight.current += 1;
    const job = queue.current.then(async () => {
      if (profile.length) await bridge.settings.save("profile", profile);
      if (search.length) await bridge.settings.save("search", search);
    });
    queue.current = job.catch(() => undefined);
    job.catch((e: unknown) => { toast({ tone: "danger", text: `Not saved: ${errorText(e)}` }); })
      .finally(() => { inFlight.current -= 1; if (!inFlight.current) data.reload(); });
  };

  const canQuick = missing.length > 0 && defaults.roles.length > 0 && defaults.locations.length > 0;
  const where = placesLine(cur);
  const whereValue = cur.locations.length ? `${chipValue(cur.locations, 2)}${cur.fallback_locations.length ? `, then ${cur.fallback_locations.length} more` : ""}` : "";
  const bigTech = shown.skip_big_tech ?? (d.profile as { skip_big_tech?: unknown }).skip_big_tech === true;
  const skip = [...(bigTech ? ["Big tech"] : []), ...cur.exclude_companies, ...cur.exclude_keywords];
  const placesFrom = (locations: string[], countries: string[]) => searchPrefsFrom({}, { filters: { locations, countries } });
  const allModes = places.map((p) => [...p.modes]);
  const modesDiffer = allModes.some((m) => JSON.stringify(m) !== JSON.stringify(allModes[0]));

  return (
    <section className="composer__section looking" aria-labelledby={headId} data-missing={missing.length ? true : undefined}>
      <div className="looking__head">
        <div className="looking__title">
          <Text role="body" as="h3" className="composer__label" id={headId}>What you're looking for</Text>
          <Text role="body-sm" muted as="p" className="looking__saved">Saved to your search settings. Changes here show there too.</Text>
        </div>
        <Button size="sm" variant="ghost" onClick={() => navigate({ screen: "settings", tab: "search" })}>Search settings</Button>
      </div>
      {missing.length ? (
        <div className="looking__quick">
          <Text role="body-sm">Claude needs at least one role and one place, so it doesn't bring back jobs from the wrong country.</Text>
          {canQuick ? (
            <Button size="sm" variant="primary" title={`Use ${defaults.roles.join(", ")} in ${defaults.locations.join(", ")}`} onClick={() => set({ ...(cur.roles.length ? {} : { roles: defaults.roles }), ...(cur.locations.length ? {} : { locations: defaults.locations }) })}>
              Use defaults
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="qf-bar looking__chips" role="group" aria-label="Search filters">
        <FilterChip kind="setting" label="Roles" value={chipValue(cur.roles, 2)} clearable={false} wide onClear={() => set({ roles: [] })}>
          {() => (
            <div className="qf-panel__section">
              <TagInput label="Roles" item="role" values={cur.roles} onChange={(v) => set({ roles: v })} placeholder="Add a role, like AI Engineer" />
              {saved.related_titles.length ? <Text role="body-sm" muted className="qf-panel__hint">{`Also searched: ${saved.related_titles.join(", ")}. Change these in Search settings.`}</Text> : null}
            </div>
          )}
        </FilterChip>
        <FilterChip kind="setting" label="Where" value={whereValue} clearable={false} wide onClear={() => set({ locations: [] })}>
          {() => (
            <>
              <div className="qf-panel__section">
                <span className="qf-panel__label">Places, most preferred first</span>
                <TagInput label="Places" item="place" values={cur.locations} ordered places placeholder="Add a place, like Brisbane"
                  onChange={(v) => { const n = placesFrom(v, cur.countries_from === "settings" ? cur.countries : []); set({ locations: v, countries: n.countries, countries_from: n.countries_from }); }} />
              </div>
              <div className="qf-panel__section">
                <span className="qf-panel__label">{`If there are fewer than ${cur.min_results} matches, also search`}</span>
                <TagInput label="Fallback places" item="fallback place" values={cur.fallback_locations} places placeholder="Add a place, like Sydney" onChange={(v) => set({ fallback_locations: v })} />
              </div>
              <div className="qf-panel__section">
                <span className="qf-panel__label">{cur.countries_from === "settings" ? "Countries jobs must be in" : `Countries jobs must be in. Now ${cur.countries.join(", ") || "any"}, read from your places.`}</span>
                <TagInput label="Countries" item="country" values={cur.countries_from === "settings" ? cur.countries : []} placeholder="Add a country, like Australia"
                  onChange={(v) => { const n = placesFrom(cur.locations, v); set({ countries: n.countries, countries_from: n.countries_from }); }} />
              </div>
            </>
          )}
        </FilterChip>
        <FilterChip kind="setting" label="Work mode" value={modesDiffer ? "Varies by place" : chipValue(cur.work_modes.map((m) => MODE_WORDS[m]), 3)} wide={places.length > 1}
          onClear={() => set({ places: places.map((p) => ({ ...p, modes: [...WORK_MODES] })) })}>
          {() => <ModesPanel places={places} onChange={(next) => set({ places: next })} />}
        </FilterChip>
        <FilterChip kind="setting" label="Pay" value={payLine(cur)} onClear={() => set({ salary_min: null, salary_max: null })}>
          {(close) => <PayPanel min={cur.salary_min} max={cur.salary_max} currency={cur.currency} onApply={(a, b) => { set({ salary_min: a, salary_max: b }); close(); }} />}
        </FilterChip>
        <FilterChip kind="setting" label="Job type" value={chipValue(cur.job_types.map((t) => JOB_TYPE_WORDS[t]), 2)} onClear={() => set({ job_types: [] })}>
          {() => <ManyChoices name="Job type" value={cur.job_types} onChange={(v) => set({ job_types: JOB_TYPES.filter((t) => v.includes(t)) as JobType[] })}
            choices={JOB_TYPES.map((t) => ({ value: t, label: JOB_TYPE_WORDS[t] }))} />}
        </FilterChip>
        <FilterChip kind="setting" label="Posted" value={postedWords(cur.posted_days, cur.posted_week)} onClear={() => set({ posted_days: null, posted_week: false })}>
          {(close) => <PostedPanel days={cur.posted_days} week={cur.posted_week} onApply={(days, week) => { set({ posted_days: days, posted_week: week }); close(); }} />}
        </FilterChip>
        {sponsorOffered ? (
          <FilterChip kind="setting" label="Sponsorship" value={cur.sponsor_only ? "Offered in the ad" : ""} onClear={() => set({ sponsor_only: false })}>
            {() => (
              <div className="qf-panel__section">
                <Checkbox label="Only ads that offer sponsorship" checked={cur.sponsor_only} onChange={(e) => set({ sponsor_only: e.target.checked })} />
                <Text role="body-sm" muted className="qf-panel__hint">Skips ads that say nothing about visa sponsorship.</Text>
              </div>
            )}
          </FilterChip>
        ) : null}
        <FilterChip kind="setting" label="Skip" value={skip.length ? chipValue(skip, 2) : ""} wide
          onClear={() => set({ exclude_companies: [], exclude_keywords: [], skip_big_tech: false })}>
          {() => (
            <>
              <div className="qf-panel__section">
                <Checkbox label="Skip big tech" checked={bigTech} onChange={(e) => set({ skip_big_tech: e.target.checked })} />
              </div>
              <div className="qf-panel__section">
                <span className="qf-panel__label">Companies to skip</span>
                <TagInput label="Companies" item="company" values={cur.exclude_companies} max={40} placeholder="Add a company" onChange={(v) => set({ exclude_companies: v })} />
              </div>
              <div className="qf-panel__section">
                <span className="qf-panel__label">Skip ads that mention</span>
                <TagInput label="Words" item="word" values={cur.exclude_keywords} max={30} placeholder="Add a word, like clearance" onChange={(v) => set({ exclude_keywords: v })} />
              </div>
            </>
          )}
        </FilterChip>
        <FilterChip kind="setting" label="Order" value={cur.sort === "recent" ? SORT_WORDS.recent : ""} onClear={() => set({ sort: "relevance" })}>
          {(close) => <OneChoice<SearchSort> name="Order" value={cur.sort} anyLabel={SORT_WORDS.relevance} onChange={(v) => { set({ sort: v ?? "relevance" }); close(); }}
            choices={SEARCH_SORTS.filter((s) => s !== "relevance").map((s) => ({ value: s, label: SORT_WORDS[s] }))} />}
        </FilterChip>
        <FilterChip kind="setting" label="Level" value={chipValue([...cur.experience.map((x) => EXPERIENCE_WORDS[x]), ...(cur.easy_apply ? ["Easy Apply"] : [])], 2)}
          onClear={() => set({ experience: [], easy_apply: false })}>
          {() => (
            <>
              <ManyChoices name="Experience level" value={cur.experience} onChange={(v) => set({ experience: EXPERIENCE_LEVELS.filter((x) => v.includes(x)) as ExperienceLevel[] })}
                choices={EXPERIENCE_LEVELS.map((x) => ({ value: x, label: EXPERIENCE_WORDS[x] }))} />
              <div className="qf-panel__section">
                <Checkbox label="LinkedIn: Easy Apply jobs only" checked={cur.easy_apply} onChange={(e) => set({ easy_apply: e.target.checked })} />
                <Text role="body-sm" muted className="qf-panel__hint">LinkedIn filters by level. Elsewhere Claude skips only ads clearly at another level.</Text>
              </div>
            </>
          )}
        </FilterChip>
        <FilterChip kind="setting" label="Distance" value={cur.radius_km === null ? "" : `Within ${cur.radius_km} km`} onClear={() => set({ radius_km: null })}>
          {(close) => <OneChoice name="Distance" value={cur.radius_km} anyLabel="Board default" onChange={(v) => { set({ radius_km: v }); close(); }}
            choices={RADIUS_PRESETS.map((n) => ({ value: n, label: `Within ${n} km` }))} />}
        </FilterChip>
        <FilterChip kind="setting" label="Breadth" value={BREADTH_WORDS[cur.breadth].label} clearable={false} onClear={() => set({ breadth: "focused" })}>
          {(close) => <BreadthPanel value={cur.breadth} onChange={(v) => { set({ breadth: v }); close(); }} />}
        </FilterChip>
        <FilterChip kind="setting" label="Jobs" value={`Up to ${cur.max_jobs}`} clearable={false} onClear={() => set({ max_jobs: MAX_JOBS.default })}>
          {(close) => <JobsPanel value={cur.max_jobs} onApply={(n) => { set({ max_jobs: n }); close(); }} />}
        </FilterChip>
      </div>
      {where ? (
        <Text role="body-sm" muted>{`Claude searches ${where} first, and skips jobs outside ${cur.countries.length ? cur.countries.join(" or ") : "those places"} unless they're remote and open to you.`}</Text>
      ) : null}
    </section>
  );
}
