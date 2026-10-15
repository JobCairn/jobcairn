import type { ReactNode } from "react";
import { Icons, SectionTitle, Text, type IconGlyph } from "@careeros/brand";
import { optionsFor, WR_STATUSES, type WorkRightsStatus } from "@careeros/contract";
import { useLoad } from "../bridge-context";
import { FieldForm, type FieldAddons } from "../components/FieldForm";
import { SuggestTitles } from "../resumefill/SuggestTitles";

/** Settings › Search: "Suggest" related titles from the resume, under Related job titles. */
export const SEARCH_ADDONS: FieldAddons = {
  "filters.related_titles": (v, save) => {
    const cur = Array.isArray(v) ? (v as string[]) : [];
    return <SuggestTitles current={cur} onAdd={(t) => save([...cur, ...t])} />;
  },
};

/**
 * The profile fields that are search filters. They're edited under Settings › Search (and by Find jobs' chips), so
 * Settings › Profile leaves them out: each filter has one home.
 */
export const SEARCH_PROFILE_PATHS = ["targets.roles", "targets.job_types", "locations", "salary", "industries", "skip_companies", "skip_big_tech"] as const;

function Section({ id, icon, title, children }: { id: string; icon: IconGlyph; title: string; children: ReactNode }) {
  return (
    <section className="field-group search-section" id={`settings-${id}`} data-section={id} aria-labelledby={`settings-${id}-title`}>
      <SectionTitle icon={icon} title={title} as="h3" id={`settings-${id}-title`} className="section-title--compact" />
      <div className="search-section__body">{children}</div>
    </section>
  );
}

/** The sections, in page order, with the short name the jump links use. */
const SECTIONS = [
  { id: "search-roles", short: "Roles" }, { id: "where", short: "Places" }, { id: "pay", short: "Pay" },
  { id: "skip", short: "Skip" }, { id: "breadth", short: "Breadth" }, { id: "plan", short: "Plan" },
] as const;

/** A row of jump links, so the long page can be crossed in one click. Focus moves to the section's heading. */
function SectionLinks() {
  const go = (id: string) => {
    const el = document.getElementById(`settings-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    const h = document.getElementById(`settings-${id}-title`);
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  };
  return (
    <nav className="section-links" aria-label="Jump to a section">
      <span className="t-body-sm t-muted">Jump to</span>
      {SECTIONS.map((x) => <button key={x.id} type="button" className="link-btn" onClick={() => go(x.id)}>{x.short}</button>)}
    </nav>
  );
}

/**
 * Every Find jobs filter in one place, in the same order as its chips. The fields are stored once (roles, places,
 * pay, job types and companies in the profile; the rest in settings/search.json), and the chips in Find jobs edit
 * the very same fields, so a change in either place shows in the other.
 */
export function SearchSettings() {
  const profile = useLoad((b) => b.settings.get("profile"), [], ["settings"]);
  const raw = (profile.data?.values.work_rights as { status?: unknown } | undefined)?.status;
  const status: WorkRightsStatus = (WR_STATUSES as readonly unknown[]).includes(raw) ? (raw as WorkRightsStatus) : "unknown";
  // "Only ads that offer sponsorship" is offered only to someone who needs sponsorship, here as in Find jobs.
  const sponsor = optionsFor("find_jobs", status).some((o) => o.key === "sponsor_only");
  return (
    <div className="stack settings-search">
      <Text role="body-sm" muted>Find jobs uses these. Its filter chips change the same settings, so both always match.</Text>
      <SectionLinks />
      <Section id="search-roles" icon={Icons.target} title="Roles">
        <FieldForm kind="profile" only={["targets.roles"]} bare />
        <FieldForm kind="search" only={["filters.related_titles"]} bare addons={SEARCH_ADDONS} />
      </Section>
      <Section id="where" icon={Icons.place} title="Where and how you work">
        <FieldForm kind="profile" only={["locations"]} bare />
        <FieldForm kind="search" only={["filters.fallback_locations", "filters.min_results", "filters.countries"]} bare />
      </Section>
      <Section id="pay" icon={Icons.salary} title="Pay, job type and age">
        <FieldForm kind="profile" only={["salary.min"]} bare />
        <FieldForm kind="search" only={["filters.salary_max"]} bare />
        <FieldForm kind="profile" only={["salary.currency", "salary.includes_super", "targets.job_types"]} bare />
        <FieldForm kind="search" only={["filters.posted_within_days", "filters.posted_this_week"]} bare />
      </Section>
      <Section id="skip" icon={Icons.sponsors} title={sponsor ? "Sponsorship and what to skip" : "What to skip"}>
        {sponsor ? <FieldForm kind="search" only={["filters.sponsor_only"]} bare /> : null}
        <FieldForm kind="profile" only={["skip_companies", "skip_big_tech"]} bare />
        <FieldForm kind="search" only={["filters.exclude_keywords"]} bare />
        <FieldForm kind="profile" only={["industries"]} bare />
      </Section>
      <Section id="breadth" icon={Icons.searches} title="How Claude searches">
        <FieldForm kind="search" only={["filters.breadth"]} choices={["filters.breadth"]} bare />
        <FieldForm kind="search" only={["filters.sort"]} choices={["filters.sort"]} bare />
        <FieldForm kind="search" only={["filters.experience", "filters.easy_apply", "filters.radius_km"]} bare />
        <FieldForm kind="search" only={["filters.max_jobs"]} bare />
      </Section>
      <Section id="plan" icon={Icons.calendar} title="Your search plan">
        <FieldForm kind="search" only={["search_deadline", "weekly_goal"]} bare />
      </Section>
    </div>
  );
}
