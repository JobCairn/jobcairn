import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Checkbox, Icon, Input, Mark, Pill, Text, PRODUCT_NAME, Icons, cx } from "@careeros/brand";
import { WR_STATUSES, type LegacyPreview, type RecentWorkspace, type ResumeFieldKey, type ResumeValues, type WorkRightsStatus } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { ResumePicker, type ResumePicked } from "../resumefill";
import { FIELD_WORD, listWords } from "../resumefill/ResumeReview";
import { errorSentence } from "../components/ErrorBanner";
import { WR_STATUS_TEXT } from "../format";
import { hasExample, hasFolderApi, hasSwitcher, openExample, recentWorkspaces, startWorkspace, suggestFolder, takeStartOwn, type FolderSuggestion } from "../onboarding/folder";
import { WorkspaceRow } from "../workspaces/ManageWorkspaces";
import { workspaceDetail } from "../workspaces/context";
import "../onboarding/onboarding.css";

/**
 * First run. A new person reaches Home in two clicks: "Get started" (the CareerOS folder goes in the home
 * folder, no picker), then "Done" on one page of optional details. Opening an existing folder, bringing in
 * old files and the made-up example are quieter options on the first page.
 */
/**
 * How Done makes the workspace. `start`: main makes the folder it suggested (no path is sent). `create`: the folder
 * the person picked. `new`: the switcher's "Start a new one" (main names the folder after the person).
 */
type Make = { kind: "start" } | { kind: "create"; dir: string } | { kind: "new" };
type Step =
  | { name: "start" }
  /** `make`: how the folder is made on Done. null: it already exists (after bringing in old files). */
  | { name: "details"; make: Make | null; display: string }
  | { name: "legacy"; src: string; dest: string; preview: LegacyPreview };

// Only these work-rights statuses have a visa that can expire.
const VISA_STATUSES: WorkRightsStatus[] = WR_STATUSES.filter((s) => s === "full_visa" || s === "limited_visa" || s === "needs_sponsorship");
const needsVisaExpiry = (s: WorkRightsStatus) => (VISA_STATUSES as string[]).includes(s);
// "Prefer not to say" first: it's the default, and nobody has to answer.
const RIGHTS_ORDER: WorkRightsStatus[] = ["unknown", "citizen", "pr", "full_visa", "limited_visa", "needs_sponsorship"];

const CAN_DO: ["jobs" | "apply" | "learn" | "privacy", string, string][] = [
  ["jobs", "Find jobs that fit", "Keep job ads in one list and see how well each one matches you."],
  ["apply", "Tailor each application", "Adjust your resume for a job, then track where each application is up to."],
  ["learn", "Prepare for interviews", "Study guides and practice questions based on the jobs you save."],
  ["privacy", "Keep it private", "Everything stays in one folder on this computer. Nothing is sent anywhere unless you say so."],
];

export function OnboardingScreen({ onCreated, onDone, mode = "first", onCancel }: {
  onCreated: () => void; onDone: () => void;
  /** "new": the switcher's "Start a new one", straight to the details page, with Cancel back to the open workspace. */
  mode?: "first" | "new"; onCancel?: () => void;
}) {
  const bridge = useBridge();
  const isNew = mode === "new";
  const [step, setStep] = useState<Step>(isNew ? { name: "details", make: { kind: "new" }, display: "" } : { name: "start" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<FolderSuggestion | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [initialName, setInitialName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [roles, setRoles] = useState("");
  const [status, setStatus] = useState<WorkRightsStatus>("unknown");
  const [expiry, setExpiry] = useState("");
  // "Fill from my resume": what was found, which extra fields to save, and the name before "Use resume value".
  const [resume, setResume] = useState<ResumePicked | null>(null);
  const [extras, setExtras] = useState<Partial<Record<ResumeFieldKey, boolean>>>({});
  const [nameBefore, setNameBefore] = useState<string | null>(null);
  const folderApi = hasFolderApi(bridge);
  const example = hasExample(bridge);
  // Workspaces this computer already has (first run only): the welcome screen leads with the best one.
  const [recent, setRecent] = useState<RecentWorkspace[]>([]);
  const [recentSeq, setRecentSeq] = useState(0);
  // Until the list is in, neither Get started nor Continue shows: a click must never pick the wrong one.
  const listsWorkspaces = !isNew && hasSwitcher(bridge);
  const [recentLoaded, setRecentLoaded] = useState(!listsWorkspaces);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(false);

  /** Runs one onboarding action. A failure stays on screen in plain words, not in a toast that disappears. */
  const act = async (key: string, fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(`${errorSentence(e instanceof Error ? e.message : String(e))}.`); } finally { busyRef.current = false; setBusy(null); }
  };

  useEffect(() => {
    // A new workspace is often for someone else: no suggested folder or account name.
    if (isNew) return undefined;
    let live = true;
    void suggestFolder(bridge).then((s) => {
      if (!live || !s) return;
      setSuggestion(s);
      if (s.name) { setName(s.name); setInitialName(s.name); }
    }).catch(() => undefined);
    return () => { live = false; };
  }, [bridge, isNew]);

  useEffect(() => {
    if (isNew || !hasSwitcher(bridge)) return undefined;
    let live = true;
    void recentWorkspaces(bridge).then((rows) => { if (live) setRecent(rows); }).catch(() => undefined).finally(() => { if (live) setRecentLoaded(true); });
    return () => { live = false; };
  }, [bridge, isNew, recentSeq]);

  const getStarted = () => act("start", async () => {
    if (chosen) { setStep({ name: "details", make: { kind: "create", dir: chosen }, display: chosen }); return; }
    if (folderApi) {
      // Main picks the folder: the renderer only shows where (suggest) and never sends that path back.
      const s = suggestion ?? (await suggestFolder(bridge));
      if (s?.existing) { await startWorkspace(bridge); onDone(); return; }
      setStep({ name: "details", make: { kind: "start" }, display: s?.display ?? "" });
      return;
    }
    // A bridge without the folder calls: the person picks the folder.
    const dir = await bridge.workspace.pickFolder("create");
    if (dir) setStep({ name: "details", make: { kind: "create", dir }, display: dir });
  });

  // "Start my own" on the example banner lands here and carries straight on.
  useEffect(() => { if (takeStartOwn()) void getStarted(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const change = () => act("change", async () => {
    const dir = await bridge.workspace.pickFolder("create");
    if (dir) setChosen(dir);
  });

  const openExisting = () => act("open", async () => {
    const dir = await bridge.workspace.pickFolder("open");
    if (!dir) return;
    await bridge.workspace.open(dir);
    onDone();
  });

  const continueWith = (r: RecentWorkspace) => act("continue", async () => {
    await bridge.workspace.switchTo(r.key);
    onDone();
  });
  // An explicit choice: a new workspace, in a new folder named after the person (never the existing one).
  const startNewSpace = () => { setError(null); setStep({ name: "details", make: { kind: "new" }, display: "" }); };

  const explore = () => act("example", async () => {
    await openExample(bridge);
    onDone();
  });

  const startLegacy = () => act("legacy", async () => {
    const src = await bridge.workspace.pickFolder("legacy");
    if (!src) return;
    // Where to copy them: a folder the person picks (the suggested path is never sent back from here).
    const dest = chosen ?? (await bridge.workspace.pickFolder("create"));
    if (!dest) return;
    setStep({ name: "legacy", src, dest, preview: await bridge.workspace.previewLegacy(src, dest) });
  });

  const doImport = (src: string, dest: string) => act("import", async () => {
    onCreated();
    await bridge.workspace.importLegacy(src, dest);
    const ws = await bridge.workspace.current();
    const imported = ws?.name ?? "";
    setName(imported); setInitialName(imported);
    setStep({ name: "details", make: null, display: "" });
  });

  const resumeName = resume?.read.fields.name ?? "";
  const nameFromResume = !!resumeName && name.trim() === resumeName;
  const onResume = (p: ResumePicked) => {
    setResume(p);
    const f = p.read.fields;
    setExtras({ email: !!f.email, phone: !!f.phone, city: !!f.city, links: f.links.length > 0 });
    setNameBefore(null);
    // A name the person typed is never replaced silently; the suggested account name, or an empty box, is.
    if (f.name && (!name.trim() || name === initialName)) setName(f.name);
  };
  const resumeValues = (): { values: ResumeValues; overwrite: ResumeFieldKey[] } => {
    const f = resume!.read.fields;
    const values: ResumeValues = {};
    const overwrite: ResumeFieldKey[] = [];
    if (nameFromResume) { values.name = resumeName; overwrite.push("name"); }
    if (extras.email && f.email) values.email = f.email;
    if (extras.phone && f.phone) values.phone = f.phone;
    if (extras.city && f.city) values.city = f.city;
    if (extras.links && f.links.length) values.links = f.links;
    return { values, overwrite };
  };

  const finish = (e?: FormEvent) => {
    e?.preventDefault();
    if (step.name !== "details") return;
    const make = step.make;
    // An older bridge needs a name to make the folder; the current one makes it without.
    if (make?.kind === "create" && !folderApi && !name.trim()) { setNameError("Add your name. It's needed to set up your folder."); return; }
    setNameError(null);
    void act("done", async () => {
      if (make) onCreated();
      if (make?.kind === "start") await startWorkspace(bridge);
      else if (make?.kind === "create") await bridge.workspace.create(make.dir, name.trim());
      else if (make?.kind === "new") await bridge.workspace.startNew(name.trim());
      if (resume) {
        // The folder exists now: copy the resume in and fill the empty contact fields. Filled fields are kept.
        const { values, overwrite } = resumeValues();
        try {
          await bridge.profile.fillFromResume(resume.path, values, overwrite);
        } catch (err) {
          setResume(null);
          setStep({ name: "details", make: null, display: "" });
          throw new Error(`Your folder is ready, but your resume couldn't be saved: ${errorText(err).replace(/\.$/, "")}. Click Done to carry on without it`);
        }
      }
      const changes: { path: string; value: unknown }[] = [];
      // "start" makes the folder with no name yet; brought-in files keep their name unless it was changed here.
      const named = make?.kind === "start" ? !!name.trim() : !make && !!name.trim() && name.trim() !== initialName.trim();
      if (named) changes.push({ path: "contact.name", value: name.trim() });
      // "Prefer not to say" is the default: leaving it saves nothing, so it never overwrites brought-in answers.
      if (status !== "unknown") {
        changes.push({ path: "work_rights.status", value: status });
        if (needsVisaExpiry(status) && expiry) changes.push({ path: "work_rights.visa_expiry", value: expiry });
      }
      const list = roles.split(",").map((r) => r.trim()).filter(Boolean);
      if (list.length) changes.push({ path: "targets.roles", value: list });
      if (changes.length) await bridge.settings.save("profile", changes);
      onDone();
    });
  };

  const back = () => {
    setError(null); setNameError(null);
    if (isNew) { onCancel?.(); return; }
    setStep({ name: "start" });
  };
  // Esc steps back from the details page (before the folder exists) and from the import check.
  useEffect(() => {
    const canBack = (step.name === "details" && step.make !== null) || step.name === "legacy";
    if (!canBack) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busyRef.current && !e.defaultPrevented) back(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);
  // A page change moves focus to its heading; the details page starts in its first field instead.
  const shown = useRef(step.name);
  useEffect(() => {
    if (shown.current === step.name) return;
    shown.current = step.name;
    if (step.name !== "details") headingRef.current?.focus();
  }, [step.name]);

  const errorBox = error ? <p className="onboard__error" role="alert">{error}</p> : null;

  if (step.name === "details") {
    return (
      <main className="onboarding app__main">
        <form className="onboard onboard--narrow" onSubmit={finish} noValidate aria-labelledby="details-title">
          <div className="onboard__head">
            <h1 className="t-display" id="details-title">{step.make?.kind === "new" ? "Start a new workspace" : "A few details"}</h1>
            <Text role="body" muted>
              {step.make?.kind === "new" && !isNew
                ? "A separate workspace in a new folder, for another person or a separate job search. Your other workspaces stay as they are. Every question is optional."
                : step.make?.kind === "new"
                ? "For another person on this computer, or a separate job search. The workspace that's open now stays as it is. Every question is optional."
                : "Every question is optional. You can change your answers later in Settings."}
            </Text>
          </div>
          {resume ? null : (
            <ResumePicker compact tour="onboard-resume-fill" heading="Have your resume handy?" onPicked={onResume} disabled={!!busy}
              disabledReason="Wait for the current step to finish." />
          )}
          <div className="rfill-field">
            <Input label="What's your name?" value={name} autoFocus autoComplete="name" error={nameError ?? undefined}
              onChange={(e) => { setName(e.target.value); setNameError(null); setNameBefore(null); }} />
            {nameFromResume && nameBefore === null ? <span className="rfill-field__tag"><Pill tone="accent">From your resume</Pill></span> : null}
          </div>
          {resumeName && name.trim() !== resumeName && nameBefore === null && name.trim() ? (
            <Checkbox label={`Use resume value: ${resumeName}`} checked={false} onChange={() => { setNameBefore(name); setName(resumeName); }} />
          ) : null}
          {nameBefore !== null ? (
            <Checkbox label={`Use resume value: ${resumeName}`} checked onChange={() => { setName(nameBefore); setNameBefore(null); }} />
          ) : null}
          {resume ? <ResumeExtras picked={resume} extras={extras} setExtras={setExtras} onChange={() => setResume(null)} disabled={!!busy} /> : null}
          <Input label="What jobs are you looking for?" value={roles} onChange={(e) => setRoles(e.target.value)}
            help="For example: Data analyst, Project manager. Separate jobs with commas." />
          <fieldset className="onboard__rights">
            <legend className="onboard__legend">Your right to work</legend>
            <span id="rights-help" className="field__help">Used to hide ads you can't apply for, and to point out ads that offer visa sponsorship.</span>
            <div className="choice-group" role="radiogroup" aria-label="Your right to work" aria-describedby="rights-help">
              {RIGHTS_ORDER.map((s) => (
                <label key={s} className={cx("choice", status === s && "is-on")}>
                  <input type="radio" className="sr-only" name="work-rights" value={s} checked={status === s} onChange={() => setStatus(s)} />
                  <span>{WR_STATUS_TEXT[s]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {needsVisaExpiry(status) ? (
            <Input label="When does your visa end?" type="date" className="input--date" value={expiry} onChange={(e) => setExpiry(e.target.value)}
              help="Optional. Leave it empty if you're not sure." />
          ) : null}
          {errorBox}
          <div className="onboard__actions">
            <Button type="submit" variant="primary" loading={busy === "done"}>Done</Button>
            {step.make !== null ? <Button variant="ghost" onClick={back} disabled={!!busy}>{isNew ? "Cancel" : "Back"}</Button> : null}
            {step.make?.kind === "new" ? (
              <Text role="body-sm" muted as="span" className="onboard__where onboard__where--end">Saved in a new folder in your home folder</Text>
            ) : step.make !== null && step.display ? (
              <Text role="body-sm" muted as="span" className="onboard__where onboard__where--end">
                Saving to <span className="onboard__path" title={step.display}>{step.display}</span>
              </Text>
            ) : null}
          </div>
        </form>
      </main>
    );
  }

  if (step.name === "legacy") {
    const issues = step.preview.issues.length;
    return (
      <main className="onboarding app__main">
        <section className="onboard onboard--narrow" aria-labelledby="legacy-title">
          <div className="onboard__head">
            <h1 className="t-display" id="legacy-title" tabIndex={-1} ref={headingRef}>Check what will be copied</h1>
            <Text role="body" muted>Nothing has been copied yet. Your old folder stays exactly as it is.</Text>
          </div>
          <ul className="list-plain onboard__moves">
            {step.preview.actions.map((a) => (
              <li key={`${a.from}->${a.to}`} className="onboard__move">
                <span className="onboard__path" title={a.from}>{a.from}</span>
                <Icon icon={Icons.next} size="sm" className="onboard__arrow" />
                <span className="onboard__path" title={a.to}>{a.to}</span>
              </li>
            ))}
          </ul>
          {step.preview.unmapped.length ? (
            <div className="stack">
              <h2 className="t-heading-2 onboard__sub">Left where it is</h2>
              <ul className="list-plain">{step.preview.unmapped.map((u) => <li key={u} className="onboard__path">{u}</li>)}</ul>
            </div>
          ) : null}
          {issues ? <Text role="body-sm" muted>{issues === 1 ? "1 file can't be read, so it will be skipped." : `${issues} files can't be read, so they will be skipped.`}</Text> : null}
          {errorBox}
          <div className="onboard__actions">
            <Button variant="primary" loading={busy === "import"} onClick={() => void doImport(step.src, step.dest)}>Copy files</Button>
            <Button variant="ghost" onClick={back} disabled={!!busy}>Cancel</Button>
          </div>
        </section>
      </main>
    );
  }

  const where = chosen ?? suggestion?.display ?? null;
  const opensExisting = !!suggestion?.existing && !chosen;
  // Real workspaces already on this computer (never the example). The lead one has the person's files in it, if any
  // does; otherwise the most recent. "Get started" then becomes an explicit "Start a new workspace".
  const known = recent.filter((r) => !r.isSample && !r.current);
  const lead = known.find((r) => r.available && !r.empty) ?? known.find((r) => r.available) ?? null;
  const listed = known.filter((r) => r !== lead);
  const missing = known.some((r) => r.problem === "missing");
  const notWorkspace = known.some((r) => r.problem === "not_workspace");
  const leadName = lead ? (lead.name.trim() ? `${lead.name.trim()}'s workspace` : lead.folder) : "";
  const rowAct = (fn: () => Promise<void>) => act("row", fn);
  return (
    <main className="onboarding app__main">
      <div className="onboard onboard--split">
        <section className="onboard__main" aria-labelledby="welcome-title">
          <Mark size={40} />
          <div className="onboard__head">
            <h1 className="t-display" id="welcome-title" tabIndex={-1} ref={headingRef}>{lead ? "Welcome back" : `Welcome to ${PRODUCT_NAME}`}</h1>
            <Text role="body" muted className="onboard__lede">Run your job search from one place: find jobs, tailor your resume and keep track of every application.</Text>
            {/* New people only: what it needs and how long, before they commit to anything. */}
            {lead ? null : (
              <Text role="body-sm" muted className="onboard__lede">
                You&apos;ll need your Claude plan (Claude Code does the work) and Google Chrome, for searching job boards. Setup takes about 15 minutes, and a checklist on Home walks you through it.
              </Text>
            )}
          </div>
          {!recentLoaded ? (
            <div className="onboard__primary onboard__primary--waiting" aria-busy="true" />
          ) : lead ? (
            <div className="onboard__primary">
              <Button variant="primary" className="onboard__go" loading={busy === "continue"} disabled={!!busy && busy !== "continue"} onClick={() => void continueWith(lead)}
                data-tour="onboard-continue">
                Continue with {leadName}
              </Button>
              {/* Where it is (with the parent folder when two would read the same), how much is in it, when it was made. */}
              <Text role="body-sm" muted as="p" className="onboard__where">{workspaceDetail(lead)}</Text>
            </div>
          ) : (
            <div className="onboard__primary">
              <Button variant="primary" className="onboard__go" loading={busy === "start"} disabled={!!busy && busy !== "start"} onClick={() => void getStarted()}>
                {opensExisting ? "Open folder" : "Get started"}
              </Button>
              <Text role="body-sm" muted as="p" className="onboard__where">
                {where
                  ? opensExisting
                    ? <>Your folder is already set up at <span className="onboard__path" title={where}>{where}</span>.</>
                    : <>Your files will be kept in <span className="onboard__path" title={where}>{where}</span> on this computer.</>
                  : <>Next, you choose a folder on this computer to keep your files in.</>}
                {where ? <>{" "}<button type="button" className="onboard__link" onClick={() => void change()} disabled={!!busy}>Change</button></> : null}
              </Text>
            </div>
          )}
          {listed.length ? (
            <section className="onboard__known" aria-labelledby="known-title">
              <h2 className="onboard__known-title" id="known-title">{lead ? "Your other workspaces" : "Your workspaces"}</h2>
              {missing ? <Text role="body-sm" muted as="p">A folder you used before can't be found. It may have been moved or renamed. Locate it, or remove it from the list. Nothing is made in its place.</Text> : null}
              {notWorkspace && !missing ? <Text role="body-sm" muted as="p">A folder you used before isn't a workspace any more. Remove it from the list. Its files aren't touched.</Text> : null}
              <ul className="list-plain ws-manage">
                {listed.map((r) => <WorkspaceRow key={r.key} r={r} busy={!!busy} act={rowAct} onChanged={() => setRecentSeq((n) => n + 1)} onOpen={(x) => void continueWith(x)} canTrash={false} rows={known} />)}
              </ul>
            </section>
          ) : null}
          {errorBox}
          <ul className="onboard__others" aria-label="Other ways to start">
            {lead ? (
              <li>
                <button type="button" className="onboard__other" onClick={startNewSpace} disabled={!!busy}>
                  <span className="onboard__other-title">New workspace</span>
                  <span className="onboard__other-text">A separate one in a new folder, for someone else or a fresh job search. {leadName} stays as it is.</span>
                </button>
              </li>
            ) : null}
            {example ? (
              <li>
                <button type="button" className="onboard__other" onClick={() => void explore()} disabled={!!busy}>
                  <span className="onboard__other-title">{busy === "example" ? "Opening…" : "Try example"}</span>
                  <span className="onboard__other-text">See how it works with a made-up job search. Your own files aren't touched.</span>
                </button>
              </li>
            ) : null}
            <li>
              <button type="button" className="onboard__other" onClick={() => void openExisting()} disabled={!!busy}>
                <span className="onboard__other-title">{busy === "open" ? "Opening…" : "Open existing"}</span>
                <span className="onboard__other-text">Open the {PRODUCT_NAME} folder you set up before.</span>
              </button>
            </li>
            <li>
              <button type="button" className="onboard__other" onClick={() => void startLegacy()} disabled={!!busy}>
                <span className="onboard__other-title">{busy === "legacy" ? "Reading…" : "Import files"}</span>
                <span className="onboard__other-text">Copies resumes, job ads and notes from a folder you already have. The originals aren't changed.</span>
              </button>
            </li>
          </ul>
        </section>
        <aside className="onboard__aside" aria-labelledby="can-do-title">
          <h2 className="t-heading-2 onboard__sub" id="can-do-title">What you can do here</h2>
          <ul className="onboard__can-do">
            {CAN_DO.map(([icon, title, text]) => (
              <li key={title}>
                <span className="onboard__can-do-icon"><Icon icon={Icons[icon]} /></span>
                <span className="onboard__can-do-body"><span className="onboard__can-do-title">{title}</span><span className="onboard__can-do-text">{text}</span></span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}

const EXTRA_KEYS: Exclude<ResumeFieldKey, "name">[] = ["email", "phone", "city", "links"];
const EXTRA_LABEL: Record<Exclude<ResumeFieldKey, "name">, string> = { email: "Email", phone: "Phone", city: "City", links: "Links" };

/** The other contact details found in the resume, each ticked to save with Done. Empty fields only are filled. */
function ResumeExtras({ picked, extras, setExtras, onChange, disabled }: {
  picked: ResumePicked;
  extras: Partial<Record<ResumeFieldKey, boolean>>;
  setExtras: (fn: (x: Partial<Record<ResumeFieldKey, boolean>>) => Partial<Record<ResumeFieldKey, boolean>>) => void;
  onChange: () => void;
  disabled: boolean;
}) {
  const f = picked.read.fields;
  const found = EXTRA_KEYS.filter((k) => (k === "links" ? f.links.length > 0 : !!f[k]));
  const missing = [...(f.name ? [] : ["name" as const]), ...EXTRA_KEYS.filter((k) => !found.includes(k))].map((k) => FIELD_WORD[k]);
  return (
    <section className="rfill-extra" aria-label="Also from your resume">
      <div className="rfill-extra__head">
        <Text role="body-sm" as="p">
          {found.length ? "Also from " : "Read "}<span className="rfill-file" title={picked.read.file}>{picked.read.file}</span>
          {found.length ? ". Saved to your profile when you click Done:" : ". No other contact details were found."}
        </Text>
        <button type="button" className="onboard__link" onClick={onChange} disabled={disabled}>Change resume</button>
      </div>
      {found.map((k) => (
        <Checkbox key={k} label={`${EXTRA_LABEL[k]}: ${k === "links" ? f.links.join(", ") : f[k]}`} checked={!!extras[k]}
          onChange={(e) => setExtras((x) => ({ ...x, [k]: e.target.checked }))} />
      ))}
      {missing.length ? <Text role="body-sm" muted as="p">Not in your resume: {listWords(missing)}. You can add {missing.length === 1 ? "it" : "them"} later in Settings.</Text> : null}
      <Text role="body-sm" muted as="p">A copy of your resume is kept in your new workspace's Resumes folder, so tailoring and scoring can use it.</Text>
    </section>
  );
}
