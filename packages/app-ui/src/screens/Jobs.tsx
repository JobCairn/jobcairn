import { useCallback, useEffect, useRef, useState } from "react";
import { ChromeRunStrip } from "../chrome";
import { Button, Checkbox, cx, Dialog, Input, Select, Table, Text, type Column, SectionTitle, Icons } from "@careeros/brand";
import { JOB_STATUSES, postedAgoText, postedDateOf, WR_LABELS, WR_LABEL_TEXT, type JobRow, type SponsorshipFocus } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { newRows, newestFound, readSeen, writeSeen } from "../jobs/seen";
import { useWorkspaceKey } from "../workspaces/useWorkspaceKey";
import { displayName } from "../components/displayName";
import { ActionButton, WORKSPACE } from "../components/ActionButton";
import { ErrorState, ScreenHead } from "../components/States";
import { DateText } from "../components/DateText";
import { rightsTone } from "../candidate";
import { navigate, toHash, type Route } from "../router";
import { routePage, writePage } from "../components/listPage";
import { listAllJobs } from "../jobs/list-all";
import { EMPTY_FORM, activeFilters, formFromParams, formFromQuery, paramsFromForm, queryFromForm, readKept, writeKept, type JobsForm } from "../jobs/filters";
import { JobQuickFilters } from "../jobs/QuickFilters";
import { SourceBadge } from "../source/SourceBadge";
import { useSponsorshipFocus } from "../useSponsorshipFocus";
import { FitCell, RightsCell, SponsorCell, StatusCell } from "../jobs/cells/cells";
import { fitView, sponsorView } from "../jobs/cells/meta";
import { AddJobDialog } from "../addjob/AddJobDialog";
import { GhostPills } from "../jobs/GhostPills";
import { FreshBadge } from "../jobs/FreshBadge";
import { useDelete } from "../trash";

export type { JobsForm } from "../jobs/filters";
export { queryFromForm } from "../jobs/filters";

const roleText = (r: JobRow) => `${r.title}, ${r.client ? `${r.company_name} (client ${r.client})` : r.company_name}`;
// The source badge sits before the title (no separate Source column); its tooltip says "Found on LinkedIn".
const ROLE_COL: Column<JobRow> = {
  key: "role", header: "Role", minWidth: "16rem", text: roleText, sortValue: (r) => r.title, wrap: true, alwaysOn: true,
  render: (r) => (
    <div className="role-cell">
      <SourceBadge job={r} size="sm" className="role-cell__source" />
      <div className="role-cell__text"><Text role="body" as="div" className="role-title">{r.title}</Text><Text role="body-sm" muted truncate as="div">{r.client ? `${r.company_name} · client ${r.client}` : r.company_name}</Text><FreshBadge row={r} /><GhostPills ghost={r.ghost} /></div>
    </div>
  ),
};
// The pill follows the candidate (rightsTone): sponsorship wording is hidden when it isn't relevant to them, and
// "Citizens/PR only" only reads as a warning for a candidate it could actually exclude.
const rightsCol = (focus: SponsorshipFocus): Column<JobRow> => ({
  key: "rights", header: "Work rights", width: "7.5rem", hideWhenEmpty: true, isEmpty: (r) => !rightsTone(r.wr_label, focus),
  text: (r) => (rightsTone(r.wr_label, focus) ? WR_LABEL_TEXT[r.wr_label] : ""), sortValue: (r) => WR_LABELS.indexOf(r.wr_label),
  render: (r) => <RightsCell label={r.wr_label} focus={focus} />,
});
/** Work-rights filter choices: someone who doesn't need sponsorship only sees the labels that can affect them. */
const rightsOptions = (focus: SponsorshipFocus) => WR_LABELS.filter((l) => rightsTone(l, focus) !== null);
const WHERE_COL: Column<JobRow> = {
  key: "where", header: "Location", width: "10.5rem", priority: "low", text: (r) => [r.location, r.work_mode].filter(Boolean).join(" · "),
  render: (r) => <Text role="body-sm" truncate>{[r.location, r.work_mode].filter(Boolean).join(" · ")}</Text>,
};
const SALARY_COL: Column<JobRow> = {
  key: "salary", header: "Salary", width: "10rem", text: (r) => r.salary_text || "Not stated", sortValue: (r) => r.salary_max ?? r.salary_min ?? null, firstSort: "desc",
  render: (r) => <Text role="body-sm" truncate muted={!r.salary_text}>{r.salary_text || "Not stated"}</Text>,
};
/** One click: opens the job's Score tab and starts scoring there. */
const scoreJob = (r: JobRow) => navigate({ screen: "job", slug: r.company_slug, id: r.id, tab: "score", start: true });
const FIT_COL: Column<JobRow> = {
  key: "fit", header: "Fit", align: "center", width: "5.5rem", hideWhenEmpty: true, isEmpty: (r) => r.fit === null, sortValue: (r) => r.fit, firstSort: "desc",
  text: (r) => fitView(r.fit)?.label ?? "Not scored", render: (r) => <FitCell fit={r.fit} name={roleText(r)} onScore={() => scoreJob(r)} />,
};
const SPONSOR_COL: Column<JobRow> = {
  key: "sponsor", header: "Sponsor", width: "8rem", hideWhenEmpty: true, isEmpty: (r) => r.sponsor === null && r.wr_label !== "sponsorship_offered",
  sortValue: (r) => r.sponsor, firstSort: "desc", text: (r) => { const v = sponsorView(r.sponsor, r.wr_label); return v.value === null ? v.word : `${v.word}, ${v.value} of 100`; },
  render: (r) => <SponsorCell score={r.sponsor} label={r.wr_label} reasons={r.sponsor_reasons} />,
};
const POSTED_COL: Column<JobRow> = {
  key: "posted", header: "Posted", width: "9rem", priority: "low", firstSort: "desc",
  sortValue: (r) => postedDateOf(r).slice(0, 10) || null, text: (r) => postedAgoText(r, new Date()),
  render: (r) => <span className="posted-ago" data-unknown={postedDateOf(r) ? undefined : true} title={r.posted_approx ? "Worked out from what the board said, like \"3d ago\"" : undefined}>{postedAgoText(r, new Date()).replace(/^Posted /, "").replace(/^date unknown$/, "Unknown")}</span>,
};
const FOUND_COL: Column<JobRow> = { key: "found", header: "Found", width: "7rem", priority: "low", sortValue: (r) => r.found_at, firstSort: "desc", render: (r) => <DateText value={r.found_at} empty="Unknown" /> };
const STATUS_COL: Column<JobRow> = { key: "status", header: "Status", width: "6.5rem", text: (r) => r.status, sortValue: (r) => JOB_STATUSES.indexOf(r.status), render: (r) => <StatusCell status={r.status} /> };

/** The sponsor-score column only exists for a candidate sponsorship is relevant to (showSponsorship). */
function jobColumns(focus: SponsorshipFocus, showSponsorship: boolean, onDelete?: (r: JobRow) => void): Column<JobRow>[] {
  return [ROLE_COL, rightsCol(focus), WHERE_COL, SALARY_COL, FIT_COL, ...(showSponsorship ? [SPONSOR_COL] : []), POSTED_COL, FOUND_COL, onDelete ? withDelete(onDelete) : STATUS_COL];
}

/**
 * The row's Delete: a quiet icon button at the row's end, shown on hover or keyboard focus. It sits over the Status
 * cell instead of taking a column of its own, so a 1440 window doesn't scroll sideways for it. Opens the confirm.
 */
const withDelete = (onDelete: (r: JobRow) => void): Column<JobRow> => ({
  ...STATUS_COL,
  render: (r) => (
    <>
      {STATUS_COL.render(r)}
      <Button size="sm" variant="ghost" icon={Icons.trash} className="row-delete row-delete--overlay" aria-label={`Delete job: ${r.title}`} title="Delete job" onClick={() => onDelete(r)} />
    </>
  ),
});

/** Apply with nothing in progress: offer the same jobs Home's "Next up" does (found or saved, best match first), each with Prepare. */
function ReadyToPrepare() {
  const { focus } = useSponsorshipFocus();
  const saved = useLoad((b) => b.jobs.list({ statuses: ["Found", "Saved"], limit: 5 }), [], ["jobs"]);
  if (!saved.data?.rows.length) return <Text role="body-sm" muted>Find or save a job first, then prepare it here.</Text>;
  const cols: Column<JobRow>[] = [
    ROLE_COL, rightsCol(focus),
    { key: "prepare", header: "", width: "8rem", align: "end", sortable: false, inDetail: false,
      render: (r) => <Button size="sm" variant="primary" onClick={() => navigate({ screen: "apply", slug: r.company_slug, id: r.id })}>Prepare</Button> },
  ];
  return (
    <section className="stack ready-to-prepare" aria-label="Ready to prepare">
      <SectionTitle icon={Icons.apply} title="Ready to prepare" />
      <Table caption="Ready to prepare" columns={cols} rows={saved.data.rows} rowKey={(r) => `${r.company_slug}/${r.id}`} itemLabel="job"
        onRowActivate={(r) => navigate({ screen: "job", slug: r.company_slug, id: r.id })} />
    </section>
  );
}

export function JobsScreen({ route }: { route: Route }) {
  const bridge = useBridge();
  const del = useDelete();
  const { busy, run } = useAction();
  const { focus, showSponsorship, prioritiseSponsorship } = useSponsorshipFocus();
  const routeStatus = route.screen === "jobs" ? route.status : undefined;
  // Home's sponsorship mix links here with a work-rights label (Lane C hook).
  const routeLabel = route.screen === "jobs" ? route.label : undefined;
  const routeFilters = route.screen === "jobs" ? route.filters : undefined;
  const isApply = routeStatus === "Applying";
  const view = isApply ? "apply" : "jobs";
  /** The list as the address states it, or null when the address says nothing beyond the screen. */
  const fromRoute = (): JobsForm | null => {
    if (routeFilters) return formFromParams(new URLSearchParams(routeFilters));
    if (!routeStatus && !routeLabel) return null;
    return { ...EMPTY_FORM, filters: { ...EMPTY_FORM.filters, statuses: routeStatus ? [routeStatus] : [], labels: routeLabel ? [routeLabel] : [] }, showIneligible: !!routeLabel };
  };
  // The address wins (Back from a job, Home's links); else the list as you last left it in this workspace.
  const workspace = useWorkspaceKey();
  const [form, setFormState] = useState<JobsForm>(() => fromRoute() ?? EMPTY_FORM);
  const restored = useRef(!!fromRoute());
  useEffect(() => {
    if (restored.current || !workspace) return;
    restored.current = true;
    const kept = readKept(workspace, view);
    if (kept) setFormState(kept);
  }, [workspace, view]);
  const setForm = useCallback((fn: JobsForm | ((f: JobsForm) => JobsForm)) => setFormState((cur) => (typeof fn === "function" ? fn(cur) : fn)), []);
  // Every change goes into the address (replacing it, so Back skips filter steps) and into this workspace's memory.
  useEffect(() => {
    if (workspace && restored.current && !isApply) writeKept(workspace, view, form);
    if (isApply) return;
    const params = paramsFromForm(form).toString();
    // Keep the page the list is on (the table moves it back to 1 itself when the filters change).
    const page = routePage();
    const hash = toHash({ screen: "jobs", ...(params ? { filters: params } : {}), ...(page ? { page } : {}) });
    if (window.location.hash !== hash && window.location.hash.startsWith("#/jobs")) window.history.replaceState(window.history.state, "", hash);
  }, [form, workspace, view, isApply]);
  const [viewName, setViewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  // The dialog has two steps: editing the name, then (only if that name collides with an
  // existing saved view) confirming the overwrite. `confirmReplace` is reset whenever the
  // dialog opens or closes, so it never leaks into the next save attempt.
  const [confirmReplace, setConfirmReplace] = useState(false);
  // A new link from elsewhere (Home's "3 follow-ups due") replaces the list's state; our own address writes don't.
  const routeSeen = useRef(`${routeStatus}|${routeLabel}|${routeFilters}`);
  useEffect(() => {
    const key = `${routeStatus}|${routeLabel}|${routeFilters}`;
    if (routeSeen.current === key) return;
    routeSeen.current = key;
    const next = fromRoute();
    if (next && routeFilters !== paramsFromForm(form).toString()) { restored.current = true; setFormState(next); }
  }, [routeStatus, routeLabel, routeFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = queryFromForm(isApply ? { ...form, filters: { ...form.filters, statuses: ["Applying"] } } : form);
  const list = useLoad((b) => listAllJobs(b, query), [JSON.stringify(query)], ["jobs", "settings"]);
  const routePageNo = route.screen === "jobs" ? route.page : undefined;
  const views = useLoad((b) => b.jobs.views(), [], ["jobs"]);
  // "12 new": found since you last left Jobs. The baseline is read once per visit and moved on when you leave.
  const [seenUpTo, setSeenUpTo] = useState<string | null | undefined>(undefined);
  const [onlyNew, setOnlyNew] = useState(false);
  useEffect(() => { if (workspace) setSeenUpTo(readSeen(workspace)); }, [workspace]);
  const newestRef = useRef("");
  useEffect(() => { const n = newestFound(list.data?.rows ?? []); if (n > newestRef.current) newestRef.current = n; }, [list.data]);
  useEffect(() => () => { if (workspace) writeSeen(workspace, newestRef.current); }, [workspace]);
  const fresh = list.data ? newRows(list.data.rows, seenUpTo ?? null) : [];
  const shownRows = list.data ? (onlyNew && fresh.length ? fresh : list.data.rows) : [];
  const set = <K extends keyof JobsForm>(k: K, v: JobsForm[K]) => { setViewName(""); setForm((f) => ({ ...f, [k]: v })); };

  const applyView = (name: string) => {
    setViewName(name);
    const v = views.data?.find((x) => x.name === name);
    if (v) setForm(formFromQuery(v.query));
  };
  const trimmedName = newName.trim();
  // jobs.saveView replaces any view with the same name (see services/read.ts, an exact,
  // case-sensitive match on the trimmed name) - so that's the rule used here to decide
  // whether a save needs confirming first.
  const duplicateView = views.data?.find((v) => v.name === trimmedName);
  const closeSaveDialog = () => { setSaving(false); setConfirmReplace(false); };
  const saveView = () => run("save-view", async () => {
    await bridge.jobs.saveView(trimmedName, query);
    setSaving(false);
    setConfirmReplace(false);
    setViewName(trimmedName);
    setNewName("");
    views.reload();
  }, "View saved");
  const requestSave = () => { if (duplicateView) setConfirmReplace(true); else void saveView(); };
  const deleteView = () => run("delete-view", async () => { await bridge.jobs.deleteView(viewName); setViewName(""); views.reload(); });

  const hidden = list.data?.hiddenIneligible ?? 0;
  // The Apply view always lists jobs being applied for; its other filters still work.
  const filtersOn = !!(form.text.trim() || form.hideStale || activeFilters({ ...form.filters, statuses: isApply ? [] : form.filters.statuses }));
  const clearFilters = () => { setViewName(""); setForm((f) => ({ ...f, text: "", filters: EMPTY_FORM.filters })); };
  // The count says why the number differs from Home and the rail: ads hidden for work rights, or filters.
  const countLine = list.data ? [
    `${list.data.total} shown`,
    hidden && !form.showIneligible ? `${hidden} hidden because ${hidden === 1 ? "it needs" : "they need"} work rights you don't have` : "",
    filtersOn ? "filters are on" : "",
  ].filter(Boolean).join(" · ") : undefined;
  const filters = (
      <div className="jobs-filters">
        <div className="jobs-filters__row">
          <Input label="Search jobs" hideLabel data-tour="jobs-search" className="jobs-filters__search" value={form.text} onChange={(e) => set("text", e.target.value)} placeholder="Search title, company or place" />
          <Select label="Sort by" hideLabel value={form.sort} onChange={(e) => set("sort", e.target.value as JobsForm["sort"])}
            options={[{ value: "default", label: "Sort: best match" }, { value: "fit", label: "Sort: fit" }, ...(showSponsorship ? [{ value: "sponsor", label: "Sort: sponsor score" }] : []), { value: "newest", label: "Sort: newest found" }, { value: "fresh", label: "Sort: newest posted" }]} />
          {views.data?.length ? (
            <Select label="Saved view" hideLabel value={viewName} onChange={(e) => applyView(e.target.value)}
              options={[{ value: "", label: "Saved views" }, ...views.data.map((v) => ({ value: v.name, label: v.name }))]} />
          ) : null}
          <div className="jobs-filters__views">
            <Button size="sm" data-tour="jobs-save-view" onClick={() => { setConfirmReplace(false); setSaving(true); }}>Save view</Button>
            {viewName ? <Button size="sm" variant="ghost" onClick={() => void deleteView()}>Delete view</Button> : null}
          </div>
        </div>
        {views.error ? <Text role="body-sm" muted>Saved views can't be loaded right now.</Text> : null}
        <JobQuickFilters filters={form.filters} onChange={(f) => set("filters", f)} facets={list.data?.facets} showSponsorship={showSponsorship}
          rights={rightsOptions(focus)} hideStatus={isApply} searching={!!form.text.trim()} onClearAll={clearFilters} />
        <div className="jobs-filters__toggles">
          {/* Only offered when something is actually hidden (or it's already on, so it can be turned off). */}
          {hidden || form.showIneligible ? (
            <Checkbox data-tour="jobs-hidden" label={`Show ads I can't apply for (${hidden} hidden)`} checked={form.showIneligible} onChange={(e) => set("showIneligible", e.target.checked)} />
          ) : null}
          <Checkbox label="Hide likely stale" checked={!!form.hideStale} onChange={(e) => set("hideStale", e.target.checked)}
            title="Hides ads you haven't applied for that were posted over 30 days ago, or posted again by the same company" />
        </div>
      </div>
  );
  return (
    <>
      <ScreenHead title={isApply ? "Apply" : "Jobs"} sub={isApply ? "Jobs you're applying for. Open one to prepare and send your application." : "Every job Claude found or you added. Select a row to open it."}
        right={<div className="row">
          <Button icon={Icons.add} data-tour="jobs-add" onClick={() => setAdding(true)}>Add job</Button>
          <ActionButton action="find_jobs" target={WORKSPACE} variant="primary" />
        </div>} settings={isApply ? undefined : "jobs"} />
      <AddJobDialog open={adding} onClose={() => setAdding(false)} />
      {del.element}
      <ChromeRunStrip />
      {list.error ? <ErrorState title="Jobs can't load" text={list.error} /> : null}
      {/* The table is there while the list loads too, so the filters never jump. */}
      {list.data || !list.error ? (
        <Table caption="Jobs" id="jobs" columns={jobColumns(focus, showSponsorship, (r) => del.ask([{ kind: "job", company_slug: r.company_slug, id: r.id }], { label: "Delete job" }))} rows={shownRows} rowKey={(r) => `${r.company_slug}/${r.id}`}
          filters={filters} resetKey={`${JSON.stringify(query)}|${onlyNew}`} page={routePageNo} onPageChange={writePage}
          toolbar={countLine || fresh.length ? (
            <>
              {fresh.length ? (
                <button type="button" className="filter-chip filter-chip--new" aria-pressed={onlyNew} onClick={() => setOnlyNew((v) => !v)}
                  title={onlyNew ? "Show every job again" : "Show only the jobs found since you last looked"}>{fresh.length} new</button>
              ) : null}
              <Text role="body-sm" muted as="span">{countLine}</Text>
              {list.data?.rows.length && list.data.rows.every((r) => r.fit === null) ? <span className="hint-chip" title="Fit shows once Claude scores a job. Open a job and use Score this job.">Score jobs to see fit</span> : null}
            </>
          ) : undefined}
          rowClassName={(r) => cx("has-row-actions", prioritiseSponsorship && r.pinned ? "is-pinned" : !r.eligible ? "is-ineligible" : undefined)}
          onRowActivate={(r) => navigate({ screen: "job", slug: r.company_slug, id: r.id })} itemLabel="job"
          emptyText={!list.data ? "Loading jobs…" : isApply ? "Nothing is being applied for yet." : filtersOn || hidden ? "No jobs match these filters." : "No jobs yet. Use Find jobs and Claude searches the job sites for you, or Add job to paste a link."} />
      ) : filters}
      {isApply && list.data && list.data.rows.length === 0 && !filtersOn ? <ReadyToPrepare /> : null}

      <Dialog open={saving} onClose={closeSaveDialog} title={confirmReplace ? "Replace this view?" : "Save this view"}
        actions={confirmReplace ? (
          <>
            <Button variant="ghost" onClick={() => setConfirmReplace(false)}>Back</Button>
            <Button variant="primary" loading={busy === "save-view"} onClick={() => void saveView()}>Replace</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={closeSaveDialog}>Cancel</Button>
            <Button variant="primary" disabled={!trimmedName} loading={busy === "save-view"} onClick={requestSave}>Save</Button>
          </>
        )}>
        {confirmReplace ? (
          <Text role="body" truncate>{`A view called "${displayName(trimmedName)}" already exists. Replace it?`}</Text>
        ) : (
          <Input label="View name" value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} />
        )}
      </Dialog>
    </>
  );
}
