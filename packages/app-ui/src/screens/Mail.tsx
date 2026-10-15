import { useEffect, useState } from "react";
import { Button, Card, Checkbox, Dialog, Icons, Input, Pill, Select, Tabs, Text, type PillTone } from "@careeros/brand";
import type { DraftInput, DraftStatus, MailQuery, TriageItem } from "@careeros/contract";
import { useAction, useBridge, useLoad } from "../bridge-context";
import { DraftEditor } from "../components/DraftEditor";
import { formatWhen } from "../components/MailSetup";
import { ButtonWhy, MessageViewer, useJobTargets } from "../components/MessageViewer";
import { EmptyState, ErrorState, Loading, ScreenHead } from "../components/States";
import { bytes, fmtDateTime } from "../format";
import { navigate } from "../router";
import { ChipSelect, ToggleChip } from "../mail/FilterChips";
import { MailList } from "../mail/MailList";
import { MoreMenu, type MoreItem } from "../mail/MoreMenu";
import { RecheckDialog } from "../mail/Recheck";
import { useFillHeight } from "../mail/useFillHeight";

export const DRAFT_STATUS: Record<DraftStatus, [string, PillTone]> = {
  draft: ["Draft", "neutral"], waiting: ["Waiting for approval", "accent"], sent: ["Sent", "success"], failed: ["Failed", "danger"], unsure: ["Not sure it sent", "warning"],
};
const PRUNE_MONTHS = 6;

const PANE_KEY = "jobcairn.mail.pane";
function readPane(): boolean {
  try { return localStorage.getItem(PANE_KEY) === "right"; } catch { return false; }
}

/**
 * Job mail works like a mail client: the list fills the page, and opening an email gives it the whole page with a
 * Back button (Esc). "Reading pane" keeps the list on the left and the email on the right instead.
 */
function AllMail({ menu, onReading }: { menu: MoreItem[]; onReading: (reading: boolean) => void }) {
  const [text, setText] = useState("");
  const [company, setCompany] = useState("");
  const [job, setJob] = useState("");
  const [direction, setDirection] = useState("");
  const [unread, setUnread] = useState(false);
  const [attachments, setAttachments] = useState(false);
  const [open, setOpen] = useState("");
  const [pane, setPaneState] = useState(readPane);
  const [full, setFull] = useState(false);
  // Without the pane, an open email always reads full page; with it, only after "Read at full width".
  const reading = !!open && (!pane || full);
  const setPane = (on: boolean) => {
    setPaneState(on);
    setFull(false);
    try { localStorage.setItem(PANE_KEY, on ? "right" : "off"); } catch { /* private mode: the choice lasts this visit */ }
  };
  const back = () => { if (pane) setFull(false); else setOpen(""); };
  useEffect(() => { onReading(reading); }, [reading, onReading]);
  useEffect(() => () => onReading(false), [onReading]);
  useEffect(() => {
    if (!reading) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) back(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const [splitRef, height] = useFillHeight<HTMLDivElement>();
  const targets = useJobTargets();
  const q: MailQuery = {
    ...(text.trim() ? { text: text.trim() } : {}), ...(company ? { company_slug: company } : {}), ...(company && job ? { id: job } : {}),
    ...(direction ? { direction: direction as "in" | "out" } : {}), ...(unread ? { unread } : {}), ...(attachments ? { attachments } : {}),
  };
  const list = useLoad((b) => b.mail.list(q), [JSON.stringify(q)], ["mail"]);
  const companies = [...new Map(targets.map((t) => [t.company_slug, t.company_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const filtered = Object.keys(q).length > 0;
  const clear = () => { setText(""); setCompany(""); setJob(""); setDirection(""); setUnread(false); setAttachments(false); };
  return (
    <div className="mail-all">
      <div className="mail-toolbar" data-tour="mail-filters">
        <div className="mail-toolbar__search">
          <Input label="Search mail" hideLabel type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search subject, sender or company" />
        </div>
        <ChipSelect label="Company" value={company} onChange={(v) => { setCompany(v); setJob(""); }}
          options={[{ value: "", label: "All companies" }, ...companies.map(([value, label]) => ({ value, label }))]} />
        {company ? (
          <ChipSelect label="Job" value={job} onChange={setJob}
            options={[{ value: "", label: "All jobs" }, ...targets.filter((t) => t.company_slug === company).map((t) => ({ value: t.id, label: t.title }))]} />
        ) : null}
        <ChipSelect label="Direction" value={direction} onChange={setDirection}
          options={[{ value: "", label: "Received and sent" }, { value: "in", label: "Received" }, { value: "out", label: "Sent" }]} />
        <ToggleChip label="Unread only" pressed={unread} onChange={setUnread} />
        <ToggleChip label="Has attachments" pressed={attachments} onChange={setAttachments} />
        {filtered ? <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button> : null}
        <span className="grow" />
        <ToggleChip label="Reading pane" pressed={pane} onChange={setPane} />
      </div>
      <div className={`mail-split mail-split--fill${pane ? "" : " mail-split--nopane"}${reading ? " mail-split--reading" : ""}`} ref={splitRef} style={height ? { height } : undefined}>
        <div className="mail-split__list">
          {list.error && !list.data ? <ErrorState title="Mail can't load" text={list.error} /> : !list.data ? <Loading /> : list.data.rows.length === 0 ? (
            <EmptyState boxed text={filtered ? "No job mail matches." : "No job mail yet. Mail from companies you track shows up here after a sync."} />
          ) : (
            <MailList rows={list.data.rows} open={open} onOpen={setOpen} label="Job mail" tour="mail-list" />
          )}
        </div>
        <div className="mail-split__viewer" data-tour="mail-viewer">
          {open ? <MessageViewer key={open} mailRef={open} showMove fill menu={menu} onBack={reading ? back : undefined}
            onFull={pane && !reading ? () => setFull(true) : undefined} /> : (
            <div className="mail-split__empty"><EmptyState text={list.data?.rows.length ? "Choose an email to read it. Use the arrow keys or J and K to move through the list." : filtered ? "No email to show. Change or clear the filters." : "Nothing to read yet."} /></div>
          )}
        </div>
      </div>
    </div>
  );
}

function SortItem({ item }: { item: TriageItem }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const targets = useJobTargets();
  const suggested = item.suggestion ? targets.find((t) => t.company_slug === item.suggestion!.company_slug) : undefined;
  const [target, setTarget] = useState<string | null>(null);
  const [always, setAlways] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const value = target ?? (suggested ? `${suggested.company_slug}/${suggested.id}` : "");
  const [slug, id] = value.split("/");
  const subject = item.subject || "(no subject)";

  return (
    <Card className="stack" aria-label={subject}>
      <div className="row row--between row--top">
        <Text role="heading-2">{subject}</Text>
        <Text role="body-sm" muted>{fmtDateTime(item.date)}</Text>
      </div>
      <div className="mail-addr">
        {item.from.name ? <span className="mail-addr__name">{item.from.name}</span> : null}
        <span className="mail-addr__address">{item.from.address}</span>
      </div>
      <Text role="body-sm" muted>{item.suggestion ? item.suggestion.reason : "No company matched."}</Text>
      <div className="row mail-sort__assign">
        <Select label="File under" value={value} onChange={(e) => setTarget(e.target.value)}
          options={[{ value: "", label: "Choose a job" }, ...targets.map((t) => ({ value: `${t.company_slug}/${t.id}`, label: `${t.title} · ${t.company_name}` }))]} />
        <Checkbox label="Always match this sender" checked={always} onChange={(e) => setAlways(e.target.checked)} />
        <ButtonWhy variant="primary" why={!slug || !id ? "Choose a job first." : undefined} loading={busy === "assign"}
          onClick={() => void run("assign", () => bridge.mail.triage.assign(item.id, { company_slug: slug!, id: id! }, always), "Filed")}>Assign</ButtonWhy>
      </div>
      <div className="row">
        <Button variant="ghost" icon={Icons.add} title="New company and job" onClick={() => setCreating(true)}>New job</Button>
        <Button variant="ghost" loading={busy === "ignore-sender"} onClick={() => void run("ignore-sender", () => bridge.mail.triage.ignore(item.id, "sender"), "Sender ignored")}>Ignore sender</Button>
        <Button variant="ghost" loading={busy === "ignore-domain"} onClick={() => void run("ignore-domain", () => bridge.mail.triage.ignore(item.id, "domain"), "Domain ignored")}>Ignore domain</Button>
      </div>
      <Dialog open={creating} onClose={() => setCreating(false)} title="New company and job"
        actions={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
          <ButtonWhy variant="primary" why={!name.trim() || !title.trim() ? "Enter a company name and a job title." : undefined} loading={busy === "create"}
            onClick={() => void run("create", async () => { await bridge.mail.triage.createCompany(item.id, name.trim(), title.trim()); setCreating(false); }, "Company and job created")}>Create and file</ButtonWhy></>}>
        <div className="stack">
          <Input label="Company name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Job title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Text role="body-sm" muted>Mail from this sender is filed under the new company from now on.</Text>
        </div>
      </Dialog>
    </Card>
  );
}

function ToSort() {
  const items = useLoad((b) => b.mail.triage.list(), [], ["mail"]);
  if (items.error && !items.data) return <ErrorState title="Mail to sort can't load" text={items.error} />;
  if (!items.data) return <Loading />;
  if (!items.data.length) return <EmptyState boxed text="Nothing to sort." />;
  return (
    <div className="stack">
      <Text role="body-sm" muted>These look job-related but don't match a company yet. They're deleted after 30 days.</Text>
      {items.data.map((i) => <SortItem key={i.id} item={i} />)}
    </div>
  );
}

function Drafts() {
  const bridge = useBridge();
  const { run } = useAction();
  const drafts = useLoad((b) => b.mail.drafts.all(), [], ["mail", "approvals"]);
  // A company's own draft (a recruiter enquiry, no job) has no job page to open, so it is edited here.
  const [editing, setEditing] = useState<{ slug: string; draftId: string; initial: DraftInput; title: string } | null>(null);
  const edit = (slug: string, draftId: string, title: string) => run(`edit-${draftId}`, async () => {
    const d = await bridge.mail.drafts.get(slug, "", draftId);
    setEditing({ slug, draftId, initial: d.draft, title });
  });
  if (drafts.error && !drafts.data) return <ErrorState title="Drafts can't load" text={drafts.error} />;
  if (!drafts.data) return <Loading />;
  if (editing) {
    return (
      <div className="stack">
        <Text role="body-sm" muted>{`Email to ${editing.title}, kept with the company.`}</Text>
        <DraftEditor key={editing.draftId} slug={editing.slug} id="" draftId={editing.draftId} initial={editing.initial} files={[]} onClose={() => setEditing(null)} />
      </div>
    );
  }
  if (!drafts.data.length) return <EmptyState boxed text="No drafts. Write one from a job's Mail tab." />;
  return (
    <div className="stack">
      {drafts.data.map((d) => {
        const [label, tone] = DRAFT_STATUS[d.status] ?? ["Draft", "neutral"];
        const subject = d.subject || "(no subject)";
        return (
          <Card key={`${d.company_slug}/${d.id}/${d.draft_id}`} className="row row--between mail-draft" aria-label={subject}>
            <div className="stack-tight">
              <Text role="heading-2">{subject}</Text>
              <Text role="body-sm" muted>{d.id ? d.job_title : "General enquiry"} · {d.company_name}{d.to ? ` · to ${d.to}` : ""}</Text>
              {d.updated ? <Text role="body-sm" muted>Last changed {fmtDateTime(d.updated)}</Text> : null}
              {d.note ? <Text role="body-sm" className="field__error">{d.note}</Text> : null}
            </div>
            <div className="row">
              <Pill tone={tone}>{label}</Pill>
              {d.id ? <Button onClick={() => navigate({ screen: "job", slug: d.company_slug, id: d.id, tab: "mail" })}>Open</Button>
                : d.status === "draft" || d.status === "failed" ? <Button aria-label={`Edit ${subject}`} onClick={() => void edit(d.company_slug, d.draft_id, d.company_name)}>Edit</Button> : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export function MailScreen() {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const [tab, setTab] = useState("all");
  const [freeing, setFreeing] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  // While an email is open full page, the page title, tabs and filters step aside so the email gets the room.
  const [reading, setReading] = useState(false);
  const status = useLoad((b) => b.mail.status(), [], ["mail"]);
  const s = status.data;
  const raw = s?.raw_bytes ?? 0;
  const prune = () => run("prune", async () => {
    const r = await bridge.mail.prune(PRUNE_MONTHS);
    status.reload();
    setFreeing(false);
    return r;
  }, "Old originals removed");
  const recheck: MoreItem = { id: "recheck", label: "Re-check mail…", onSelect: () => setRechecking(true) };
  const free: MoreItem[] = raw > 0 ? [{ id: "free", label: "Free space…", onSelect: () => setFreeing(true) }] : [];
  if (status.error && !s) return <><ScreenHead title="Mail" /><ErrorState title="Mail can't load" text={status.error} /></>;
  if (!s) return <Loading />;
  // The example's mail is made up and stored with it: shown without Gmail, and nothing syncs or sends.
  const example = s.example === true;
  if ((!s.available || !s.connected) && !example) {
    return (
      <>
        <ScreenHead title="Mail" sub="Job emails, filed under each job." />
        <Card className="stack">
          <Text role="body">{s.available ? "Connect Gmail to see job emails here, filed under each job." : "Email isn't available in this version of the app."}</Text>
          {s.available ? <div><Button variant="primary" icon={Icons.mail} data-tour="mail-connect" onClick={() => navigate({ screen: "settings", tab: "connections" })}>Connect Gmail</Button></div> : null}
        </Card>
      </>
    );
  }
  const sub = example ? "Example mail. Gmail isn't connected here, so nothing syncs or sends."
    : s.syncing ? "Syncing now…" : `Last sync ${formatWhen(s.last_sync)}${s.next_sync ? ` · next ${formatWhen(s.next_sync)}` : ""}`;
  return (
    <div className={`mail-screen${reading && tab === "all" ? " mail-screen--reading" : ""}`}>
      <ScreenHead title="Mail" sub={sub}
        right={example ? undefined : <div className="row">
          <Button icon={Icons.redo} data-tour="mail-sync" loading={busy === "sync" || s.syncing} onClick={() => void run("sync", () => bridge.mail.syncNow(), "Mail synced")}>Sync now</Button>
          <MoreMenu label="More mail actions" size="md" items={[recheck, ...free, { id: "settings", label: "Email settings", onSelect: () => navigate({ screen: "settings", tab: "connections", c: "email" }) }]} />
        </div>} />
      {s.last_error ? <p role="alert" className="mail-warning">{s.last_error}</p> : null}
      <Tabs label="Mail sections" value={tab} onChange={setTab}
        tabs={[{ id: "all", label: "All job mail" }, { id: "sort", label: "Mail to sort", count: s.triage_count }, { id: "drafts", label: "Drafts" }]}>
        {tab === "all" ? <AllMail menu={[...free, recheck]} onReading={setReading} /> : null}
        {tab === "sort" ? <ToSort /> : null}
        {tab === "drafts" ? <Drafts /> : null}
      </Tabs>
      <RecheckDialog open={rechecking} onClose={() => setRechecking(false)} />
      <Dialog open={freeing} onClose={() => setFreeing(false)} title="Free up space"
        actions={<>
          <Button variant="ghost" onClick={() => setFreeing(false)}>Cancel</Button>
          <Button variant="primary" icon={Icons.remove} loading={busy === "prune"} onClick={() => void prune()}>Remove originals</Button>
        </>}>
        <Text role="body">Original emails use {bytes(raw)}. Removing originals older than {PRUNE_MONTHS} months keeps each email's text and any files you saved, but their exact formatting and unsaved attachments go.</Text>
      </Dialog>
    </div>
  );
}
