import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Card, Icons, Input, Pill, SectionTitle, Text, useToast, type PillTone } from "@careeros/brand";
import {
  EMPTY_OFFER, isActiveRun, negotiationNote, noteProblems, OFFER_SUPER_DEFAULT, OFFER_TEXT_MAX, offerOf, offerRanks, offerSuper, offerTotal,
  outputNames, type ActionTarget, type JobDetail, type JobRow, type OfferDetails,
} from "@careeros/contract";
import { errorText, useAction, useBridge, useLoad } from "../bridge-context";
import { useClaudeRun } from "../claude";
import { displayName } from "../components/displayName";
import { navigate } from "../router";
import "./extras.css";

/** What the person types for one offer. Money as typed ("$120,000", "120k"), super as a percentage ("11.5"). */
interface OfferForm { base: string; super: string; bonus: string; equity: string; work_mode: string; commute: string; start_date: string }

const key = (r: { company_slug: string; id: string }) => `${r.company_slug}/${r.id}`;
const aud = (n: number | null) => (n === null ? "–" : `$${Math.round(n).toLocaleString("en-AU")}`);
const pct = (rate: number) => `${+(rate * 100).toFixed(2)}%`;

/** "$120,000", "120k", "120000" as a number; "" as null; anything else undefined (not a number). */
export function parseMoney(s: string): number | null | undefined {
  const t = s.trim().replace(/[$,\s]/g, "").toLowerCase();
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
  return Number.isFinite(n) && n <= 100_000_000 ? Math.round(n) : undefined;
}
/** "11.5" or "11.5%" as 0.115; "" as null (the default rate); anything else undefined. */
export function parsePercent(s: string): number | null | undefined {
  const t = s.trim().replace(/%$/, "").trim();
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  const n = Number(t) / 100;
  return n <= 0.5 ? Math.round(n * 10_000) / 10_000 : undefined;
}

function formOf(o: OfferDetails, job: JobDetail["job"]): OfferForm {
  return {
    base: o.base === null ? "" : String(o.base), super: o.super_rate === null ? "" : String(+(o.super_rate * 100).toFixed(2)),
    bonus: o.bonus === null ? "" : String(o.bonus), equity: o.equity, work_mode: o.work_mode || job.work_mode, commute: o.commute, start_date: o.start_date,
  };
}
/** The form as offer details, or null with the fields that don't read. */
function detailsOf(f: OfferForm): { offer: OfferDetails | null; bad: (keyof OfferForm)[] } {
  const base = parseMoney(f.base);
  const bonus = parseMoney(f.bonus);
  const sup = parsePercent(f.super);
  const bad = ([["base", base], ["bonus", bonus], ["super", sup]] as const).filter(([, v]) => v === undefined).map(([k]) => k as keyof OfferForm);
  if (bad.length) return { offer: null, bad };
  return { offer: offerOf({ ...EMPTY_OFFER, base: base!, bonus: bonus!, super_rate: sup!, equity: f.equity.trim(), work_mode: f.work_mode.trim(), commute: f.commute.trim(), start_date: f.start_date }), bad };
}

const OPEN_KEY = "jobcairn.applications.compare";
function readOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === "open"; } catch { return false; }
}
/** The picker gets a search box once it lists this many jobs. */
const SEARCH_FROM = 9;
const STATUS_TONE: Record<string, PillTone> = { Offer: "success", Interview: "accent", Applied: "neutral" };

/**
 * Compare offers: one closed line on Applications ("2 offers", Compare) that opens to a list of the jobs at Offer,
 * Interview and Applied (offers first and ticked) and, with two or more ticked, a table of them side by side: base,
 * super, bonus, the yearly total, then equity, work mode, commute and start date. Open or closed is remembered.
 * Details are saved on each job. "Draft negotiation email" asks Claude for an email and saves it as a draft in the
 * job's Mail; nothing is ever sent from here.
 */
export function OfferComparison() {
  const list = useLoad((b) => b.jobs.list({ statuses: ["Offer", "Interview", "Applied"], showIneligible: true, limit: 200 }), [], ["jobs"]);
  const rows = useMemo(() => {
    const order = { Offer: 0, Interview: 1, Applied: 2 } as Record<string, number>;
    return [...(list.data?.rows ?? [])].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.last_activity.localeCompare(a.last_activity));
  }, [list.data]);
  const offers = rows.filter((r) => r.status === "Offer");
  const [open, setOpenState] = useState(readOpen);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [q, setQ] = useState("");
  const panelId = useId();
  const chosen = picked ?? offers.map(key);
  // Closed, nothing more is loaded: the card is one line.
  const selected = open ? rows.filter((r) => chosen.includes(key(r))) : [];
  const details = useLoad((b) => Promise.all(selected.map((r) => b.jobs.get(r.company_slug, r.id))), [selected.map(key).join("|")], ["jobs"]);
  if (!offers.length) return null;
  const setOpen = (on: boolean) => {
    setOpenState(on);
    try { localStorage.setItem(OPEN_KEY, on ? "open" : "closed"); } catch { /* private mode: the choice lasts this visit */ }
  };
  const toggle = (r: JobRow, on: boolean) => setPicked(on ? [...chosen, key(r)] : chosen.filter((k) => k !== key(r)));
  const label = (r: JobRow) => `${displayName(r.title)}, ${displayName(r.company_name)} (${r.status})`;
  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => label(r).toLowerCase().includes(needle)) : rows;
  const ticked = rows.filter((r) => chosen.includes(key(r))).length;
  const summary = `${offers.length} ${offers.length === 1 ? "offer" : "offers"} · ${ticked} ticked to compare`;
  return (
    <Card aria-label="Compare offers" className={open ? "offer-compare offer-compare--open" : "offer-compare"}>
      <div className="offer-compare__bar">
        <SectionTitle icon={Icons.compare} title="Compare offers" sub={summary} className="section-title--compact" />
        <Button size="sm" variant={open ? "ghost" : "secondary"} aria-expanded={open} aria-controls={open ? panelId : undefined}
          aria-label={open ? "Hide offer comparison" : "Show offer comparison"} onClick={() => setOpen(!open)}>{open ? "Hide" : "Compare"}</Button>
      </div>
      {open ? (
        <div id={panelId} className="offer-compare__body">
          <fieldset className="offer-pick">
            <legend className="offer-pick__legend">Jobs to compare</legend>
            {rows.length >= SEARCH_FROM ? (
              <Input label="Search jobs to compare" hideLabel type="search" placeholder="Search role or company" value={q} onChange={(e) => setQ(e.target.value)} />
            ) : null}
            {shown.length ? (
              <ul className="offer-pick__list">
                {shown.map((r) => (
                  <li key={key(r)}>
                    <label className="offer-pick__row">
                      <input type="checkbox" aria-label={label(r)} checked={chosen.includes(key(r))} onChange={(e) => toggle(r, e.target.checked)} />
                      <span className="offer-pick__text">
                        <span className="offer-pick__title">{displayName(r.title)}</span>
                        <span className="offer-pick__company">{displayName(r.company_name)}</span>
                      </span>
                      <Pill tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Pill>
                    </label>
                  </li>
                ))}
              </ul>
            ) : <Text role="body-sm" muted className="offer-pick__none">No jobs match.</Text>}
          </fieldset>
          <div className="offer-compare__main">
            <Text role="body-sm" muted>{`Total a year is base plus super (${pct(OFFER_SUPER_DEFAULT)} unless you change it) plus bonus. Equity isn't counted.`}</Text>
            {selected.length < 2 ? <Text role="body-sm" muted className="offer-compare__hint">Tick two or more jobs to compare them side by side.</Text>
              : details.data && details.data.length === selected.length ? <OfferTable jobs={details.data} />
                : details.error ? <Text role="body-sm" muted>{details.error}</Text> : <Text role="body-sm" muted>Loading offers…</Text>}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

const FIELDS: { k: keyof OfferForm; label: string; money?: boolean; hint?: string; type?: string }[] = [
  { k: "base", label: "Base", money: true, hint: "A year, without super" },
  { k: "super", label: "Super %", hint: `${+(OFFER_SUPER_DEFAULT * 100).toFixed(2)}` },
  { k: "bonus", label: "Bonus", money: true, hint: "A year" },
];
/** After the total: what the total doesn't count. */
const MORE_FIELDS: typeof FIELDS = [
  { k: "equity", label: "Equity", hint: "Shares or options" },
  { k: "work_mode", label: "Work mode", hint: "Hybrid, 3 days in" },
  { k: "commute", label: "Commute", hint: "40 min by train" },
  { k: "start_date", label: "Start date", type: "date" },
];

function OfferTable({ jobs }: { jobs: JobDetail[] }) {
  const bridge = useBridge();
  const { busy, run } = useAction();
  const [forms, setForms] = useState<Record<string, OfferForm>>({});
  const formFor = (d: JobDetail) => forms[key(d.job)] ?? formOf(offerOf(d.job.offer), d.job);
  const parsed = jobs.map((d) => detailsOf(formFor(d)));
  const ranks = offerRanks(parsed.map((p) => p.offer ?? EMPTY_OFFER));
  const set = (d: JobDetail, k: keyof OfferForm, v: string) => setForms((f) => ({ ...f, [key(d.job)]: { ...formFor(d), [k]: v } }));
  const name = (d: JobDetail) => `${displayName(d.job.title)}, ${displayName(d.company?.name ?? d.job.company_slug)}`;
  const save = (d: JobDetail, offer: OfferDetails) => run(`offer:${key(d.job)}`, () => bridge.jobs.setOffer(d.job.company_slug, d.job.id, offer), "Offer saved");
  const totals = parsed.map((p) => (p.offer ? offerTotal(p.offer) : null));
  // The column with the highest total, when there is one to point at.
  const best = (i: number) => ranks[i] === 1 && totals[i] !== null && jobs.length > 1;
  const cell = (i: number, extra?: string) => [best(i) ? "is-best" : "", extra ?? ""].filter(Boolean).join(" ") || undefined;
  const fieldRow = (f: (typeof FIELDS)[number]) => (
    <tr key={f.k}>
      <th scope="row">{f.label}</th>
      {jobs.map((d, i) => {
        const bad = parsed[i]!.bad.includes(f.k);
        const o = parsed[i]!.offer;
        return (
          <td key={key(d.job)} className={cell(i)}>
            <input className="input offer-table__input" aria-label={`${f.label}: ${name(d)}`} type={f.type ?? "text"} inputMode={f.money || f.k === "super" ? "decimal" : undefined}
              maxLength={OFFER_TEXT_MAX} placeholder={f.hint} value={formFor(d)[f.k]} aria-invalid={bad || undefined} onChange={(e) => set(d, f.k, e.target.value)} />
            {f.k === "super" && o?.base != null ? <span className="offer-table__note">{aud(offerSuper(o))} a year</span> : null}
          </td>
        );
      })}
    </tr>
  );
  return (
    <div className="offer-table__wrap">
      <table className="offer-table">
        <caption className="sr-only">Offers side by side</caption>
        <thead>
          <tr><td />{jobs.map((d, i) => (
            <th key={key(d.job)} scope="col" className={cell(i)}>
              <a href={`#/job/${d.job.company_slug}/${d.job.id}`} className="offer-table__job">{displayName(d.job.title)}</a>
              <span className="offer-table__company">{displayName(d.company?.name ?? d.job.company_slug)}</span>
              <Pill tone={STATUS_TONE[d.job.status] ?? "neutral"}>{d.job.status}</Pill>
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {FIELDS.map(fieldRow)}
          <tr className="offer-table__total">
            <th scope="row">Total a year</th>
            {jobs.map((d, i) => (
              <td key={key(d.job)} className={cell(i)}>
                <span className="offer-table__sum"><strong>{aud(totals[i]!)}</strong>{best(i) ? <Pill tone="success">Highest</Pill> : null}</span>
              </td>
            ))}
          </tr>
          {MORE_FIELDS.map(fieldRow)}
          <tr className="offer-table__actions-row">
            <th scope="row"><span className="sr-only">Actions</span></th>
            {jobs.map((d, i) => {
              const p = parsed[i]!;
              // Only real offers count as "another offer": a ticked-in interview is never claimed as one.
              const others = parsed.filter((_, j) => j !== i && jobs[j]!.job.status === "Offer").map((x) => x.offer).filter((x): x is OfferDetails => !!x);
              return (
                <td key={key(d.job)} className={cell(i)}>
                  <div className="offer-table__actions">
                    <Button size="sm" disabled={!p.offer} title={p.offer ? undefined : "Fix the amounts first: numbers like 120000 or 120k."} loading={busy === `offer:${key(d.job)}`}
                      aria-label={`Save offer: ${name(d)}`} onClick={() => p.offer && void save(d, p.offer)}>Save</Button>
                    <NegotiateButton d={d} offer={p.offer} others={others} label={name(d)} />
                  </div>
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function readPending(k: string): { runId: string; started: string } | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(k) ?? "null") as { runId?: unknown; started?: unknown } | null;
    return v && typeof v.runId === "string" && typeof v.started === "string" ? { runId: v.runId, started: v.started } : null;
  } catch { return null; }
}
function writePending(k: string, v: { runId: string; started: string } | null): void {
  try { if (v) sessionStorage.setItem(k, JSON.stringify(v)); else sessionStorage.removeItem(k); } catch { /* storage off: only this visit finishes it */ }
}

/**
 * "Draft negotiation email": saves the offer, runs Claude's email draft for this job (purpose "negotiate", numbers
 * only), then saves Claude's email as a draft in the job's Mail and opens it there. Never sent.
 */
function NegotiateButton({ d, offer, others, label }: { d: JobDetail; offer: OfferDetails | null; others: OfferDetails[]; label: string }) {
  const bridge = useBridge();
  const toast = useToast();
  const target = useMemo<ActionTarget>(() => ({ kind: "job", company_slug: d.job.company_slug, id: d.job.id }), [d.job.company_slug, d.job.id]);
  const c = useClaudeRun("draft_email", target);
  // The run this button started, kept for the session so the draft is still saved if you leave and come back.
  const pendingKey = `careeros.negotiate:${d.job.company_slug}/${d.job.id}`;
  const mine = useRef<{ runId: string; started: string } | null>(readPending(pendingKey));
  const [busy, setBusy] = useState(false);
  const run = c.run;

  useEffect(() => {
    const m = mine.current;
    if (!m || !run || run.id !== m.runId || isActiveRun(run.status)) return;
    mine.current = null;
    writePending(pendingKey, null);
    void (async () => {
      try {
        if (run.status !== "succeeded") throw new Error(run.status === "cancelled" ? "Cancelled." : run.error || "Claude didn't finish. Try again.");
        const a = await bridge.mail.drafts.assist(d.job.company_slug, d.job.id);
        if (!a.suggestion || Date.parse(a.suggestion.at) < Date.parse(m.started) - 1_000) throw new Error(a.problem || "Claude didn't write an email. Try again.");
        const to = a.recipient ? (a.recipient.name ? `${a.recipient.name} <${a.recipient.address}>` : a.recipient.address) : "";
        await bridge.mail.drafts.save(d.job.company_slug, d.job.id, "", { to, cc: "", subject: a.suggestion.subject, body: a.suggestion.body, attach: [], in_reply_to: "", references: [], purpose: "" });
        toast({ text: "Negotiation email saved as a draft in Mail. Check it before sending.", tone: "success" });
        navigate({ screen: "job", slug: d.job.company_slug, id: d.job.id, tab: "mail" });
      } catch (e) {
        toast({ text: errorText(e), tone: "danger" });
      } finally {
        setBusy(false);
      }
    })();
  }, [run, bridge, d.job.company_slug, d.job.id, toast, pendingKey]);

  const start = async () => {
    if (!offer || offer.base === null) return;
    setBusy(true);
    try {
      await bridge.jobs.setOffer(d.job.company_slug, d.job.id, offer);
      // Numbers only; fall back to the bare ask if the note somehow trips a rule.
      let note = negotiationNote(offer, others);
      if (noteProblems(note, outputNames("draft_email")).length) note = negotiationNote(offer, []);
      const r = await c.start({ options: { purpose: "negotiate", mode: "new" }, note });
      mine.current = { runId: r.id, started: r.started_at };
      writePending(pendingKey, mine.current);
    } catch (e) {
      setBusy(false);
      toast({ text: errorText(e), tone: "danger" });
    }
  };

  const engine = c.engine;
  const notReady = !!engine && !engine.ready;
  const active = !!run && isActiveRun(run.status);
  const why = d.job.status !== "Offer" ? "Only for a job at Offer." : !offer || offer.base === null ? "Enter the base pay first." : !engine ? "Checking whether Claude is set up…" : notReady ? "Claude Code needs a one-time setup first." : active ? "Claude is already working on this job." : undefined;
  return (
    <Button size="sm" variant="secondary" icon={Icons.ai} loading={busy} disabled={!!why} title={why ?? "Claude drafts it; you check and send it yourself"}
      aria-label={`Draft negotiation email: ${label}`} onClick={() => void start()}>Draft negotiation</Button>
  );
}
