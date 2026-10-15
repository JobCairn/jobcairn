import { useState } from "react";
import { Button, cx, Icons, Pill, Text, useToast } from "@careeros/brand";
import { isSafeHttpsUrl, type CompanyRow, type JobStatus, type MailRow } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { DateText } from "../components/DateText";
import { displayName } from "../components/displayName";
import { MessageViewer } from "../components/MessageViewer";
import { ScoreMeter } from "../components/ScoreMeter";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { plural, sponsorStatus } from "../format";
import { MailList } from "../mail/MailList";
import { useFillHeight } from "../mail/useFillHeight";
import { SPONSOR_REGIONS } from "../sponsors/region";
import "./companies.css";

/**
 * A company's mark: its initials on a tinted tile. Never a fetched logo: the app doesn't call out to the web
 * just to decorate a list. The tint is picked from the name, so a company keeps its colour everywhere.
 */
const TINTS = 6;
export function initialsOf(name: string): string {
  const words = displayName(name).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0]!.slice(0, 2) : `${words[0]![0]}${words[1]![0]}`).toUpperCase();
}
export function CompanyMark({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return <span className={cx("company-mark", `company-mark--${size}`, `company-mark--t${h % TINTS}`)} aria-hidden="true">{initialsOf(name)}</span>;
}

/** "2 open", "1 open of 3", "None". */
export const openJobsText = (r: Pick<CompanyRow, "jobs" | "open_jobs">) =>
  r.jobs === 0 ? "None" : r.open_jobs === r.jobs ? `${r.open_jobs} open` : r.open_jobs === 0 ? `${plural(r.jobs, "job")}, none open` : `${r.open_jobs} open of ${r.jobs}`;

/** The other statuses after the furthest one, for the Applications cell's tooltip: "Interview, 2 Found". */
export function statusesText(statuses: Partial<Record<JobStatus, number>>): string {
  return Object.entries(statuses).map(([s, n]) => (n === 1 ? s : `${n} ${s}`)).join(", ");
}

/** A plain https link opens in the browser; anything else is plain text and never actionable. */
export const openable = (url: string) => url.startsWith("https://") && isSafeHttpsUrl(url);
export const hostOf = (url: string) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } };

export function useOpenLink() {
  const bridge = useBridge();
  const toast = useToast();
  return (url: string, what: string) =>
    void bridge.links.open(url).catch((e: unknown) => toast({ tone: "danger", text: `Couldn't open ${what}: ${errorText(e)}` }));
}

const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Everything on file about whether this company sponsors. Shown only to people who need sponsorship. */
export function SponsorDetails({ c }: { c: CompanyRow }) {
  const open = useOpenLink();
  const s = c.sponsor;
  const newest = [...s.evidence].reverse();
  const st = sponsorStatus(s.status);
  return (
    <div className="company-sponsor">
      <dl className="company-facts">
        <div><dt>Status</dt><dd><Pill tone={st.tone}>{st.text}</Pill></dd></div>
        <div>
          <dt>Sponsor score</dt>
          <dd>
            <span className="score-line">
              <ScoreMeter value={s.score} tier={s.tier} reasons={s.reasons} />
              {s.tier ? <Text role="body-sm" muted as="span">{s.tier}</Text> : null}
            </span>
            {s.reasons.length ? <ul className="reasons" aria-label="Why this score">{s.reasons.map((x, i) => <li key={i}>{sentence(displayName(x))}</li>)}</ul> : null}
          </dd>
        </div>
        <div><dt>Last checked</dt><dd>{s.last_checked ? <DateText value={s.last_checked} hint /> : "Never"}</dd></div>
        {s.qld !== null ? <div><dt>{`Office in ${SPONSOR_REGIONS[0]!.name}`}</dt><dd>{s.qld ? "Yes" : "No"}</dd></div> : null}
        {s.ai_relevance ? <div><dt>AI relevance</dt><dd>{s.ai_relevance}</dd></div> : null}
      </dl>
      <section aria-label="Evidence" className="stack-tight">
        <h3 className="company-sub">Evidence, newest first</h3>
        {newest.length === 0 ? <Text role="body-sm" muted>No evidence recorded yet. Check again to ask Claude to look.</Text> : (
          <ol className="evidence">
            {newest.map((e, i) => (
              <li key={`${e.date}-${i}`} className="evidence__item">
                <DateText value={e.date} hint empty="Undated" />
                <Text role="body" className="evidence__note">{displayName(e.note || "No note")}</Text>
                {openable(e.url) ? (
                  <span><Button size="sm" variant="secondary" icon={Icons.openExternal} title={e.url} onClick={() => open(e.url, `the source for ${displayName(c.name)}`)}>{`Open ${hostOf(e.url)}`}</Button></span>
                ) : e.url ? <Text role="body-sm" muted className="evidence__url">{`Link not opened (not a plain https address): ${displayName(e.url)}`}</Text> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** Every email filed under this company (on a job or not), with the reader beside the list. */
export function CompanyMail({ slug }: { slug: string }) {
  const [open, setOpen] = useState("");
  const [splitRef, height] = useFillHeight<HTMLDivElement>();
  const list = useLoad((b) => b.mail.list({ company_slug: slug, limit: 200 }), [slug], ["mail"]);
  if (list.error && !list.data) return <ErrorState title="Mail can't load" text={list.error} />;
  if (!list.data) return <Loading />;
  if (list.data.rows.length === 0) return <EmptyState boxed text="No emails with this company yet. Emails about its jobs are filed here when mail syncs." />;
  const rows = [...list.data.rows].sort((a, b) => b.date.localeCompare(a.date));
  const tag = (r: MailRow) => (r.job_id ? { short: displayName(r.job_title || "A job"), full: `Filed on ${displayName(r.job_title || "a job")}` } : { short: "Company", full: "Company mail, not on a job" });
  return (
    <div className="mail-split mail-split--fill" ref={splitRef} style={height ? { height } : undefined}>
      <div className="mail-split__list"><MailList rows={rows} open={open} onOpen={setOpen} label="Emails" tagFor={tag} /></div>
      <div className="mail-split__viewer">
        {open ? <MessageViewer key={open} mailRef={open} showMove fill /> : (
          <div className="mail-split__empty"><EmptyState text="Choose an email to read it. Use the arrow keys or J and K to move through the list." /></div>
        )}
      </div>
    </div>
  );
}
