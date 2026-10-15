import { Text, type PillTone } from "@careeros/brand";
import type { SponsorshipFocus, WorkRightsLabel } from "@careeros/contract";
import { rightsTone } from "../candidate";
import { ExternalLink } from "../components/ExternalLink";
import { fmtDay, parseDay, relativeDay } from "./dates";
import { splitDate, splitQuote, splitUrls, type JdFact } from "./jd";

/** A date fact: "about 22 Dec 2025 · 3 weeks ago", the raw value in a tooltip. */
function DateValue({ value, now }: { value: string; now: Date }) {
  const { approx, iso, rest } = splitDate(value);
  const d = iso ? parseDay(iso) : null;
  if (!d) return <>{value}</>;
  return (
    <span title={value}>
      <time dateTime={iso!}>{approx ? "about " : ""}{fmtDay(d)}</time>
      <span className="t-muted"> · {relativeDay(d, now)}</span>
      {rest ? <span className="t-muted"> · {rest}</span> : null}
    </span>
  );
}

function LinkValue({ value }: { value: string }) {
  const { text, urls } = splitUrls(value);
  if (!urls.length) return <>{value}</>;
  return (
    <span className="key-facts__links">
      {urls.map((u) => <ExternalLink key={u} href={u}>{urls.length === 1 && text ? text : undefined}</ExternalLink>)}
      {urls.length > 1 && text ? <span className="t-muted">{text}</span> : null}
    </span>
  );
}

const DATE_KEYS = new Set(["fetched", "posted", "closes", "closing date"]);

/** Facts that only matter to someone who needs sponsorship ("Sponsorship: …", "Visa: …", "Sponsor score: …"). */
const SPONSOR_KEY = /\b(sponsor\w*|visa)\b/;

/**
 * The JD's metadata bullets as a label/value grid, with work rights called out. The callout takes
 * its tone from the job's structured work-rights label (`rights`), never from its own wording, so
 * "Citizens/PR only" can't sit in a green "good news" panel. For a candidate who doesn't need
 * sponsorship (`focus` "off") the sponsorship wording is left out.
 */
export function KeyFacts({ facts, rights, focus = "primary", now = new Date() }: {
  facts: JdFact[]; rights?: WorkRightsLabel; focus?: SponsorshipFocus; now?: Date;
}) {
  const shown = focus === "off" ? facts.filter((f) => !SPONSOR_KEY.test(f.key)) : facts;
  const fact = shown.find((f) => f.key === "work rights");
  const tone: PillTone | null = rights ? rightsTone(rights, focus) : "neutral";
  const callout = fact && tone ? fact : null;
  const rest = shown.filter((f) => f !== fact);
  const q = callout ? splitQuote(callout.value) : null;
  return (
    <section className="key-facts" aria-label="Key facts">
      <Text role="heading-2" as="h3" className="key-facts__title">Key facts</Text>
      {callout && q ? (
        <div className="key-facts__rights" data-tone={tone}>
          <Text role="body-sm" muted as="div">Work rights</Text>
          <Text role="body" className="t-strong" as="div">{q.summary || callout.value}</Text>
          {q.quote ? <blockquote className="key-facts__quote t-quote">“{q.quote}”</blockquote> : null}
        </div>
      ) : null}
      <dl className="key-facts__grid">
        {rest.map((f) => (
          <div key={f.key} className="key-facts__row">
            <dt>{f.label}</dt>
            <dd>{DATE_KEYS.has(f.key) ? <DateValue value={f.value} now={now} /> : <LinkValue value={f.value} />}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
